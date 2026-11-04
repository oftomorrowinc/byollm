import { randomBytes } from "node:crypto";
import {
  ENVELOPE_MAX_AGE_MS,
  ToolResult,
  ToolResultsResponse,
  cryptoReady,
  keyId,
  open,
  publicIdentityOf,
  seal,
  sizeClassOf,
  toolsDigest,
  type Capability,
  type ToolSpec,
  type ToolsPayload,
} from "@byollm/protocol";
import {
  ByollmApp,
  EnqueueRefused,
  MemoryStore,
  generateSiteKeys,
} from "@byollm/server";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Relay, type RelayOptions } from "../src/index.js";
import { SITE_ID, fixtureFor, makeDaemon } from "./harness.js";

/**
 * The site SDK's tool work on the cloud lane — byollm_012 §4, §5, §8 and
 * byollm_021 R2 (#6933, card 4).
 *
 * `ByollmApp` with a relay lane, against the real relay over its HTTP
 * surface. The daemon is the harness's raw signer playing one: the
 * function-calling loop is card 3's, and what is under test is the site.
 *
 * Here: a call answered end to end through the relay (the pump's `calls`
 * step), C047's SDK half (the digest beside the stub, refused at enqueue
 * when it disagrees with the manifest of record), C046's SDK half (the job
 * classed by its prompt plus `maxToolResultChars`), and a relay that
 * predates tools answering `calls` 404.
 */

let disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers) await dispose();
  disposers = [];
});

beforeAll(async () => {
  await cryptoReady();
});

const toolsCapability: Capability = {
  kind: "llm.tools",
  service: "primary",
  backendId: "openai-http",
  backendClass: "http",
  model: "echo-model",
  offerScope: "private",
};

const webSearch: ToolSpec = {
  description: "Search the web for a claim",
  parameters: {
    type: "object",
    properties: { query: { type: "string", maxLength: 400 } },
    required: ["query"],
  },
};

const payload = (overrides: Partial<ToolsPayload> = {}): ToolsPayload => ({
  messages: [{ role: "user", content: "Is the moon made of cheese?" }],
  tools: [{ name: "web_search", ...webSearch }],
  purposeLimits: { maxToolCalls: 8, maxToolResultChars: 32_000 },
  ...overrides,
});

/** Everything the site sent the relay, by endpoint, as parsed JSON. */
type Sent = { endpoint: string; body: Record<string, unknown> }[];

async function world(
  options: {
    satisfiable?: RelayOptions["satisfiable"];
    /** Answer this site-plane endpoint 404, as a relay without it would. */
    absent?: string;
    /** Add this entry to every `calls` answer, as a relay might. */
    inject?: unknown;
  } = {},
) {
  const siteKeys = generateSiteKeys();
  const site = publicIdentityOf(siteKeys);
  const fixture = fixtureFor(site);
  const relay = new Relay({
    fixture,
    ...(options.satisfiable === undefined
      ? {}
      : { satisfiable: options.satisfiable }),
  });
  const sent: Sent = [];
  const store = new MemoryStore();
  const app = new ByollmApp({
    store,
    siteKeys,
    lane: {
      relayOrigin: "http://relay.test",
      siteId: SITE_ID,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const endpoint = new URL(request.url).pathname.split("/").pop() ?? "";
        if (init?.body !== undefined && typeof init.body === "string") {
          sent.push({
            endpoint,
            body: JSON.parse(init.body) as Record<string, unknown>,
          });
        }
        if (endpoint === options.absent) {
          return new Response(JSON.stringify({ error: "not-found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        const answer = await relay.handle(request);
        if (endpoint !== "calls" || options.inject === undefined) return answer;
        const body = (await answer.json()) as { calls: unknown[] };
        return Response.json({ calls: [...body.calls, options.inject] });
      },
    },
  });
  const daemon = await makeDaemon(relay, fixture, {
    owner: "alice",
    site,
    offer: "private",
  });
  disposers.push(daemon.dispose);
  const device = publicIdentityOf(daemon.keys);

  /** Claim a tool job as the device, and let the site seal its payload. */
  const running = async (jobId: string) => {
    const claim = await daemon.signedFetch("claim", {
      capabilities: [toolsCapability],
      max: 1,
    });
    const { jobs } = (await claim.json()) as {
      jobs: { id: string; lease: { id: string } }[];
    };
    const leaseId = jobs.find((job) => job.id === jobId)?.lease.id;
    if (leaseId === undefined) throw new Error(`${jobId} was not claimed`);
    const sealed = await app.pump();
    expect(sealed.sealed).toEqual([jobId]);
    const fetched = await daemon.signedFetch("fetch", { jobId, leaseId });
    expect(fetched.status).toBe(200);
    return { jobId, leaseId };
  };

  /** Seal a call to the site as the device does, and post it to the relay. */
  const call = async (
    job: { jobId: string; leaseId: string },
    name: string,
    args: Record<string, unknown>,
  ) => {
    const callId = randomBytes(16).toString("base64url");
    const envelope = await seal({
      plaintext: JSON.stringify({ callId, seq: 1, name, arguments: args }),
      senderKeys: daemon.keys,
      recipientEncryptionPublic: site.encryption,
      context: {
        jobId: job.jobId,
        senderKeyId: keyId(device.identity),
        recipientKeyId: keyId(site.identity),
        deadlineAt: Date.now() + ENVELOPE_MAX_AGE_MS,
        direction: "tool-call",
      },
    });
    const posted = await daemon.signedFetch("tool-call", {
      ...job,
      callId,
      envelope,
    });
    expect(posted.status).toBe(200);
    return callId;
  };

  /** The device's read of its answers, opened as the daemon opens them. */
  const answer = async (
    job: { jobId: string; leaseId: string },
    callId: string,
  ): Promise<ToolResult | undefined> => {
    const response = await daemon.signedFetch("tool-results", {
      calls: [{ ...job, callId }],
    });
    expect(response.status).toBe(200);
    const [row] = ToolResultsResponse.parse(await response.json()).results;
    if (row === undefined) return undefined;
    const opened = await open({
      envelope: row.envelope,
      recipientKeys: daemon.keys,
      senderIdentityPublic: site.identity,
      expected: {
        jobId: job.jobId,
        senderKeyId: keyId(site.identity),
        recipientKeyId: keyId(device.identity),
        direction: "tool-result",
      },
    });
    if (!opened.ok)
      throw new Error(`the answer did not open: ${opened.reason}`);
    return ToolResult.parse(JSON.parse(opened.plaintext));
  };

  return { relay, app, store, daemon, sent, running, call, answer };
}

describe("the pump's calls step, through the relay", () => {
  it("collects a sealed call, runs the handler and seals the answer back", async () => {
    const w = await world();
    const asked: unknown[] = [];
    w.app.tool("web_search", ({ query }, job) => {
      asked.push({ query, user: job.user });
      return "the moon is rock";
    });
    const handle = await w.app.enqueue({
      kind: "llm.tools",
      owner: "alice",
      payload: payload(),
    });
    const job = await w.running(handle.id);
    const callId = await w.call(job, "web_search", { query: "moon" });

    const report = await w.app.pump();
    expect(report.tools?.answered).toEqual([callId]);
    expect(report.toolsUnavailable).toBeUndefined();
    expect(asked).toEqual([{ query: "moon", user: "alice" }]);
    expect(await w.answer(job, callId)).toEqual({
      callId,
      seq: 1,
      ok: true,
      content: "the moon is rock",
    });
    // Answered once: the relay no longer lists it, and a second cycle runs
    // nothing.
    const again = await w.app.pump();
    expect(again.tools?.answered).toEqual([]);
    expect(asked).toHaveLength(1);
  });
});

describe("a calls answer this SDK cannot wholly read", () => {
  it("drops the entry it cannot read and answers the rest", async () => {
    const strange = { callId: "call_from_the_future_0001", shape: "new" };
    const w = await world({ inject: strange });
    w.app.tool("web_search", () => "answered anyway");
    const handle = await w.app.enqueue({
      kind: "llm.tools",
      owner: "alice",
      payload: payload(),
    });
    const job = await w.running(handle.id);
    const callId = await w.call(job, "web_search", { query: "moon" });
    const report = await w.app.pump();
    expect(report.tools?.answered).toEqual([callId]);
    expect(report.tools?.dropped).toEqual([strange.callId]);
    expect((await w.answer(job, callId))?.ok).toBe(true);
  });
});

describe("C047 code and manifest agree at enqueue — the site SDK's half", () => {
  /**
   * A hub holding the manifest of record: it compares the digest beside the
   * stub with the digest of what was registered, as the control plane does.
   */
  const hubWithManifest =
    (registered: ToolSpec): RelayOptions["satisfiable"] =>
    (query) => {
      if (query.kind !== "llm.tools") return Promise.resolve({ verdict: "ok" });
      const recorded = toolsDigest({
        tools: { web_search: registered },
        maxToolCalls: 8,
        maxToolResultChars: 32_000,
      });
      return Promise.resolve({
        verdict: query.toolsDigest === recorded ? "ok" : "tools-mismatch",
      });
    };

  it("sends the digest of exactly what it declares, beside the stub", async () => {
    const w = await world({ satisfiable: hubWithManifest(webSearch) });
    const handle = await w.app.enqueue({
      kind: "llm.tools",
      owner: "alice",
      payload: payload({ maxToolCalls: 5 }),
    });
    const enqueue = w.sent.find((it) => it.endpoint === "enqueue");
    expect(enqueue?.body["tools"]).toEqual({
      toolsDigest: toolsDigest({
        tools: { web_search: webSearch },
        maxToolCalls: 8,
        maxToolResultChars: 32_000,
      }),
      // The job's budget for the relay to count against: the payload's 5,
      // under a purpose that allows 8.
      maxToolCalls: 5,
    });
    // Beside the stub, never in it: the stub reaches devices.
    expect(enqueue?.body["stub"]).not.toHaveProperty("tools");
    expect(enqueue?.body["stub"]).not.toHaveProperty("toolsDigest");
    expect((await w.relay.state.job(SITE_ID, handle.id))?.stub.kind).toBe(
      "llm.tools",
    );
  });

  it("is refused as tools-manifest-mismatch when one character differs, and nothing is queued", async () => {
    // The manifest of record says "Search the web for a claim."; the code
    // says it without the full stop.
    const w = await world({
      satisfiable: hubWithManifest({
        ...webSearch,
        description: `${webSearch.description}.`,
      }),
    });
    const refused = await w.app
      .enqueue({ kind: "llm.tools", owner: "alice", payload: payload() })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(refused).toBeInstanceOf(EnqueueRefused);
    expect((refused as EnqueueRefused).code).toBe("tools-manifest-mismatch");
    expect((refused as EnqueueRefused).message).toContain(
      "differ from its registered manifest",
    );
    expect(await w.relay.state.jobs()).toEqual([]);
    const claim = await w.daemon.signedFetch("claim", {
      capabilities: [toolsCapability],
      max: 1,
    });
    expect(((await claim.json()) as { jobs: unknown[] }).jobs).toEqual([]);
  });

  it("sends no tools beside any other kind", async () => {
    const w = await world();
    await w.app.enqueue({
      kind: "llm.chat",
      owner: "alice",
      payload: { messages: [{ role: "user", content: "hi" }] },
    });
    const enqueue = w.sent.find((it) => it.endpoint === "enqueue");
    expect(enqueue?.body).not.toHaveProperty("tools");
  });
});

describe("C046 the context cap — the site SDK's half", () => {
  it("classes the job by its prompt plus maxToolResultChars", async () => {
    const w = await world();
    // A prompt of 50,000 characters is `medium` alone; with 20,000
    // characters of tool results it may read, the job is `large`.
    const prompt = "x".repeat(50_000);
    expect(sizeClassOf(prompt.length)).toBe("medium");
    const handle = await w.app.enqueue({
      kind: "llm.tools",
      owner: "alice",
      payload: payload({
        messages: [{ role: "user", content: prompt }],
        purposeLimits: { maxToolCalls: 8, maxToolResultChars: 20_000 },
      }),
    });
    expect(handle.record.sizeClass).toBe("large");
    const enqueue = w.sent.find((it) => it.endpoint === "enqueue");
    expect((enqueue?.body["stub"] as { sizeClass: string }).sizeClass).toBe(
      "large",
    );
  });
});

describe("a relay that predates tools — byollm_021 R2, 0.1.5 site and 0.1.4 hub", () => {
  it("reads 404 on calls as no tools, and the rest of the cycle still runs", async () => {
    const w = await world({ absent: "calls" });
    w.app.tool("web_search", () => "never asked");
    const handle = await w.app.enqueue({
      kind: "llm.generate",
      owner: "alice",
      payload: { prompt: "past an old relay" },
    });
    let last;
    for (let i = 0; i < 100; i += 1) {
      await w.daemon.runner.tick();
      last = await w.app.pump();
      if ((await w.app.job(handle.id))?.state === "ok") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(last?.toolsUnavailable).toMatch(/carries no tools/);
    expect(last?.tools).toBeUndefined();
    expect((await w.app.result(handle.id))?.outcome).toMatchObject({
      outcome: "ok",
      text: "echo: past an old relay",
    });
  });
});
