import { randomBytes } from "node:crypto";
import {
  ENVELOPE_MAX_AGE_MS,
  PROTOCOL_VERSION,
  ToolResult,
  ToolResultsResponse,
  cryptoReady,
  generateKeys,
  keyId,
  open,
  publicIdentityOf,
  seal,
  type Capability,
  type StoredKeys,
  type ToolsPayload,
} from "@byollm/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { ByollmApp } from "./app.js";
import { ToolError, type ToolContext } from "./site-tools.js";
import { MemoryStore } from "./memory.js";
import { createHarness, httpCapabilities } from "./testing.js";

/**
 * The site SDK's tool handlers on the direct lane — byollm_012 §5, §6, §8
 * (#6933, card 4).
 *
 * The device here is the harness's signer playing a daemon — modified, where
 * a case needs one — because the cases are about what the *site* does with
 * whatever arrives. Every envelope is real: sealed by the device to the
 * site, answered sealed by the site to the device, and opened by the device
 * at the end, so a case shows what reached the model and not only what the
 * site meant to send.
 */

beforeAll(async () => {
  await cryptoReady();
});

const toolsCapability: Capability = {
  ...httpCapabilities()[1]!,
  kind: "llm.tools",
};

const webSearch = {
  name: "web_search",
  description: "Search the web for a claim",
  parameters: {
    type: "object" as const,
    properties: { query: { type: "string" as const, maxLength: 40 } },
    required: ["query"],
  },
};

const payloadWith = (overrides: Partial<ToolsPayload> = {}): ToolsPayload => ({
  messages: [{ role: "user", content: "Is the moon made of cheese?" }],
  tools: [webSearch],
  purposeLimits: { maxToolCalls: 8, maxToolResultChars: 32_000 },
  ...overrides,
});

const newCallId = (): string => randomBytes(16).toString("base64url");

async function world() {
  const h = createHarness();
  const runner = await h.pair({
    capabilities: [toolsCapability, ...httpCapabilities()],
  });
  const site = publicIdentityOf(h.siteKeys);
  const device = publicIdentityOf(runner.keys);

  /** Enqueue a tool job and claim it as the runner: running, with a lease. */
  const running = async (
    payload: ToolsPayload = payloadWith(),
    purpose?: string,
  ) => {
    const handle = await h.app.enqueue({
      kind: "llm.tools",
      payload,
      owner: "alice",
      ...(purpose === undefined ? {} : { purpose }),
    });
    const claimed = await h.call(
      "claim",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: runner.runnerId,
        capabilities: [toolsCapability, ...httpCapabilities()],
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

  /** Seal a call as the device does and post it to the site's handlers. */
  const call = async (
    job: { jobId: string; leaseId: string },
    body: { name: string; arguments: Record<string, unknown>; seq?: number },
    options: { signer?: StoredKeys; envelopeJobId?: string } = {},
  ) => {
    const callId = newCallId();
    const signer = options.signer ?? runner.keys;
    const envelope = await seal({
      plaintext: JSON.stringify({
        callId,
        seq: body.seq ?? 1,
        name: body.name,
        arguments: body.arguments,
      }),
      senderKeys: signer,
      recipientEncryptionPublic: site.encryption,
      context: {
        jobId: options.envelopeJobId ?? job.jobId,
        senderKeyId: keyId(publicIdentityOf(signer).identity),
        recipientKeyId: keyId(site.identity),
        deadlineAt: h.clock.now() + ENVELOPE_MAX_AGE_MS,
        direction: "tool-call",
      },
    });
    const posted = await h.call(
      "tool-call",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: runner.runnerId,
        ...job,
        callId,
        envelope,
      },
      runner,
    );
    expect(posted.status).toBe(200);
    return callId;
  };

  /** What the device reads back: each answer, opened, bound to its job. */
  const answers = async (
    job: { jobId: string; leaseId: string },
    callIds: string[],
  ): Promise<Map<string, ToolResult>> => {
    const read = await h.call(
      "tool-results",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: runner.runnerId,
        calls: callIds.map((callId) => ({ ...job, callId })),
      },
      runner,
    );
    expect(read.status).toBe(200);
    const out = new Map<string, ToolResult>();
    for (const row of ToolResultsResponse.parse(read.body).results) {
      const opened = await open({
        envelope: row.envelope,
        recipientKeys: runner.keys,
        senderIdentityPublic: site.identity,
        expected: {
          jobId: job.jobId,
          senderKeyId: keyId(site.identity),
          recipientKeyId: keyId(device.identity),
          direction: "tool-result",
        },
      });
      expect(opened.ok).toBe(true);
      if (opened.ok) {
        const result = ToolResult.parse(JSON.parse(opened.plaintext));
        expect(result.callId).toBe(row.callId);
        out.set(row.callId, result);
      }
    }
    return out;
  };

  return { h, runner, running, call, answers };
}

describe("C040 the site SDK's budget", () => {
  it("runs maxToolCalls handlers and refuses the rest", async () => {
    const w = await world();
    const seen: string[] = [];
    w.h.app.tool("web_search", ({ query }) => {
      seen.push(String(query));
      return `results for ${String(query)}`;
    });
    // The job's budget is the lower of the payload's number and its
    // purpose's: 3 here, under a purpose that allows 8.
    const job = await w.running(payloadWith({ maxToolCalls: 3 }));
    const ids: string[] = [];
    // A modified daemon posts maxToolCalls + 1 valid sealed calls. The
    // direct lane's store counts only to the protocol ceiling, so all four
    // reach the site: the site's own count is the one that stands here.
    for (let seq = 1; seq <= 4; seq += 1) {
      ids.push(
        await w.call(job, {
          name: "web_search",
          arguments: { query: `q${String(seq)}` },
          seq,
        }),
      );
    }

    const report = await w.h.app.pump();
    expect(seen).toHaveLength(3);
    expect(report.tools?.answered).toHaveLength(3);
    expect(report.tools?.refused).toHaveLength(1);

    const read = await w.answers(job, ids);
    expect(read.size).toBe(4);
    const refused = [...read.values()].filter((r) => !r.ok);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining("every tool call it is allowed (3)"),
    });
  });

  it("keeps the count across pump cycles in fresh processes", async () => {
    // A serverless site runs each cycle in a new process, so a count held
    // in memory would restart at zero every cycle and refuse nothing. A
    // second app over the same store is the second process.
    const w = await world();
    let runs = 0;
    w.h.app.tool("web_search", () => {
      runs += 1;
      return "ok";
    });
    const job = await w.running(payloadWith({ maxToolCalls: 2 }));
    await w.call(job, { name: "web_search", arguments: { query: "a" } });
    await w.call(job, { name: "web_search", arguments: { query: "b" } });
    await w.h.app.pump();
    expect(runs).toBe(2);

    const later = new ByollmApp({
      store: w.h.store,
      siteKeys: w.h.siteKeys,
      now: () => w.h.clock.now(),
    });
    later.tool("web_search", () => {
      runs += 1;
      return "ok";
    });
    const third = await w.call(job, {
      name: "web_search",
      arguments: { query: "c" },
      seq: 3,
    });
    const report = await later.pump();
    expect(runs).toBe(2);
    expect(report.tools?.refused).toEqual([third]);
  });
});

describe("a handler runs only for a tool the job's own purpose declared", () => {
  it("never runs another purpose's handler for this job, whatever the call names", async () => {
    // The red-team question for this card. `read_manuscript` belongs to an
    // editing purpose and is registered in the same app; this job's purpose
    // declared only `web_search`. A modified daemon asks for the manuscript
    // tool anyway, with arguments that would fit it.
    const w = await world();
    const manuscripts: string[] = [];
    w.h.app.tool("web_search", () => "searched");
    w.h.app.tool("read_manuscript", ({ id }) => {
      manuscripts.push(String(id));
      return "the whole manuscript";
    });
    const job = await w.running(payloadWith(), "fact-check");
    const callId = await w.call(job, {
      name: "read_manuscript",
      arguments: { id: "someone-elses" },
    });

    const report = await w.h.app.pump();
    expect(manuscripts).toEqual([]);
    expect(report.tools?.errored).toEqual([callId]);
    const read = await w.answers(job, [callId]);
    expect(read.get(callId)).toMatchObject({
      ok: false,
      error: '"read_manuscript" is not a tool of this job',
    });
  });

  it("refuses arguments the declaration does not admit, before the handler", async () => {
    const w = await world();
    let ran = 0;
    w.h.app.tool("web_search", () => {
      ran += 1;
      return "searched";
    });
    const job = await w.running();
    const extra = await w.call(job, {
      name: "web_search",
      arguments: { query: "moon", path: "/etc/passwd" },
    });
    const long = await w.call(job, {
      name: "web_search",
      arguments: { query: "x".repeat(41) },
      seq: 2,
    });
    const report = await w.h.app.pump();
    expect(ran).toBe(0);
    expect(new Set(report.tools?.errored)).toEqual(new Set([extra, long]));
  });
});

describe("what a handler is given, and what it may say", () => {
  it("runs with the job's id, user and purpose, and its answer reaches the device", async () => {
    const w = await world();
    const contexts: ToolContext[] = [];
    w.h.app.tool("web_search", ({ query }, context) => {
      contexts.push(context);
      return `found: ${String(query)}`;
    });
    const job = await w.running(payloadWith(), "fact-check");
    const callId = await w.call(job, {
      name: "web_search",
      arguments: { query: "moon cheese" },
    });
    await w.h.app.pump();
    expect(contexts).toEqual([
      {
        jobId: job.jobId,
        user: "alice",
        purpose: "fact-check",
        callId,
        seq: 1,
      },
    ]);
    expect((await w.answers(job, [callId])).get(callId)).toEqual({
      callId,
      seq: 1,
      ok: true,
      content: "found: moon cheese",
    });
  });

  it("passes a ToolError's words and hides anything else a handler throws", async () => {
    const w = await world();
    w.h.app.tool("web_search", ({ query }) => {
      if (query === "nothing") throw new ToolError("no results for that");
      throw new Error("ECONNREFUSED 10.0.0.7:5432 password=hunter2");
    });
    const job = await w.running();
    const said = await w.call(job, {
      name: "web_search",
      arguments: { query: "nothing" },
    });
    const hidden = await w.call(job, {
      name: "web_search",
      arguments: { query: "boom" },
      seq: 2,
    });
    await w.h.app.pump();
    const read = await w.answers(job, [said, hidden]);
    expect(read.get(said)).toMatchObject({
      ok: false,
      error: "no results for that",
    });
    expect(read.get(hidden)).toMatchObject({
      ok: false,
      error: "the site's tool failed",
    });
  });

  it("refuses a name that is not a tool name, and a second handler for one", () => {
    const app = createHarness().app;
    expect(() => {
      app.tool("Web Search", () => "");
    }).toThrow(/not a tool name/);
    app.tool("web_search", () => "");
    expect(() => {
      app.tool("web_search", () => "");
    }).toThrow(/already registered/);
  });
});

describe("a call the site cannot trust is dropped, and nothing is sent", () => {
  it("from a key that is not the device holding the job", async () => {
    const w = await world();
    let ran = 0;
    w.h.app.tool("web_search", () => {
      ran += 1;
      return "searched";
    });
    const job = await w.running();
    const forged = await w.call(
      job,
      { name: "web_search", arguments: { query: "moon" } },
      { signer: generateKeys(w.h.clock.now()) },
    );
    const report = await w.h.app.pump();
    expect(ran).toBe(0);
    expect(report.tools?.dropped).toEqual([forged]);
    expect((await w.answers(job, [forged])).size).toBe(0);
  });

  it("sealed for another job and replayed under this one", async () => {
    const w = await world();
    let ran = 0;
    w.h.app.tool("web_search", () => {
      ran += 1;
      return "searched";
    });
    const job = await w.running();
    const replayed = await w.call(
      job,
      { name: "web_search", arguments: { query: "moon" } },
      { envelopeJobId: "some-other-job" },
    );
    const report = await w.h.app.pump();
    expect(ran).toBe(0);
    expect(report.tools?.dropped).toEqual([replayed]);
  });
});

describe("toolJobsInFlight()", () => {
  it("is true while a tool job is open, and false once it ends", async () => {
    const w = await world();
    expect(await w.h.app.toolJobsInFlight()).toBe(false);

    // A chat job is not a tool job: a scheduled pump has nothing to answer.
    await w.h.app.enqueue({
      kind: "llm.chat",
      owner: "alice",
      payload: { messages: [{ role: "user", content: "hi" }] },
    });
    expect(await w.h.app.toolJobsInFlight()).toBe(false);

    // Queued counts: on the cloud lane a claimed job stays queued here until
    // a pump adopts it.
    const queued = await w.h.app.enqueue({
      kind: "llm.tools",
      owner: "alice",
      payload: payloadWith(),
    });
    expect(await w.h.app.toolJobsInFlight()).toBe(true);
    await w.h.app.cancel(queued.id);
    expect(await w.h.app.toolJobsInFlight()).toBe(false);

    await w.running();
    expect(await w.h.app.toolJobsInFlight()).toBe(true);
  });

  it("does not count a job past its deadline", async () => {
    const w = await world();
    await w.h.app.enqueue({
      kind: "llm.tools",
      owner: "alice",
      payload: payloadWith(),
      ttlMs: 60_000,
    });
    expect(await w.h.app.toolJobsInFlight()).toBe(true);
    w.h.clock.advance(61_000);
    expect(await w.h.app.toolJobsInFlight()).toBe(false);
  });
});

describe("the store's charge", () => {
  it("counts a call once, refuses past the budget, and ends with the job", async () => {
    const store = new MemoryStore();
    const h = createHarness({ store });
    const handle = await h.app.enqueue({
      kind: "llm.tools",
      owner: "alice",
      payload: payloadWith(),
    });
    const charge = (callId: string) =>
      store.chargeToolCall({
        jobId: handle.id,
        callId,
        maxToolCalls: 2,
        now: h.clock.now(),
      });
    expect(await charge("call_aaaaaaaaaaaaaaaa")).toEqual({ charged: 1 });
    expect(await charge("call_aaaaaaaaaaaaaaaa")).toEqual({ charged: 1 });
    expect(await charge("call_bbbbbbbbbbbbbbbb")).toEqual({ charged: 2 });
    expect(await charge("call_cccccccccccccccc")).toEqual({
      refused: "budget",
    });
    // A call already charged may be run again — its answer was lost.
    expect(await charge("call_bbbbbbbbbbbbbbbb")).toEqual({ charged: 2 });
    await h.app.cancel(handle.id);
    expect(await charge("call_dddddddddddddddd")).toEqual({
      refused: "closed",
    });
  });
});
