import {
  ENVELOPE_MAX_AGE_MS,
  PROTOCOL_VERSION,
  SiteToolCalls,
  TOOL_LIMITS,
  TOOLS_SPENT_MESSAGE,
  ToolCallResponse,
  ToolResultsResponse,
  cryptoReady,
  generateKeys,
  keyId,
  open,
  publicIdentityOf,
  seal,
  type Capability,
  type JobStub,
  type PublicIdentity,
  type SealedEnvelope,
  type StoredKeys,
} from "@byollm/protocol";
import {
  CLOSING_TURN,
  ProtocolClient,
  clientToolTransport,
  runToolLoop,
  type Backend,
  type ConverseRequest,
} from "byollm";
import { randomBytes } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Relay, subStateOf } from "../src/index.js";
import { RelayState } from "../src/state.js";
import { SITE_ID, fixtureFor, makeDaemon, siteHeaders } from "./harness.js";

/**
 * The relay's four tool endpoints — byollm_012 §5.2, §5.3 and §8 (#6933,
 * card 2).
 *
 * The upstream halves of C037, C039 and C041, through the relay's whole HTTP
 * surface. The daemon here is the harness's raw signer rather than a
 * `Runner`: the function-calling loop is card 3's, and C039 is a check about
 * a daemon that has been modified anyway — it plays one.
 *
 * Every envelope is a real one, sealed by the party that would seal it, so
 * the last step of each case can show what the relay cannot: that the result
 * a site posted opens for the job it was posted to and for no other.
 */

let disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers) await dispose();
  disposers = [];
});

beforeAll(async () => {
  await cryptoReady();
});

const LEASE_MS = 30_000;

const toolsCapability: Capability = {
  kind: "llm.tools",
  service: "primary",
  backendId: "openai-http",
  backendClass: "http",
  model: "echo-model",
  offerScope: "private",
};

const newCallId = (): string => randomBytes(16).toString("base64url");

/** A relay with a clock this file moves, one site, and one raw daemon. */
async function world() {
  const clock = { at: Date.now() };
  const siteKeys = generateKeys(clock.at);
  const site = publicIdentityOf(siteKeys);
  const fixture = fixtureFor(site);
  // Its own store, so a case can read the rows the relay holds — every
  // read endpoint filters on the current grant, and so cannot tell rows
  // deleted from rows kept out of reach.
  const store = new RelayState({ now: () => clock.at });
  const relay = new Relay({
    fixture,
    store,
    leaseMs: LEASE_MS,
    now: () => clock.at,
  });
  /** The call rows the relay still holds for a job, every grant's. */
  const heldCalls = async (jobId: string) =>
    (await store.job(SITE_ID, jobId))?.toolCalls?.length ?? 0;
  const daemon = await makeDaemon(relay, fixture, {
    owner: "alice",
    site,
    offer: "private",
  });
  disposers.push(daemon.dispose);
  const device = publicIdentityOf(daemon.keys);

  /** A signed site-plane call, as `@byollm/server`'s cloud lane makes one. */
  const sitePost = async (endpoint: string, body: Record<string, unknown>) => {
    const rawBody = JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      siteId: SITE_ID,
      ...body,
    });
    return relay.handle(
      new Request(`http://relay.test/relay/site/${endpoint}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...siteHeaders(siteKeys, endpoint, rawBody, Date.now()),
        },
        body: rawBody,
      }),
    );
  };
  const siteGet = async (endpoint: string) =>
    relay.handle(
      new Request(
        `http://relay.test/relay/site/${endpoint}?siteId=${SITE_ID}` +
          `&protocolVersion=${PROTOCOL_VERSION}`,
        { headers: siteHeaders(siteKeys, endpoint, "", Date.now()) },
      ),
    );

  let next = 0;
  /** Enqueue an `llm.tools` job, claim it, seal it and fetch it: running. */
  const running = async (
    options: { maxToolCalls?: number; kind?: "llm.tools" | "llm.chat" } = {},
  ) => {
    next += 1;
    const jobId = `job_tools_${String(next)}`;
    const kind = options.kind ?? "llm.tools";
    const stub: JobStub = {
      id: jobId,
      kind,
      owner: "alice",
      site: keyId(site.identity),
      audience: "private",
      sizeClass: "small",
      streaming: false,
      deadlineAt: clock.at + 15 * 60_000,
    };
    const enqueued = await sitePost("enqueue", {
      stub,
      ...(kind === "llm.tools"
        ? {
            tools: {
              toolsDigest: "a".repeat(64),
              maxToolCalls: options.maxToolCalls ?? 8,
            },
          }
        : {}),
    });
    expect(enqueued.status).toBe(200);

    const claim = await daemon.signedFetch("claim", {
      capabilities: [toolsCapability, { ...toolsCapability, kind: "llm.chat" }],
      max: 1,
    });
    const { jobs } = (await claim.json()) as {
      jobs: { id: string; lease: { id: string } }[];
    };
    const leaseId = jobs.find((job) => job.id === jobId)?.lease.id;
    if (leaseId === undefined) throw new Error(`${jobId} was not claimed`);

    const payload = await seal({
      plaintext: JSON.stringify({ messages: [] }),
      senderKeys: siteKeys,
      recipientEncryptionPublic: device.encryption,
      context: {
        jobId,
        senderKeyId: keyId(site.identity),
        recipientKeyId: keyId(device.identity),
        deadlineAt: clock.at + ENVELOPE_MAX_AGE_MS,
        direction: "payload",
      },
    });
    expect(
      (await sitePost("payload", { jobId, envelope: payload })).status,
    ).toBe(200);
    const fetched = await daemon.signedFetch("fetch", { jobId, leaseId });
    expect(fetched.status).toBe(200);
    return { jobId, leaseId };
  };

  /** A `tool-call` envelope, sealed by the device to the site. */
  const callEnvelope = (jobId: string, callId: string, seq: number) =>
    seal({
      plaintext: JSON.stringify({ callId, seq, name: "lookup", arguments: {} }),
      senderKeys: daemon.keys,
      recipientEncryptionPublic: site.encryption,
      context: {
        jobId,
        senderKeyId: keyId(device.identity),
        recipientKeyId: keyId(site.identity),
        deadlineAt: clock.at + ENVELOPE_MAX_AGE_MS,
        direction: "tool-call",
      },
    });

  /** A `tool-result` envelope, sealed by the site to the device. */
  const resultEnvelope = (
    jobId: string,
    callId: string,
    seq: number,
    direction: "tool-result" | "payload" = "tool-result",
  ) =>
    seal({
      plaintext: JSON.stringify({ callId, seq, ok: true, content: "found" }),
      senderKeys: siteKeys,
      recipientEncryptionPublic: device.encryption,
      context: {
        jobId,
        senderKeyId: keyId(site.identity),
        recipientKeyId: keyId(device.identity),
        deadlineAt: clock.at + ENVELOPE_MAX_AGE_MS,
        direction,
      },
    });

  const toolCall = async (
    job: { jobId: string; leaseId: string },
    callId: string,
    envelope: SealedEnvelope,
  ) =>
    daemon.signedFetch("tool-call", {
      jobId: job.jobId,
      leaseId: job.leaseId,
      callId,
      envelope,
    });

  const toolResults = async (
    calls: { jobId: string; leaseId: string; callId: string }[],
  ) => {
    const response = await daemon.signedFetch("tool-results", { calls });
    expect(response.status).toBe(200);
    return ToolResultsResponse.parse(await response.json()).results;
  };

  const calls = async () => {
    const response = await siteGet("calls");
    expect(response.status).toBe(200);
    return SiteToolCalls.parse(await response.json()).calls;
  };

  const answer = async (
    jobId: string,
    callId: string,
    envelope: SealedEnvelope,
  ) => sitePost("tool-result", { jobId, callId, envelope });

  const heartbeat = async (leases: { jobId: string; leaseId: string }[]) => {
    const response = await daemon.signedFetch("heartbeat", {
      daemonVersion: "0.1.5",
      capabilities: [toolsCapability],
      withheld: [],
      activeLeases: leases,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as { lost: { jobId: string }[] };
  };

  /** What the daemon does with a result: open it, bound to its job. */
  const opensFor = async (envelope: SealedEnvelope, jobId: string) =>
    (
      await open({
        envelope,
        recipientKeys: daemon.keys,
        senderIdentityPublic: site.identity,
        expected: {
          jobId,
          senderKeyId: keyId(site.identity),
          recipientKeyId: keyId(device.identity),
          direction: "tool-result",
        },
      })
    ).ok;

  return {
    clock,
    relay,
    fixture,
    site,
    daemon,
    device,
    siteKeys,
    sitePost,
    running,
    callEnvelope,
    resultEnvelope,
    toolCall,
    toolResults,
    calls,
    answer,
    heartbeat,
    opensFor,
    heldCalls,
  };
}

type World = Awaited<ReturnType<typeof world>>;

/** Make a call on a running job and return its id. */
async function call(
  w: World,
  job: { jobId: string; leaseId: string },
  seq = 1,
) {
  const callId = newCallId();
  const response = await w.toolCall(
    job,
    callId,
    await w.callEnvelope(job.jobId, callId, seq),
  );
  expect(response.status).toBe(200);
  const body = ToolCallResponse.parse(await response.json());
  expect(body.callId).toBe(callId);
  return callId;
}

describe("a tool call through the relay", () => {
  it("travels device → relay → site and back, sealed both ways", async () => {
    const w = await world();
    const job = await w.running();
    const callId = await call(w, job);

    const [waiting] = await w.calls();
    expect(waiting?.callId).toBe(callId);
    expect(waiting?.jobId).toBe(job.jobId);
    expect(waiting?.leaseId).toBe(job.leaseId);
    // The directory role: the key the site verifies and seals to.
    expect(waiting?.device).toEqual(w.device);

    const result = await w.resultEnvelope(job.jobId, callId, 1);
    expect((await w.answer(job.jobId, callId, result)).status).toBe(200);
    expect(await w.calls()).toEqual([]);

    const [answered] = await w.toolResults([{ ...job, callId }]);
    expect(answered?.envelope).toEqual(result);
    expect(await w.opensFor(answered!.envelope, job.jobId)).toBe(true);
  });

  it("returns an answer on every poll that names it, until the job ends", async () => {
    const w = await world();
    const job = await w.running();
    const callId = await call(w, job);
    await w.answer(
      job.jobId,
      callId,
      await w.resultEnvelope(job.jobId, callId, 1),
    );
    expect(await w.toolResults([{ ...job, callId }])).toHaveLength(1);
    // A lost response costs a poll, not the answer.
    expect(await w.toolResults([{ ...job, callId }])).toHaveLength(1);
  });

  it("counts a replayed call once and refuses a different call under its id", async () => {
    const w = await world();
    const job = await w.running({ maxToolCalls: 2 });
    const callId = newCallId();
    const envelope = await w.callEnvelope(job.jobId, callId, 1);
    expect((await w.toolCall(job, callId, envelope)).status).toBe(200);
    expect((await w.toolCall(job, callId, envelope)).status).toBe(200);
    const other = await w.callEnvelope(job.jobId, callId, 2);
    expect((await w.toolCall(job, callId, other)).status).toBe(400);
    // The replay was not a second call: one slot of two is left.
    await call(w, job, 2);
    const third = newCallId();
    const refused = await w.toolCall(
      job,
      third,
      await w.callEnvelope(job.jobId, third, 3),
    );
    expect(refused.status).toBe(403);
  });

  it("refuses a call on a job that does not carry tools", async () => {
    const w = await world();
    const job = await w.running({ kind: "llm.chat" });
    const callId = newCallId();
    const response = await w.toolCall(
      job,
      callId,
      await w.callEnvelope(job.jobId, callId, 1),
    );
    expect(response.status).toBe(400);
    expect(await w.calls()).toEqual([]);
  });

  it("refuses an llm.tools enqueue without its tools, and tools on any other", async () => {
    const w = await world();
    const stub = (id: string, kind: "llm.tools" | "llm.chat"): JobStub => ({
      id,
      kind,
      owner: "alice",
      site: keyId(publicIdentityOf(w.siteKeys).identity),
      audience: "private",
      sizeClass: "small",
      streaming: false,
      deadlineAt: w.clock.at + 60_000,
    });
    const tools = { toolsDigest: "b".repeat(64), maxToolCalls: 4 };
    expect(
      (await w.sitePost("enqueue", { stub: stub("bare", "llm.tools") })).status,
    ).toBe(400);
    expect(
      (await w.sitePost("enqueue", { stub: stub("odd", "llm.chat"), tools }))
        .status,
    ).toBe(400);
  });
});

describe("C037 a result is bound to its call — the relay's half", () => {
  /**
   * byollm_012 §12 row 5: the upstream returns a result for an unknown
   * `callId`, for another job's call, a replay of an answered call, and a
   * `payload`-direction envelope. The relay cannot open anything, so its
   * half is the binding it can enforce in the clear: a result lands only on
   * an outstanding call of the job it names, and reaches only the holder of
   * that job's current grant. The daemon's half — opening and checking the
   * job, the call and the direction inside the signature — is card 3's, and
   * the last assertion here shows it holding behind this one.
   *
   * Mutation (MUTATIONS.md): drop the `callId` match in
   * `RelayState.answerToolCall` (`row.callId === input.callId`).
   */
  it("refuses an unknown call id, and another job's call", async () => {
    const w = await world();
    const a = await w.running();
    const b = await w.running();
    const callA = await call(w, a);
    const callB = await call(w, b);

    const unknown = newCallId();
    const stray = await w.answer(
      a.jobId,
      unknown,
      await w.resultEnvelope(a.jobId, unknown, 1),
    );
    expect(stray.status).toBe(404);

    // B's call id, posted against job A.
    const crossed = await w.answer(
      a.jobId,
      callB,
      await w.resultEnvelope(a.jobId, callB, 1),
    );
    expect(crossed.status).toBe(404);

    // Neither landed anywhere: both calls still wait, and nothing came back.
    expect((await w.calls()).map((c) => c.callId).sort()).toEqual(
      [callA, callB].sort(),
    );
    expect(
      await w.toolResults([
        { ...a, callId: callA },
        { ...a, callId: callB },
        { ...a, callId: unknown },
        { ...b, callId: callB },
      ]),
    ).toEqual([]);
  });

  it("refuses a second, different answer to a call already answered", async () => {
    const w = await world();
    const job = await w.running();
    const callId = await call(w, job);
    const first = await w.resultEnvelope(job.jobId, callId, 1);
    expect((await w.answer(job.jobId, callId, first)).status).toBe(200);
    // The same signed answer again is a replay, accepted and written once.
    expect((await w.answer(job.jobId, callId, first)).status).toBe(200);
    const second = await w.resultEnvelope(job.jobId, callId, 1);
    expect((await w.answer(job.jobId, callId, second)).status).toBe(409);
    const [delivered] = await w.toolResults([{ ...job, callId }]);
    expect(delivered?.envelope).toEqual(first);
  });

  it("gives job A's answer only to A's grant, and never to B's", async () => {
    const w = await world();
    const a = await w.running();
    const b = await w.running();
    const callId = await call(w, a);
    await w.answer(a.jobId, callId, await w.resultEnvelope(a.jobId, callId, 1));
    // B's holder naming A's call under B's lease gets nothing.
    expect(await w.toolResults([{ ...b, callId }])).toEqual([]);
    // A's job id under B's lease is not A's grant either.
    expect(
      await w.toolResults([{ jobId: a.jobId, leaseId: b.leaseId, callId }]),
    ).toEqual([]);
    const [mine] = await w.toolResults([{ ...a, callId }]);
    expect(mine).toBeDefined();
    // And behind the relay, the daemon's half: A's result does not open as
    // B's, whatever routed it.
    expect(await w.opensFor(mine!.envelope, b.jobId)).toBe(false);
  });

  it("carries a payload-direction envelope blind, and the daemon refuses it", async () => {
    // The relay cannot see a direction — that is RELAY_BLIND — so it carries
    // the envelope, and the binding the direction gives is the daemon's.
    const w = await world();
    const job = await w.running();
    const callId = await call(w, job);
    const forged = await w.resultEnvelope(job.jobId, callId, 1, "payload");
    expect((await w.answer(job.jobId, callId, forged)).status).toBe(200);
    const [carried] = await w.toolResults([{ ...job, callId }]);
    expect(await w.opensFor(carried!.envelope, job.jobId)).toBe(false);
  });

  it("leaves nothing to land on once job A has ended", async () => {
    const w = await world();
    const a = await w.running();
    const callId = await call(w, a);
    const result = await w.resultEnvelope(a.jobId, callId, 1);
    expect(await w.heldCalls(a.jobId)).toBe(1);

    // A ends: the device posts its result while the call is unanswered.
    const done = await w.daemon.signedFetch("result", {
      jobId: a.jobId,
      leaseId: a.leaseId,
      envelope: result,
      disposition: "ok",
    });
    expect(done.status).toBe(200);
    expect((await w.answer(a.jobId, callId, result)).status).toBe(404);
    expect(await w.toolResults([{ ...a, callId }])).toEqual([]);
    expect(await w.calls()).toEqual([]);
    // Out of reach is not deleted — the reads above filter on the grant.
    expect(await w.heldCalls(a.jobId)).toBe(0);
  });

  it("leaves nothing to land on once A's grant has ended, even if A runs again", async () => {
    const w = await world();
    const a = await w.running();
    const callId = await call(w, a);

    // The grant lapses — no heartbeat — and A goes back to the queue.
    w.clock.at += LEASE_MS + 1;
    await w.relay.sweep();
    const late = await w.answer(
      a.jobId,
      callId,
      await w.resultEnvelope(a.jobId, callId, 1),
    );
    expect(late.status).toBe(404);
    expect(await w.calls()).toEqual([]);
    // The grant's rows went with the grant; only the job's count stays.
    expect(await w.heldCalls(a.jobId)).toBe(0);

    // Claimed again, under a new grant: the old call is not this grant's.
    const claim = await w.daemon.signedFetch("claim", {
      capabilities: [toolsCapability],
      max: 1,
    });
    const { jobs } = (await claim.json()) as {
      jobs: { id: string; lease: { id: string } }[];
    };
    const again = jobs.find((job) => job.id === a.jobId);
    expect(again).toBeDefined();
    expect(again?.lease.id).not.toBe(a.leaseId);
    expect(
      await w.toolResults([
        { jobId: a.jobId, leaseId: again!.lease.id, callId },
      ]),
    ).toEqual([]);
  });
});

describe("C039 the relay's budget", () => {
  /**
   * byollm_012 §12 row 7: the kit plays a modified daemon and posts 21 calls
   * on one job; the relay refuses the 21st and the site's `calls` never
   * shows it. Then the same at a site's own lower budget, which is the
   * number the relay is told at enqueue, and across a requeue, which is the
   * door a budget per grant would leave open.
   *
   * The budget of 3 is C039's row as #7122 ruled it (byollm_012 §12 row 7):
   * sent through the enqueue request, so a site plane that drops
   * `tools.maxToolCalls` leaves the job at the ceiling and the case fails.
   *
   * Mutations (MUTATIONS.md): drop the relay's count — the
   * `if ((job.toolCallsMade ?? 0) >= limit) return { refused: "budget" }`
   * line in `RelayState.recordToolCall`; and drop the field at the site
   * plane's `enqueue` call.
   */
  it("refuses the 21st call on one job, and the site never sees it", async () => {
    const w = await world();
    const job = await w.running({ maxToolCalls: TOOL_LIMITS.maxToolCalls });
    const accepted: string[] = [];
    for (let seq = 1; seq <= TOOL_LIMITS.maxToolCalls; seq += 1) {
      accepted.push(await call(w, job, seq));
    }
    const extra = newCallId();
    const refused = await w.toolCall(
      job,
      extra,
      await w.callEnvelope(job.jobId, extra, TOOL_LIMITS.maxToolCalls),
    );
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "forbidden",
    );
    const seen = (await w.calls()).map((c) => c.callId);
    expect(seen).toHaveLength(TOOL_LIMITS.maxToolCalls);
    expect(seen).not.toContain(extra);
  });

  it("holds a job to the budget its site sent, below the ceiling", async () => {
    const w = await world();
    const job = await w.running({ maxToolCalls: 3 });
    for (let seq = 1; seq <= 3; seq += 1) await call(w, job, seq);
    const fourth = newCallId();
    const refused = await w.toolCall(
      job,
      fourth,
      await w.callEnvelope(job.jobId, fourth, 4),
    );
    expect(refused.status).toBe(403);
    // The pair the daemon recognises as the job's tools being spent (§8).
    expect(await refused.json()).toEqual({
      error: "forbidden",
      message: TOOLS_SPENT_MESSAGE,
    });
    expect((await w.calls()).map((c) => c.callId)).not.toContain(fourth);
  });

  it("does not give the budget back when the job is released and claimed again", async () => {
    const w = await world();
    const job = await w.running({ maxToolCalls: 2 });
    await call(w, job, 1);
    await call(w, job, 2);
    const released = await w.daemon.signedFetch("release", {
      leases: [{ jobId: job.jobId, leaseId: job.leaseId }],
      reason: "shutdown",
    });
    expect(released.status).toBe(200);

    // A modified daemon's way round a budget per grant: give the job back
    // and take it again. The count is the job's, so nothing was regained.
    const claim = await w.daemon.signedFetch("claim", {
      capabilities: [toolsCapability],
      max: 1,
    });
    const { jobs } = (await claim.json()) as {
      jobs: { id: string; lease: { id: string } }[];
    };
    const leaseId = jobs.find((it) => it.id === job.jobId)?.lease.id;
    expect(leaseId).toBeDefined();
    const regained = { jobId: job.jobId, leaseId: leaseId! };
    // Re-sealed and fetched, so the job is running under the new grant.
    const pending = await w.relay.state.job(SITE_ID, job.jobId);
    expect(pending?.state).toBe("awaiting-payload");
    const payload = await seal({
      plaintext: JSON.stringify({ messages: [] }),
      senderKeys: w.siteKeys,
      recipientEncryptionPublic: w.device.encryption,
      context: {
        jobId: job.jobId,
        senderKeyId: keyId(publicIdentityOf(w.siteKeys).identity),
        recipientKeyId: keyId(w.device.identity),
        deadlineAt: w.clock.at + ENVELOPE_MAX_AGE_MS,
        direction: "payload",
      },
    });
    await w.sitePost("payload", { jobId: job.jobId, envelope: payload });
    await w.daemon.signedFetch("fetch", regained);

    const third = newCallId();
    const refused = await w.toolCall(
      regained,
      third,
      await w.callEnvelope(job.jobId, third, 1),
    );
    expect(refused.status).toBe(403);
  });

  /**
   * What an HONEST daemon does with that refusal — #7122's condition, Owl's
   * #56042 point 3. Dane's device spends a budget of 3 and its lease lapses;
   * Lis's device claims the job with its own count at 0, and its first call
   * is refused by the relay. The shipped tool loop, through the shipped
   * transport and the shipped client, against this relay's plane: the model
   * hears a tool error, gets one closing turn with no tools, and the job is
   * `ok` with `stop: "tool-budget"` — never a failed request, and never a
   * model left calling into refusals on paid turns.
   *
   * Mutations (MUTATIONS.md): the client drops its `tools-spent` branch, so
   * the 403 is plain `forbidden`; the loop reads `tools-spent` as unsent.
   */
  it("closes a job reclaimed with its calls spent: a tool error, one closing turn, ok with tool-budget", async () => {
    const w = await world();
    const job = await w.running({ maxToolCalls: 3 });
    for (let seq = 1; seq <= 3; seq += 1) await call(w, job, seq);

    // Dane's lid closes: no heartbeat, the lease lapses, the job requeues.
    w.clock.at += LEASE_MS + 1;
    await w.relay.sweep();
    expect((await w.relay.state.job(SITE_ID, job.jobId))?.state).toBe("queued");

    const lis = await makeDaemon(w.relay, w.fixture, {
      owner: "alice",
      site: w.site,
      offer: "private",
    });
    disposers.push(lis.dispose);
    const lisDevice = publicIdentityOf(lis.keys);
    const claim = await lis.signedFetch("claim", {
      capabilities: [toolsCapability],
      max: 1,
    });
    const { jobs } = (await claim.json()) as {
      jobs: { id: string; lease: { id: string } }[];
    };
    const leaseId = jobs.find((it) => it.id === job.jobId)?.lease.id;
    if (leaseId === undefined) throw new Error("Lis did not claim the job");
    const payload = await seal({
      plaintext: JSON.stringify({ messages: [] }),
      senderKeys: w.siteKeys,
      recipientEncryptionPublic: lisDevice.encryption,
      context: {
        jobId: job.jobId,
        senderKeyId: keyId(w.site.identity),
        recipientKeyId: keyId(lisDevice.identity),
        deadlineAt: w.clock.at + ENVELOPE_MAX_AGE_MS,
        direction: "payload",
      },
    });
    expect(
      (await w.sitePost("payload", { jobId: job.jobId, envelope: payload }))
        .status,
    ).toBe(200);
    expect(
      (await lis.signedFetch("fetch", { jobId: job.jobId, leaseId })).status,
    ).toBe(200);

    // Lis's client, with every tool-call answer the relay served recorded.
    const served: { status: number; body: unknown }[] = [];
    const client = new ProtocolClient({
      origin: "http://relay.test",
      identity: { runnerId: lis.runnerId, sign: lis.sign },
      fetch: async (input, init) => {
        const response = await w.relay.handle(new Request(input, init));
        if (new Request(input, init).url.endsWith("/byollm/tool-call")) {
          served.push({
            status: response.status,
            body: await response.clone().json(),
          });
        }
        return response;
      },
    });

    // A model that calls whenever it is offered tools, as a model with a
    // question it cannot answer does.
    const seen: ConverseRequest[] = [];
    const backend: Backend = {
      id: "openai-http",
      class: "http",
      stopReasons: { kind: "unavailable", why: "a test double" },
      health: () => Promise.resolve({ healthy: true, models: [] }),
      execute: () => Promise.reject(new Error("not used")),
      converse: (request) => {
        seen.push(request);
        return Promise.resolve(
          request.tools === undefined
            ? {
                ok: true,
                text: "from what I have",
                toolCalls: [],
                stop: "end",
                durationMs: 0,
              }
            : {
                ok: true,
                text: "",
                toolCalls: [
                  {
                    id: `m${String(seen.length)}`,
                    name: "lookup",
                    arguments: '{"query":"q"}',
                  },
                ],
                stop: "end",
                durationMs: 0,
              },
        );
      },
    };
    const outcomes: { outcome: string; detail?: string | undefined }[] = [];
    const run = await runToolLoop({
      backend,
      model: "echo-model",
      jobId: job.jobId,
      prompt: "check the chapter",
      declarations: [
        {
          name: "lookup",
          description: "Look a term up.",
          parameters: {
            type: "object",
            properties: { query: { type: "string", maxLength: 64 } },
          },
        },
      ],
      // Lis's own count, from the payload: it knows nothing of Dane's calls.
      budget: 3,
      maxResultChars: 32_000,
      turnCeilingMs: 60_000,
      maxOutputBytes: 64_000,
      deadlineAt: w.clock.at + 10 * 60_000,
      signal: new AbortController().signal,
      now: () => w.clock.at,
      wait: (ms) => {
        w.clock.at += ms;
        return Promise.resolve();
      },
      transport: clientToolTransport(client, {
        runnerId: lis.runnerId,
        jobId: job.jobId,
        leaseId,
      }),
      seal: (toolCall) =>
        seal({
          plaintext: JSON.stringify(toolCall),
          senderKeys: lis.keys,
          recipientEncryptionPublic: w.site.encryption,
          context: {
            jobId: job.jobId,
            senderKeyId: keyId(lisDevice.identity),
            recipientKeyId: keyId(w.site.identity),
            deadlineAt: w.clock.at + ENVELOPE_MAX_AGE_MS,
            direction: "tool-call",
          },
        }),
      open: () => Promise.resolve(null),
      log: {
        call: () => Promise.resolve(),
        outcome: (entry) => {
          outcomes.push({ outcome: entry.outcome, detail: entry.detail });
          return Promise.resolve();
        },
        dropped: () => Promise.resolve(),
      },
    });

    // The real refusal: one call sent, and the relay's own 403 for it.
    expect(served).toEqual([
      {
        status: 403,
        body: { error: "forbidden", message: TOOLS_SPENT_MESSAGE },
      },
    ]);
    // Never shown to the site, and nothing charged past the budget.
    expect(await w.calls()).toEqual([]);
    expect((await w.relay.state.job(SITE_ID, job.jobId))?.toolCallsMade).toBe(
      3,
    );

    // The model was told, then asked once more with no tools offered.
    expect(seen).toHaveLength(2);
    expect(seen[0]?.tools).toBeDefined();
    expect(seen[1]?.tools).toBeUndefined();
    const told = seen[1]?.messages.find((m) => m.role === "tool");
    expect(told?.content).toMatch(/tools are spent/u);
    expect(seen[1]?.messages.at(-1)?.content).toBe(CLOSING_TURN);

    // ok, and says why it is short.
    expect(run.result).toMatchObject({ ok: true, stop: "tool-budget" });
    expect(run.toolOutcomes).toEqual({
      answered: 0,
      errored: 0,
      timedOut: 0,
      refused: 1,
    });
    expect(outcomes.map((o) => o.outcome)).toEqual(["refused"]);
  });
});

describe("C041 a site that does not answer — the relay's half", () => {
  /**
   * byollm_012 §12 row 9, §5.3. The daemon gives the model a tool error at
   * `TOOL_CALL_TIMEOUT` and the job ends `ok` — card 3's half. The relay's:
   * the job stays `running` and `waiting-on-site` throughout, the lease is
   * renewed by the heartbeat as for any held job, with one grant from start
   * to finish and no reclaim, and at the timeout the call stops being
   * outstanding — the site no longer sees it and a late answer is refused —
   * so the deadline is not what ends the wait. Then the device finishes the
   * job under the lease it has held all along.
   *
   * Sampled while it runs, not judged at the end: every lease id observed is
   * collected, and there must be exactly one (MUTATIONS.md, the rule from
   * cloud_008 §0.6).
   *
   * Mutations (MUTATIONS.md): stop renewing a lease while its job waits (skip
   * a job with an unanswered call in `RelayState.renewLeases`); and resolve
   * the wait only at the deadline (drop `call.expiresAt <= now` from
   * `answerToolCall` and `toolCalls`).
   */
  it("holds the lease through the wait, and ends the wait at the timeout", async () => {
    const w = await world();
    const job = await w.running();
    const callId = await call(w, job);
    const leases = new Set<string>();
    const sample = async () => {
      const routed = await w.relay.state.job(SITE_ID, job.jobId);
      expect(routed?.state).toBe("running");
      if (routed?.claimedBy) leases.add(routed.claimedBy.leaseId);
      return routed!;
    };

    // Waiting, past two whole leases, with the heartbeat a daemon sends.
    let waited = 0;
    while (waited < TOOL_LIMITS.callTimeoutMs - 5_000) {
      w.clock.at += 5_000;
      waited += 5_000;
      const beat = await w.heartbeat([job]);
      expect(beat.lost).toEqual([]);
      await w.relay.sweep();
      const routed = await sample();
      expect(subStateOf(routed, w.clock.at)).toBe("waiting-on-site");
      expect((await w.calls()).map((c) => c.callId)).toEqual([callId]);
    }
    expect(waited).toBeGreaterThan(LEASE_MS);

    // The timeout passes. The job is still running and still held, and the
    // call is over: not listed, not answerable, not delivered.
    w.clock.at += 10_000;
    expect((await w.heartbeat([job])).lost).toEqual([]);
    const routed = await sample();
    expect(subStateOf(routed, w.clock.at)).toBeUndefined();
    expect(await w.calls()).toEqual([]);
    const late = await w.answer(
      job.jobId,
      callId,
      await w.resultEnvelope(job.jobId, callId, 1),
    );
    expect(late.status).toBe(409);
    expect(await w.toolResults([{ ...job, callId }])).toEqual([]);

    // The model answers with what it has, and the device finishes the job
    // under the grant it held from the start.
    const finished = await w.daemon.signedFetch("result", {
      ...job,
      envelope: await w.resultEnvelope(job.jobId, callId, 1),
      disposition: "ok",
    });
    expect(finished.status).toBe(200);
    expect(((await finished.json()) as { accepted: boolean }).accepted).toBe(
      true,
    );
    expect([...leases]).toEqual([job.leaseId]);
  });

  it("is not waiting-on-site once the site answers", async () => {
    const w = await world();
    const job = await w.running();
    const callId = await call(w, job);
    const before = await w.relay.state.job(SITE_ID, job.jobId);
    expect(subStateOf(before!, w.clock.at)).toBe("waiting-on-site");
    await w.answer(
      job.jobId,
      callId,
      await w.resultEnvelope(job.jobId, callId, 1),
    );
    const after = await w.relay.state.job(SITE_ID, job.jobId);
    expect(subStateOf(after!, w.clock.at)).toBeUndefined();
  });
});

describe("the relay hands the enqueue's digest to the deployment that checks it", () => {
  it("passes toolsDigest to satisfiable on llm.tools, and nothing on other kinds", async () => {
    const asked: { kind: string; toolsDigest?: string }[] = [];
    const clock = { at: Date.now() };
    const siteKeys: StoredKeys = generateKeys(clock.at);
    const site: PublicIdentity = publicIdentityOf(siteKeys);
    const relay = new Relay({
      fixture: fixtureFor(site),
      now: () => clock.at,
      satisfiable: (query) => {
        asked.push({
          kind: query.kind,
          ...(query.toolsDigest === undefined
            ? {}
            : { toolsDigest: query.toolsDigest }),
        });
        return Promise.resolve({ verdict: "ok" });
      },
    });
    const post = async (body: Record<string, unknown>) => {
      const rawBody = JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        siteId: SITE_ID,
        ...body,
      });
      return relay.handle(
        new Request("http://relay.test/relay/site/enqueue", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...siteHeaders(siteKeys, "enqueue", rawBody),
          },
          body: rawBody,
        }),
      );
    };
    const stub = (id: string, kind: "llm.tools" | "llm.chat"): JobStub => ({
      id,
      kind,
      owner: "alice",
      site: keyId(site.identity),
      audience: "private",
      sizeClass: "small",
      streaming: false,
      deadlineAt: clock.at + 60_000,
    });
    const digest = "c".repeat(64);
    expect(
      (
        await post({
          stub: stub("t", "llm.tools"),
          tools: { toolsDigest: digest, maxToolCalls: 5 },
        })
      ).status,
    ).toBe(200);
    expect((await post({ stub: stub("c", "llm.chat") })).status).toBe(200);
    expect(asked).toEqual([
      { kind: "llm.tools", toolsDigest: digest },
      { kind: "llm.chat" },
    ]);
    expect((await relay.state.job(SITE_ID, "t"))?.maxToolCalls).toBe(5);
  });
});
