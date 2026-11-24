import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Budgets,
  DaemonConfig,
  DeviceIdentity,
  IngressLog,
  ProtocolClient,
  Runner,
  SpendLedger,
  connect,
  resolveConfig,
  type Backend,
  type BackendRequest,
  type BackendResult,
  type RunnerEvent,
} from "byollm";
import {
  ByollmApp,
  MemoryStore,
  createFetchHandler,
  generateSiteKeys,
} from "byollm-server-0.1.7";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Guard (c), #10825 — a daemon that sends `paused`, against the 0.1.7
 * reference server **as published on npm**.
 *
 * The red-team question on the card: `HeartbeatRequest` is strict, so every
 * upstream built before `paused` refuses a key it does not know. A person's
 * daemon updates itself to the release that sends it while their site's
 * server is still on 0.1.7. Does the device go dark?
 *
 * Asked of the other end's own parser rather than a double of it. What it
 * answers is recorded below in the assertions, and the answer is: a `400`,
 * every time `paused` is non-empty — and, with the guard, nothing else
 * changes. The heartbeat is re-sent without the list, accepted, and the
 * device keeps serving every service that is not paused.
 */

const ORIGIN = "https://old-upstream.byollm.test";
const BACK_AT = Date.now() + 3_600_000;

/** `codex` is out of allowance; `local` answers. */
function backendFor(service: string): Backend {
  return {
    stopReasons: {
      kind: "unavailable" as const,
      why: "a test double reads no vendor signal",
    },
    id: "openai-http" as const,
    class: "http" as const,
    health: () => Promise.resolve({ healthy: true, models: ["m"] }),
    execute: (request: BackendRequest): Promise<BackendResult> =>
      Promise.resolve(
        service === "codex"
          ? {
              ok: false,
              code: "quota-exhausted",
              message: "the codex CLI failed: You've hit your usage limit",
              durationMs: 1,
              until: BACK_AT,
            }
          : { ok: true, text: `echo: ${request.prompt}`, durationMs: 1 },
      ),
  };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

async function againstTheOldServer() {
  const siteKeys = generateSiteKeys();
  const store = new MemoryStore({ defaultTtlMs: 60_000 });
  const app = new ByollmApp({ store, siteKeys });
  const handler = createFetchHandler({
    store,
    verificationUrl: `${ORIGIN}/settings/runners`,
    siteKeys,
    leaseMs: 30_000,
  });
  const heartbeats: { status: number; paused: unknown; answer: unknown }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = request.url.endsWith("/heartbeat")
      ? ((await request.clone().json()) as { paused?: unknown })
      : undefined;
    const response = await handler(request);
    if (body !== undefined) {
      heartbeats.push({
        status: response.status,
        paused: body.paused,
        answer:
          response.status === 200 ? undefined : await response.clone().json(),
      });
    }
    return response;
  };

  const home = await mkdtemp(join(tmpdir(), "byollm-guard-c-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const loaded = resolveConfig(
    DaemonConfig.parse({
      services: {
        codex: {
          model: "m",
          kinds: ["llm.chat"],
          type: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
        local: {
          model: "m",
          kinds: ["llm.generate"],
          type: "openai-http",
          baseUrl: "http://127.0.0.1:1234/v1",
        },
      },
    }),
  );
  const identity = new DeviceIdentity(join(home, "keys.json"));
  let userCode = "";
  const pairing = connect({
    client: new ProtocolClient({ origin: ORIGIN, fetch: fetchImpl }),
    daemonVersion: "0.1.8",
    device: await identity.publicIdentity(Date.now()),
    label: "guard-c",
    capabilities: [],
    onCode: (info) => {
      userCode = info.userCode;
    },
    sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
  });
  while (userCode === "")
    await new Promise((resolve) => setTimeout(resolve, 1));
  await app.approvePairing({ userCode, owner: "alice" });
  const paired = await pairing;
  if (!paired.ok) throw new Error(`could not pair: ${paired.message}`);

  const events: RunnerEvent[] = [];
  const budgets = new Budgets(join(home, "b.json"), loaded.config.community);
  await budgets.load(Date.now());
  const spend = new SpendLedger(join(home, "s.json"));
  await spend.load(Date.now());
  const runner = new Runner({
    client: new ProtocolClient({
      origin: ORIGIN,
      identity: {
        runnerId: paired.pairing.runnerId,
        sign: (input) => identity.signRequest(input),
      },
      fetch: fetchImpl,
    }),
    runnerId: paired.pairing.runnerId,
    owner: paired.pairing.owner,
    identity: {
      keys: () => identity.load(Date.now()),
      sites: new Map(Object.entries(paired.pairing.sites)),
    },
    daemonVersion: "0.1.8",
    loaded,
    budgets,
    spend,
    ingress: new IngressLog({
      path: join(home, "ingress.log"),
      communityPromptDays: 7,
      keepSelfPrompts: true,
    }),
    backendFactory: (route) => backendFor(route.service),
    onEvent: (event) => events.push(event),
  });
  cleanup.push(() => {
    runner.cancelAll();
    return Promise.resolve();
  });
  return { app, runner, heartbeats, events, owner: paired.pairing.owner };
}

async function settle(
  old: Awaited<ReturnType<typeof againstTheOldServer>>,
  jobId: string,
) {
  for (let i = 0; i < 50; i += 1) {
    await old.runner.tick();
    const state = (await old.app.job(jobId))?.state;
    if (state === "ok" || state === "error") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return old.app.job(jobId);
}

describe("guard (c): a daemon that sends `paused`, against the 0.1.7 reference server from npm", () => {
  it("is refused 400 for the list alone, re-sends without it, and keeps serving the rest", async () => {
    const old = await againstTheOldServer();

    // Nothing paused: the heartbeat every 0.1.7 upstream already parses.
    await old.runner.tick();
    expect(old.heartbeats[0]).toMatchObject({ status: 200, paused: undefined });

    // Codex's allowance runs out on a real job.
    const chat = await old.app.enqueue({
      kind: "llm.chat",
      payload: { messages: [{ role: "user", content: "hi" }] },
      owner: old.owner,
    });
    expect((await settle(old, chat.id))?.state).toBe("error");

    // The next beat carries the list. What 0.1.7 answers, observed: a fixed
    // 400 that names no field. The retry without it is accepted.
    await old.runner.tick();
    const refused = old.heartbeats.findIndex((h) => h.paused !== undefined);
    expect(refused).toBeGreaterThan(0);
    expect(old.heartbeats[refused]).toEqual({
      status: 400,
      paused: [{ service: "codex", why: "allowance", until: BACK_AT }],
      answer: {
        error: "bad-request",
        message: "request body failed schema validation",
      },
    });
    expect(old.heartbeats[refused + 1]).toMatchObject({
      status: 200,
      paused: undefined,
    });
    expect(
      old.events.filter((e) => e.type === "upstream-predates-paused"),
    ).toEqual([
      {
        type: "upstream-predates-paused",
        upstream: ORIGIN,
        services: ["codex"],
      },
    ]);

    // Not dark: the service that is not paused claims and runs.
    const generate = await old.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "still here?" },
      owner: old.owner,
    });
    const record = await settle(old, generate.id);
    expect(record?.state).toBe("ok");
    // And the list stays off every later beat to this upstream.
    expect(
      old.heartbeats
        .slice(refused + 1)
        .every((h) => h.status === 200 && h.paused === undefined),
    ).toBe(true);
  });
});
