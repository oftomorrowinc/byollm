import {
  PROTOCOL_VERSION,
  SiteToolCalls,
  TOOL_LIMITS,
  TOOLS_SPENT_MESSAGE,
  ToolCallResponse,
  ToolResultsResponse,
  type Capability,
  type SealedEnvelope,
} from "@byollm/protocol";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memory.js";
import {
  createHarness,
  httpCapabilities,
  type PairedRunner,
} from "./testing.js";

/**
 * The direct lane's four tool endpoints — byollm_012 §5.2 (#6933, card 2).
 *
 * The daemon's two are HTTP endpoints on `ByollmHandlers`; the site's two are
 * `ByollmApp.calls` and `ByollmApp.toolResult`, because on this lane the site
 * is the upstream. One shape on both lanes, so the upstream halves of C037
 * and C041 are asserted here as they are in the relay's
 * `test/tool-calls.test.ts`.
 *
 * The store is blind on this lane too — it keeps envelopes it never opens —
 * so the envelopes here are opaque stand-ins, distinct per message.
 */

const tools: Capability = {
  ...httpCapabilities()[1]!,
  kind: "llm.tools",
};

const sealedAs = (
  label: string,
  direction: "tool-call" | "tool-result",
): SealedEnvelope => ({
  ciphertext: Buffer.from(label).toString("base64url"),
  recipientKeyId: "recipient",
  senderKeyId: "sender",
  direction,
  deadlineAt: 4_102_444_800_000,
});

let calls = 0;
const newCallId = (): string => {
  calls += 1;
  return `call_${String(calls).padStart(16, "0")}`;
};

const toolsPayload = {
  messages: [{ role: "user" as const, content: "Is the moon made of cheese?" }],
  tools: [
    {
      name: "web_search",
      description: "Search the web for a claim",
      parameters: {
        type: "object" as const,
        properties: { query: { type: "string" as const, maxLength: 400 } },
        required: ["query"],
      },
    },
  ],
  purposeLimits: { maxToolCalls: 8, maxToolResultChars: 32_000 },
};

async function world(options: { leaseMs?: number } = {}) {
  const h = createHarness(options);
  const runner = await h.pair({ capabilities: [tools, ...httpCapabilities()] });

  const running = async (kind: "llm.tools" | "llm.chat" = "llm.tools") => {
    const handle = await h.app.enqueue(
      kind === "llm.tools"
        ? { kind, payload: toolsPayload, owner: "alice" }
        : {
            kind,
            payload: { messages: toolsPayload.messages },
            owner: "alice",
          },
    );
    const claimed = await h.call(
      "claim",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: runner.runnerId,
        capabilities: [tools, ...httpCapabilities()],
        max: 8,
      },
      runner,
    );
    const job = (
      claimed.body as { jobs: { id: string; lease: { id: string } }[] }
    ).jobs.find((it) => it.id === handle.id);
    if (!job) throw new Error(`${handle.id} was not claimed`);
    return { jobId: job.id, leaseId: job.lease.id };
  };

  const toolCall = (
    job: { jobId: string; leaseId: string },
    callId: string,
    envelope: SealedEnvelope,
    by: PairedRunner = runner,
  ) =>
    h.call(
      "tool-call",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: by.runnerId,
        ...job,
        callId,
        envelope,
      },
      by,
    );

  const call = async (job: { jobId: string; leaseId: string }) => {
    const callId = newCallId();
    const answer = await toolCall(job, callId, sealedAs(callId, "tool-call"));
    expect(answer.status).toBe(200);
    expect(ToolCallResponse.parse(answer.body).callId).toBe(callId);
    return callId;
  };

  const toolResults = async (
    named: { jobId: string; leaseId: string; callId: string }[],
    by: PairedRunner = runner,
  ) => {
    const answer = await h.call(
      "tool-results",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: by.runnerId,
        calls: named,
      },
      by,
    );
    expect(answer.status).toBe(200);
    return ToolResultsResponse.parse(answer.body).results;
  };

  const heartbeat = async (leases: { jobId: string; leaseId: string }[]) => {
    const beat = await h.call(
      "heartbeat",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: runner.runnerId,
        daemonVersion: "0.1.5",
        capabilities: [tools],
        activeLeases: leases,
      },
      runner,
    );
    expect(beat.status).toBe(200);
    return beat.body as { lost: unknown[] };
  };

  return { h, runner, running, toolCall, call, toolResults, heartbeat };
}

describe("a tool call on the direct lane", () => {
  it("travels device → server → site and back, through one store", async () => {
    const w = await world();
    const job = await w.running();
    const callId = await w.call(job);

    const listed = SiteToolCalls.parse(await w.h.app.calls()).calls;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ ...job, callId });
    // The device the site verifies the call against and seals its answer to.
    const runner = await w.h.store.getRunner(w.runner.runnerId);
    expect(listed[0]?.device).toEqual(runner?.device);

    const answer = sealedAs(`${callId}:answer`, "tool-result");
    expect(
      await w.h.app.toolResult({ jobId: job.jobId, callId, envelope: answer }),
    ).toEqual({ accepted: true });
    expect((await w.h.app.calls()).calls).toEqual([]);
    expect(await w.toolResults([{ ...job, callId }])).toEqual([
      { ...job, callId, envelope: answer },
    ]);
  });

  it("refuses a call on a job without tools, and from a runner without the lease", async () => {
    const w = await world();
    const chat = await w.running("llm.chat");
    const callId = newCallId();
    expect(
      (await w.toolCall(chat, callId, sealedAs(callId, "tool-call"))).status,
    ).toBe(400);

    const job = await w.running();
    const other = await w.h.pair({ owner: "alice", label: "other" });
    expect(
      (await w.toolCall(job, callId, sealedAs(callId, "tool-call"), other))
        .status,
    ).toBe(404);
  });

  it("holds a job to the protocol ceiling, and counts a replay once", async () => {
    const w = await world();
    const job = await w.running();
    const first = newCallId();
    const envelope = sealedAs(first, "tool-call");
    expect((await w.toolCall(job, first, envelope)).status).toBe(200);
    expect((await w.toolCall(job, first, envelope)).status).toBe(200);
    expect(
      (await w.toolCall(job, first, sealedAs("other", "tool-call"))).status,
    ).toBe(400);
    for (let n = 2; n <= TOOL_LIMITS.maxToolCalls; n += 1) await w.call(job);
    const extra = newCallId();
    const refused = await w.toolCall(job, extra, sealedAs(extra, "tool-call"));
    expect(refused.status).toBe(403);
    // The pair the daemon reads as the job's tools spent (§8), as the
    // relay serves it: the two planes say one thing.
    expect(refused.body).toEqual({
      error: "forbidden",
      message: TOOLS_SPENT_MESSAGE,
    });
  });

  it("refuses the site's calls and toolResult on the cloud lane, rather than answering empty", async () => {
    const w = await world();
    // Same store, cloud-lane app: the relay holds the calls there.
    const { ByollmApp } = await import("./app.js");
    const { generateSiteKeys } = await import("./keys.js");
    const cloud = new ByollmApp({
      store: new MemoryStore(),
      siteKeys: generateSiteKeys(),
      lane: {
        relayOrigin: "https://relay.test",
        siteId: "site_x",
        fetch: () => Promise.reject(new Error("not reached")),
      },
    });
    await expect(cloud.calls()).rejects.toThrow(/cloud lane/);
    expect(w.h.app.cloud).toBeUndefined();
  });
});

describe("C037 a result is bound to its call — the server's half", () => {
  /**
   * The direct lane's half of byollm_012 §12 row 5, as the relay's file has
   * it: an unknown call id, another job's call, a second answer to an
   * answered call, and a call of a job or a grant that has ended — each
   * refused, and none of them reaching any holder's `tool-results`.
   *
   * Mutation (MUTATIONS.md): drop the `row.callId === callId` match in
   * `MemoryStore.#currentCall`.
   */
  it("refuses an unknown call id and another job's call", async () => {
    const w = await world();
    const a = await w.running();
    const b = await w.running();
    const callA = await w.call(a);
    const callB = await w.call(b);
    const answer = sealedAs("answer", "tool-result");

    expect(
      await w.h.app.toolResult({
        jobId: a.jobId,
        callId: newCallId(),
        envelope: answer,
      }),
    ).toEqual({ refused: "not-found" });
    expect(
      await w.h.app.toolResult({
        jobId: a.jobId,
        callId: callB,
        envelope: answer,
      }),
    ).toEqual({ refused: "not-found" });
    expect((await w.h.app.calls()).calls.map((c) => c.callId).sort()).toEqual(
      [callA, callB].sort(),
    );
    expect(
      await w.toolResults([
        { ...a, callId: callA },
        { ...a, callId: callB },
        { ...b, callId: callB },
      ]),
    ).toEqual([]);
  });

  it("keeps the first answer to a call and refuses a different second one", async () => {
    const w = await world();
    const job = await w.running();
    const callId = await w.call(job);
    const first = sealedAs("first", "tool-result");
    expect(
      await w.h.app.toolResult({ jobId: job.jobId, callId, envelope: first }),
    ).toEqual({ accepted: true });
    expect(
      await w.h.app.toolResult({ jobId: job.jobId, callId, envelope: first }),
    ).toEqual({ accepted: true });
    expect(
      await w.h.app.toolResult({
        jobId: job.jobId,
        callId,
        envelope: sealedAs("second", "tool-result"),
      }),
    ).toEqual({ refused: "too-late" });
    expect((await w.toolResults([{ ...job, callId }]))[0]?.envelope).toEqual(
      first,
    );
  });

  it("gives job A's answer to A's holder only", async () => {
    const w = await world();
    const a = await w.running();
    const b = await w.running();
    const callId = await w.call(a);
    await w.h.app.toolResult({
      jobId: a.jobId,
      callId,
      envelope: sealedAs("a", "tool-result"),
    });
    expect(await w.toolResults([{ ...b, callId }])).toEqual([]);
    expect(
      await w.toolResults([{ jobId: a.jobId, leaseId: b.leaseId, callId }]),
    ).toEqual([]);
    const stranger = await w.h.pair({ owner: "alice", label: "stranger" });
    expect(await w.toolResults([{ ...a, callId }], stranger)).toEqual([]);
    expect(await w.toolResults([{ ...a, callId }])).toHaveLength(1);
  });

  it("deletes a job's calls with the job, so nothing lands after it ends", async () => {
    const w = await world();
    const job = await w.running();
    const callId = await w.call(job);
    expect(w.h.store.heldToolCalls(job.jobId)).toBe(1);
    const done = await w.h.call(
      "result",
      await w.h.resultBody({
        jobId: job.jobId,
        runner: w.runner,
        outcome: { outcome: "ok", text: "answered from memory" },
        leaseId: job.leaseId,
        tools: {
          toolCalls: 1,
          toolOutcomes: { answered: 0, errored: 0, timedOut: 1, refused: 0 },
        },
      }),
      w.runner,
    );
    expect(done.status).toBe(200);
    expect(
      await w.h.app.toolResult({
        jobId: job.jobId,
        callId,
        envelope: sealedAs("late", "tool-result"),
      }),
    ).toEqual({ refused: "not-found" });
    expect(await w.toolResults([{ ...job, callId }])).toEqual([]);
    expect((await w.h.app.calls()).calls).toEqual([]);
    // Unreachable is not deleted: every read above filters on the lease, so
    // it would pass with the rows still held. This is the delete itself.
    expect(w.h.store.heldToolCalls(job.jobId)).toBe(0);
  });

  it("treats a call id as single-use for the job, across grants", async () => {
    // As the SQL's primary key (job, call) has it, so the two stores agree.
    const w = await world({ leaseMs: 30_000 });
    const job = await w.running();
    const callId = await w.call(job);
    w.h.clock.advance(30_001);
    await w.h.app.sweep();
    const claimed = await w.h.call(
      "claim",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: w.runner.runnerId,
        capabilities: [tools],
        max: 8,
      },
      w.runner,
    );
    const lease = (
      claimed.body as { jobs: { id: string; lease: { id: string } }[] }
    ).jobs.find((it) => it.id === job.jobId)?.lease.id;
    expect(lease).toBeDefined();
    expect(lease).not.toBe(job.leaseId);
    const again = { jobId: job.jobId, leaseId: lease! };
    expect(
      (await w.toolCall(again, callId, sealedAs(callId, "tool-call"))).status,
    ).toBe(400);
  });

  it("takes a grant's calls out of reach when the grant lapses", async () => {
    const w = await world({ leaseMs: 30_000 });
    const job = await w.running();
    const callId = await w.call(job);
    w.h.clock.advance(30_001);
    await w.h.app.sweep();
    expect(
      await w.h.app.toolResult({
        jobId: job.jobId,
        callId,
        envelope: sealedAs("late", "tool-result"),
      }),
    ).toEqual({ refused: "not-found" });
    expect((await w.h.app.calls()).calls).toEqual([]);
  });
});

describe("C041 a site that does not answer — the server's half", () => {
  /**
   * byollm_012 §5.3 on the direct lane: the lease is renewed through the
   * wait like any held job's, with one grant throughout; at
   * `TOOL_CALL_TIMEOUT` the call stops being outstanding, so the site stops
   * seeing it and a late answer is refused; then the device finishes the
   * job under the lease it held from the start.
   *
   * Mutation (MUTATIONS.md): drop `row.expiresAt <= now` from
   * `MemoryStore.outstandingToolCalls` and `answerToolCall`, which leaves the
   * wait to be ended only by the deadline.
   */
  it("holds the lease through the wait and ends the wait at the timeout", async () => {
    const w = await world({ leaseMs: 30_000 });
    const job = await w.running();
    const callId = await w.call(job);
    const leases = new Set<string>();

    let waited = 0;
    while (waited < TOOL_LIMITS.callTimeoutMs - 5_000) {
      w.h.clock.advance(5_000);
      waited += 5_000;
      expect((await w.heartbeat([job])).lost).toEqual([]);
      await w.h.app.sweep();
      const held = await w.h.store.get(job.jobId);
      expect(held?.state).toBe("running");
      if (held?.lease) leases.add(held.lease.id);
      expect((await w.h.app.calls()).calls.map((c) => c.callId)).toEqual([
        callId,
      ]);
    }
    expect(waited).toBeGreaterThan(30_000);

    w.h.clock.advance(10_000);
    expect((await w.heartbeat([job])).lost).toEqual([]);
    expect((await w.h.app.calls()).calls).toEqual([]);
    expect(
      await w.h.app.toolResult({
        jobId: job.jobId,
        callId,
        envelope: sealedAs("late", "tool-result"),
      }),
    ).toEqual({ refused: "too-late" });

    const done = await w.h.call(
      "result",
      await w.h.resultBody({
        jobId: job.jobId,
        runner: w.runner,
        outcome: { outcome: "ok", text: "the site did not answer in time" },
        leaseId: job.leaseId,
        tools: {
          toolCalls: 1,
          toolOutcomes: { answered: 0, errored: 0, timedOut: 1, refused: 0 },
        },
      }),
      w.runner,
    );
    expect((done.body as { accepted: boolean }).accepted).toBe(true);
    expect([...leases]).toEqual([job.leaseId]);
  });
});
