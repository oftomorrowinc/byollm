import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JOB_KINDS } from "@byollm/protocol";
import {
  Budgets,
  ClientError,
  DaemonConfig,
  DeviceIdentity,
  IngressLog,
  KINDS_AFTER_0_1_4,
  ProtocolClient,
  Runner,
  SpendLedger,
  connect,
  resolveConfig,
  type Backend,
  type BackendRequest,
  type BackendResult,
  type ConverseRequest,
  type ConverseResult,
  type RunnerEvent,
} from "byollm";
import { JOB_KINDS as JOB_KINDS_014 } from "byollm-protocol-0.1.4";
import {
  ByollmApp,
  MemoryStore,
  createFetchHandler,
  generateSiteKeys,
} from "byollm-server-0.1.4";
import { afterEach, describe, expect, it } from "vitest";

/**
 * C060 — guard (b), byollm_021 §Rollout R2, against the real thing.
 *
 * The 0.1.4 reference server **as published on npm** (`@byollm/server@0.1.4`,
 * installed under an alias so it cannot be confused with this tree's), and a
 * 0.1.5 daemon with `llm.tools` and `llm.vision` turned on. Not a double of a
 * 0.1.4 server: a double would refuse whatever its author thought 0.1.4
 * refuses, and agreement needs the other end's own parser.
 *
 * (The brief for #7055 calls this C066; byollm_021 §10 renumbered it to C060
 * in #7053, and the spec wins.)
 *
 * Two cases, because the guard has two halves:
 *
 * 1. the heartbeat is refused only for the new kinds — the retry without them
 *    succeeds, the daemon says the upstream predates them and names it, and
 *    `llm.chat` jobs keep running;
 * 2. the heartbeat is malformed for another reason — the retry is refused
 *    too, and the daemon reports the original refusal and blames no version.
 */

const ORIGIN = "https://old-upstream.byollm.test";

/** A model that answers chat and passes the tool probe — a capable service. */
class CapableBackend implements Backend {
  readonly stopReasons = {
    kind: "unavailable" as const,
    why: "a test double reads no vendor signal",
  };
  readonly id = "openai-http" as const;
  readonly class = "http" as const;
  health(): Promise<{ healthy: boolean; models: string[] }> {
    return Promise.resolve({ healthy: true, models: ["m"] });
  }
  execute(request: BackendRequest): Promise<BackendResult> {
    return Promise.resolve({
      ok: true,
      text: `echo: ${request.prompt}`,
      durationMs: 1,
    });
  }
  converse(request: ConverseRequest): Promise<ConverseResult> {
    const answered = request.messages.find((m) => m.role === "tool");
    return Promise.resolve(
      answered === undefined
        ? {
            ok: true,
            text: "",
            toolCalls: [
              { id: "c1", name: "echo_number", arguments: '{"n":7}' },
            ],
            stop: "unknown",
            durationMs: 1,
          }
        : {
            ok: true,
            text: /\d{4}/.exec(answered.content)?.[0] ?? "",
            toolCalls: [],
            stop: "end",
            durationMs: 1,
          },
    );
  }
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

/** A 0.1.5 daemon paired with the 0.1.4 server, every heartbeat recorded. */
async function againstTheOldServer(options: { daemonVersion?: string } = {}) {
  const siteKeys = generateSiteKeys();
  const store = new MemoryStore({ defaultTtlMs: 60_000 });
  const app = new ByollmApp({ store, siteKeys });
  const handler = createFetchHandler({
    store,
    verificationUrl: `${ORIGIN}/settings/runners`,
    siteKeys,
    leaseMs: 30_000,
  });
  const heartbeats: { status: number; kinds: string[] }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = request.url.endsWith("/heartbeat")
      ? ((await request.clone().json()) as { capabilities: { kind: string }[] })
      : undefined;
    const response = await handler(request);
    if (body !== undefined) {
      heartbeats.push({
        status: response.status,
        kinds: body.capabilities.map((c) => c.kind),
      });
    }
    return response;
  };

  const home = await mkdtemp(join(tmpdir(), "byollm-guard-b-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const loaded = resolveConfig(
    DaemonConfig.parse({
      services: {
        qwen: {
          model: "m",
          // `llm.vision` is not served by this build yet, so config withholds
          // it; the guard has to handle whatever the advertisement carries.
          kinds: ["llm.chat", "llm.tools", "llm.vision"],
          type: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
      },
    }),
  );
  const identity = new DeviceIdentity(join(home, "keys.json"));
  let userCode = "";
  const pairing = connect({
    client: new ProtocolClient({ origin: ORIGIN, fetch: fetchImpl }),
    daemonVersion: "0.1.5",
    device: await identity.publicIdentity(Date.now()),
    label: "guard-b",
    // What a 0.1.5 daemon pairs with: 0.1.4's kinds only, as pairing does
    // not yet carry the probe's verdict.
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
    daemonVersion: options.daemonVersion ?? "0.1.5",
    loaded,
    budgets,
    spend,
    ingress: new IngressLog({
      path: join(home, "ingress.log"),
      communityPromptDays: 7,
      keepSelfPrompts: true,
    }),
    backendFactory: () => new CapableBackend(),
    onEvent: (event) => events.push(event),
  });
  cleanup.push(() => {
    runner.cancelAll();
    return Promise.resolve();
  });
  return { app, runner, heartbeats, events, owner: paired.pairing.owner };
}

describe("C060 guard (b): a 0.1.5 daemon against the 0.1.4 reference server from npm", () => {
  it("names the same kinds the published 0.1.4 protocol lacks", () => {
    // The guard's list, derived from the other end's own vocabulary.
    expect([...KINDS_AFTER_0_1_4]).toEqual(
      JOB_KINDS.filter(
        (kind) => !(JOB_KINDS_014 as readonly string[]).includes(kind),
      ),
    );
  });

  it("re-sends without the new kinds, names the upstream, and keeps running llm.chat", async () => {
    const old = await againstTheOldServer();

    await old.runner.tick();

    // The precondition, observed rather than assumed: the published 0.1.4
    // server refused the heartbeat that advertised llm.tools.
    expect(old.heartbeats[0]).toEqual({
      status: 400,
      kinds: ["llm.chat", "llm.tools"],
    });
    // The retry, with only the new kind taken out, was accepted.
    expect(old.heartbeats[1]).toEqual({ status: 200, kinds: ["llm.chat"] });
    const said = old.events.filter((e) => e.type === "upstream-predates-kinds");
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({
      upstream: ORIGIN,
      kinds: ["llm.tools"],
      services: ["qwen"],
      message:
        `${ORIGIN} runs byollm 0.1.4 or older and cannot carry the site's ` +
        "tools — update it, or turn tools off for `qwen`",
    });

    // Remembered for the session: the next heartbeat goes out without it,
    // first time, and an llm.chat job is claimed and runs.
    const job = await old.app.enqueue({
      kind: "llm.chat",
      payload: { messages: [{ role: "user", content: "still here?" }] },
      owner: old.owner,
    });
    for (let i = 0; i < 50; i += 1) {
      await old.runner.tick();
      if ((await old.app.job(job.id))?.state === "ok") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const record = await old.app.job(job.id);
    expect(record?.state).toBe("ok");
    expect(record?.outcome).toMatchObject({ outcome: "ok" });
    expect(old.heartbeats.slice(2).every((h) => h.status === 200)).toBe(true);
    expect(
      old.heartbeats.slice(2).every((h) => !h.kinds.includes("llm.tools")),
    ).toBe(true);
    expect(
      old.events.filter((e) => e.type === "upstream-predates-kinds"),
    ).toHaveLength(1);
  });

  it("blames no version when the heartbeat is malformed for another reason", async () => {
    // `daemonVersion` must be non-empty on every version of the protocol, so
    // this heartbeat is refused with or without the new kinds.
    const old = await againstTheOldServer({ daemonVersion: "" });

    const thrown = await old.runner.tick().then(
      () => undefined,
      (error: unknown) => error,
    );

    // The retry was made — the guard ran — and was refused too.
    expect(old.heartbeats.map((h) => h.status)).toEqual([400, 400]);
    expect(old.heartbeats[1]?.kinds).toEqual(["llm.chat"]);
    // So the ORIGINAL refusal is what is reported, and no version is blamed.
    expect(thrown).toBeInstanceOf(ClientError);
    expect((thrown as ClientError).status).toBe(400);
    expect((thrown as ClientError).message).not.toContain("0.1.4");
    expect(
      old.events.filter((e) => e.type === "upstream-predates-kinds"),
    ).toEqual([]);
  });
});
