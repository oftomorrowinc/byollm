import {
  keyId,
  publicIdentityOf,
  seal,
  generateKeys,
  signRequest,
} from "@byollm/protocol";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Allowlist } from "./allowlist.js";
import { OpenAiHttpBackend } from "./backends/openai-http.js";
import type {
  Backend,
  BackendRequest,
  BackendResult,
} from "./backends/index.js";
import { Budgets } from "./budgets.js";
import { ProtocolClient } from "./client.js";
import { DaemonConfig, resolveConfig } from "./config.js";
import { IngressLog } from "./ingress.js";
import { SpendLedger } from "./spend.js";
import { Runner, type RunnerEvent } from "./runner.js";
import { removeTemp } from "./test-support.js";

/**
 * A site and a device, as pairing would have established them.
 *
 * The fakes seal work exactly as a real site does, so these exercise the
 * daemon's verification rather than skipping past it — a fake that handed
 * over plaintext would test nothing about the property that matters.
 */
const TEST_SITE_KEYS = generateKeys(1_800_000_000_000);
/**
 * The site a stub names — Amendment A §A.3.
 *
 * Derived from the same keys the daemon pins rather than written as a
 * literal, because the daemon now refuses a stub naming a site it did not
 * pair with. A fixed string here would refuse every job in this file, which
 * is the check doing exactly what it is for.
 */
const TEST_SITE_ID = keyId(publicIdentityOf(TEST_SITE_KEYS).identity);

/** The set a heartbeat carries — cloud_009 §5. One entry is a site. */
const HEARTBEAT_SITES = {
  [TEST_SITE_ID]: publicIdentityOf(TEST_SITE_KEYS),
};
const TEST_DEVICE_KEYS = generateKeys(1_800_000_000_000);
const TEST_IDENTITY = {
  keys: () => Promise.resolve(TEST_DEVICE_KEYS),
  sites: new Map([[TEST_SITE_ID, publicIdentityOf(TEST_SITE_KEYS)]]),
};

/** Seal a payload to the test device, as the site would at fetch time. */
async function sealedFor(
  jobId: string,
  payload: unknown,
  senderKeys = TEST_SITE_KEYS,
): Promise<unknown> {
  return seal({
    plaintext: JSON.stringify(payload),
    senderKeys,
    recipientEncryptionPublic: TEST_DEVICE_KEYS.encryptionPublic,
    context: {
      jobId,
      senderKeyId: keyId(publicIdentityOf(TEST_SITE_KEYS).identity),
      recipientKeyId: keyId(publicIdentityOf(TEST_DEVICE_KEYS).identity),
      deadlineAt: Date.now() + 3_600_000,
      direction: "payload",
    },
  });
}

/** A daemon identity for tests: real keys, signing the real canonical form. */
const TEST_KEYS = generateKeys(1_800_000_000_000);
const TEST_SIGNER = {
  runnerId: "runner_1",
  sign: (input: {
    endpoint: string;
    runnerId: string;
    issuedAt: number;
    body: string;
  }) => signRequest(TEST_KEYS, input).signature,
};

/**
 * The loop's own behaviour: what it does with a heartbeat that says stop, a
 * server that is not answering, and a claim it must refuse.
 */

class StubBackend implements Backend {
  readonly id = "openai-http" as const;
  readonly class = "http" as const;
  readonly seen: string[] = [];
  health(): Promise<{ healthy: boolean; models: string[] }> {
    return Promise.resolve({ healthy: true, models: ["m"] });
  }
  execute(request: BackendRequest): Promise<BackendResult> {
    this.seen.push(request.prompt);
    return Promise.resolve({ ok: true, text: "ok", durationMs: 1 });
  }
}

let dir: string;
let backend: StubBackend;
let events: RunnerEvent[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-loop-"));
  backend = new StubBackend();
  events = [];
});

afterEach(async () => {
  await removeTemp(dir);
});

async function makeRunner(fetchImpl: typeof fetch, owner = "me") {
  const loaded = resolveConfig(
    DaemonConfig.parse({
      backends: {
        primary: {
          backend: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
          offer: "self",
        },
      },
      routes: { "llm.generate": { backend: "primary", model: "m" } },
      concurrency: 2,
    }),
  );
  const allowlist = new Allowlist(join(dir, "allow.json"));
  await allowlist.load();
  const budgets = new Budgets(join(dir, "b.json"), loaded.config.community);
  await budgets.load(Date.now());
  const spend = new SpendLedger(join(dir, "spend.json"));
  await spend.load(Date.now());

  return new Runner({
    client: new ProtocolClient({
      origin: "https://app.test",
      identity: TEST_SIGNER,
      fetch: fetchImpl,
    }),
    runnerId: "runner_1",
    identity: TEST_IDENTITY,
    owner,
    daemonVersion: "0.0.0",
    loaded,
    allowlist,
    budgets,
    spend,
    ingress: new IngressLog({
      path: join(dir, "ingress.log"),
      communityPromptDays: 7,
      keepSelfPrompts: true,
    }),
    backendFactory: () => backend,
    heartbeatMs: 5,
    onEvent: (event) => events.push(event),
  });
}

/** Answers each endpoint from a script. */
/**
 * Wait for a condition rather than a duration.
 *
 * A fixed sleep encodes an assumption about how many round trips the protocol
 * takes. Claim-then-fetch added one, and the sleeps that had been comfortable
 * became marginal on a loaded runner — which is how a platform matrix earns
 * its keep, and also how it stops being trusted if left flaky.
 */
async function settles(
  predicate: () => boolean,
  what: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function routed(responses: {
  heartbeat?: unknown;
  claim?: unknown;
  fetch?: unknown;
  result?: unknown;
  release?: unknown;
}): typeof fetch {
  return async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    const endpoint = url.split("/").pop() ?? "";
    const body =
      endpoint === "fetch"
        ? // Sealed to the device, as a real site does. A fake handing over
          // plaintext would skip the verification this exercises.
          (responses.fetch ?? {
            envelope: await sealedFor("job_1", { prompt: "hi" }),
          })
        : endpoint === "heartbeat"
          ? (responses.heartbeat ?? {
              sites: HEARTBEAT_SITES,
              awaitingConsent: [],
              cancel: [],
              lost: [],
              serverTime: Date.now(),
            })
          : endpoint === "claim"
            ? (responses.claim ?? { jobs: [], leaseMs: 60_000 })
            : endpoint === "result"
              ? (responses.result ?? { accepted: true, state: "ok" })
              : (responses.release ?? { released: [] });
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  };
}

describe("the loop", () => {
  it("heartbeats and claims nothing when there is nothing to claim", async () => {
    const runner = await makeRunner(routed({}));
    await runner.tick();
    expect(events.filter((e) => e.type === "heartbeat")).toHaveLength(1);
    expect(backend.seen).toEqual([]);
  });

  it("says it is waiting on the user, once, and resumes when they have read it", async () => {
    // cloud_008 finding 48's daemon end. The relay does not emit this field
    // yet — it is the accept half of a two-release change — so this is the
    // only place the handling is exercised, and it is worth having early:
    // the alternative to a message is a machine that quietly receives no work
    // and an owner with no idea why.
    let awaiting = true;
    const fetchImpl: typeof fetch = (input) => {
      const url = String(input instanceof Request ? input.url : input);
      const endpoint = url.split("/").pop() ?? "";
      const body =
        endpoint === "heartbeat"
          ? {
              sites: HEARTBEAT_SITES,
              awaitingConsent: awaiting ? [TEST_SITE_ID] : [],
              cancel: [],
              lost: [],
              serverTime: Date.now(),
            }
          : endpoint === "claim"
            ? { jobs: [], leaseMs: 60_000 }
            : { released: [] };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        }),
      );
    };

    const runner = await makeRunner(fetchImpl);
    await runner.tick();
    await runner.tick();

    // Once, not once per heartbeat: a line repeated every few seconds is a
    // line nobody reads.
    const waiting = events.filter((e) => e.type === "awaiting-consent");
    expect(waiting).toHaveLength(1);
    // It names the site, so the user knows which terms to go and read —
    // cloud_008 finding 48, cloud_009 §5's set.
    expect(waiting[0]).toMatchObject({ sites: [TEST_SITE_ID] });
    // Still running, unlike `revoked` — which stops the loop and, in the CLI,
    // deletes the pairing. That difference is the whole point of the state.
    expect(events.filter((e) => e.type === "revoked")).toEqual([]);
    expect(events.filter((e) => e.type === "heartbeat")).toHaveLength(2);

    awaiting = false;
    await runner.tick();
    expect(events.filter((e) => e.type === "consent-resumed")).toHaveLength(1);
  });

  it("stops and reports itself revoked when the heartbeat says so", async () => {
    const runner = await makeRunner(
      routed({
        heartbeat: {
          sites: {},
          awaitingConsent: [],
          cancel: [],
          lost: [],
          serverTime: Date.now(),
        },
      }),
    );
    await runner.tick();
    expect(runner.status().revoked).toBe(true);
    expect(events.some((e) => e.type === "revoked")).toBe(true);
  });

  it("claims nothing while paused", async () => {
    const runner = await makeRunner(
      routed({
        claim: {
          jobs: [
            {
              id: "job_1",
              kind: "llm.generate",
              audience: "self",
              owner: "me",
              site: TEST_SITE_ID,
              sizeClass: "small",
              streaming: false,
              deadlineAt: Date.now() + 60_000,
              lease: {
                id: "lease_test",
                runnerId: "runner_1",
                identity: TEST_IDENTITY,
                expiresAt: Date.now() + 60_000,
              },
            },
          ],
          leaseMs: 60_000,
        },
      }),
    );
    runner.pause();
    await runner.tick();
    expect(backend.seen).toEqual([]);
  });

  it("refuses a stub naming a site it did not pair with", async () => {
    // Amendment A §A.3's daemon half. `stub.site` is the site's identity key
    // id precisely so a daemon can check it against the key it pinned, with no
    // lookup and without trusting whoever routed the job.
    //
    // Redundant with one pinned key — `open` would refuse the envelope anyway
    // — and the redundancy is the reason to test it now rather than later.
    // With two pinned keys (cloud_009) the wrong one is the *silent* failure:
    // a payload from site B verified against site A's key fails to open and
    // reports as a corrupt envelope, which sends somebody looking at their
    // crypto instead of their routing. This is what turns that into a
    // sentence naming both sites.
    const runner = await makeRunner(
      routed({
        claim: {
          jobs: [
            {
              id: "job_1",
              kind: "llm.generate",
              audience: "self",
              owner: "me",
              site: "BYOLLM-A-SITE-THIS-MACHINE-NEVER-PAIRED-WITH",
              sizeClass: "small",
              streaming: false,
              deadlineAt: Date.now() + 60_000,
              lease: {
                id: "lease_test",
                runnerId: "runner_1",
                identity: TEST_IDENTITY,
                expiresAt: Date.now() + 60_000,
              },
            },
          ],
          leaseMs: 60_000,
        },
      }),
    );

    await runner.tick();
    await settles(
      () => events.some((e) => e.type === "refused"),
      "the daemon to refuse the job",
    );

    // The backend never saw it — a refusal that still ran the work would be
    // no refusal at all.
    expect(backend.seen).toEqual([]);
    // And the message names both sites, because "refused" alone is what makes
    // this class of failure take an afternoon.
    //
    // It arrives as `refused` rather than `error` since V1-1: admission now
    // asks whether this machine serves the site, so the job is released
    // before its payload is fetched. It used to travel all the way to the
    // seal and throw — a refusal that had already paid for the answer.
    const reason =
      events.find(
        (e): e is RunnerEvent & { type: "refused"; reason: string } =>
          e.type === "refused",
      )?.reason ?? "";
    expect(reason).toContain("BYOLLM-A-SITE-THIS-MACHINE-NEVER-PAIRED-WITH");
    expect(reason).toContain(TEST_SITE_ID);
  });

  it("runs a claimed job and reports it", async () => {
    const runner = await makeRunner(
      routed({
        claim: {
          jobs: [
            {
              id: "job_1",
              kind: "llm.generate",
              audience: "self",
              owner: "me",
              site: TEST_SITE_ID,
              sizeClass: "small",
              streaming: false,
              deadlineAt: Date.now() + 60_000,
              lease: {
                id: "lease_test",
                runnerId: "runner_1",
                identity: TEST_IDENTITY,
                expiresAt: Date.now() + 60_000,
              },
            },
          ],
          leaseMs: 60_000,
        },
      }),
    );
    await runner.tick();
    // Wait on the *last* thing to happen, not the first. Waiting for the
    // backend call and then asserting the finished event leaves the same race
    // the fixed sleep had — which is how this failed on Windows after the
    // sleep was replaced.
    await settles(
      () => events.some((e) => e.type === "finished"),
      "the job to finish",
    );
    expect(backend.seen).toEqual(["hi"]);
  });

  it("refuses and releases a job its allowlist does not admit", async () => {
    const runner = await makeRunner(
      routed({
        claim: {
          jobs: [
            {
              id: "job_1",
              kind: "llm.generate",
              audience: "public",
              owner: "stranger",
              site: TEST_SITE_ID,
              sizeClass: "small",
              streaming: false,
              deadlineAt: Date.now() + 60_000,
              lease: {
                id: "lease_test",
                runnerId: "runner_1",
                identity: TEST_IDENTITY,
                expiresAt: Date.now() + 60_000,
              },
            },
          ],
          leaseMs: 60_000,
        },
      }),
    );
    await runner.tick();
    await settles(
      () => events.some((e) => e.type === "refused"),
      "the job to be refused",
    );

    expect(backend.seen).toEqual([]);
    expect(runner.status().refused).toBe(1);
  });

  it("surfaces an unreachable server as its last error, and keeps going", async () => {
    const runner = await makeRunner(() =>
      Promise.reject(new Error("ECONNREFUSED")),
    );
    const controller = new AbortController();
    const running = runner.run(controller.signal);
    await settles(
      () => runner.status().lastError !== undefined,
      "the unreachable server to be reported",
    );
    controller.abort();
    await running;

    expect(runner.status().lastError).toContain("could not reach");
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("ends the loop when the server says revoked", async () => {
    const runner = await makeRunner(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: "revoked", message: "revoked by owner" }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    // The loop returns on its own rather than retrying forever.
    await runner.run(new AbortController().signal);
    expect(runner.status().revoked).toBe(true);
  });

  it("releases what it holds on shutdown", async () => {
    let releaseBody: string | undefined;
    const runner = await makeRunner((input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/release") && typeof init?.body === "string") {
        releaseBody = init.body;
      }
      return routed({})(input, init);
    });
    // Nothing held, so nothing to release — and no spurious call either.
    await runner.shutdown("shutdown");
    expect(releaseBody).toBeUndefined();
  });
});

describe("openai-http against a real socket", () => {
  let server: Server;
  let baseUrl: string;
  let handler: (url: string) => { status: number; body: string };

  beforeEach(async () => {
    handler = () => ({ status: 200, body: "{}" });
    server = createServer((req, res) => {
      const { status, body } = handler(req.url ?? "");
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    // Deliberately no trailing slash: the endpoint builder must add one.
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  it("reports an unhealthy model list with its status", async () => {
    handler = () => ({ status: 503, body: "{}" });
    const health = await new OpenAiHttpBackend({ baseUrl }).health();
    expect(health.healthy).toBe(false);
    expect(health.detail).toContain("503");
  });

  it("reports an empty model list rather than failing", async () => {
    handler = () => ({ status: 200, body: JSON.stringify({ data: [] }) });
    const health = await new OpenAiHttpBackend({ baseUrl }).health();
    expect(health).toMatchObject({ healthy: true, models: [] });
  });

  it("ignores malformed entries in a model list", async () => {
    handler = () => ({
      status: 200,
      body: JSON.stringify({ data: [{ id: "good" }, {}, 5, null] }),
    });
    expect((await new OpenAiHttpBackend({ baseUrl }).health()).models).toEqual([
      "good",
    ]);
  });

  it("treats a 5xx on a job as retryable and a 4xx as not", async () => {
    const backendUnderTest = new OpenAiHttpBackend({ baseUrl });
    const call = () =>
      backendUnderTest.execute({
        prompt: "hi",
        model: "m",
        timeoutMs: 5_000,
        maxOutputBytes: 4096,
        signal: new AbortController().signal,
      });

    handler = () => ({ status: 503, body: "{}" });
    const server5xx = await call();
    expect(server5xx.ok).toBe(false);
    if (!server5xx.ok) expect(server5xx.retryable).toBe(true);

    handler = () => ({ status: 418, body: "{}" });
    const client4xx = await call();
    expect(client4xx.ok).toBe(false);
    if (!client4xx.ok) expect(client4xx.retryable).toBe(false);
  });

  it("reports a body that is not JSON as a backend error", async () => {
    handler = () => ({ status: 200, body: "not json at all" });
    const result = await new OpenAiHttpBackend({ baseUrl }).execute({
      prompt: "hi",
      model: "m",
      timeoutMs: 5_000,
      maxOutputBytes: 4096,
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("backend-error");
  });

  it.each([
    ["no choices", JSON.stringify({ choices: [] })],
    ["a choice with no message", JSON.stringify({ choices: [{}] })],
    [
      "a message with no text",
      JSON.stringify({ choices: [{ message: { role: "assistant" } }] }),
    ],
    ["an array at the top level", JSON.stringify([1, 2, 3])],
  ])(
    "reports %s as a backend error rather than guessing",
    async (_name, body) => {
      handler = () => ({ status: 200, body });
      const result = await new OpenAiHttpBackend({ baseUrl }).execute({
        prompt: "hi",
        model: "m",
        timeoutMs: 5_000,
        maxOutputBytes: 4096,
        signal: new AbortController().signal,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("backend-error");
    },
  );

  it("succeeds against a well-formed response", async () => {
    handler = (url) =>
      url.endsWith("/models")
        ? { status: 200, body: JSON.stringify({ data: [{ id: "m" }] }) }
        : {
            status: 200,
            body: JSON.stringify({
              choices: [{ message: { role: "assistant", content: "hello" } }],
            }),
          };
    const result = await new OpenAiHttpBackend({ baseUrl }).execute({
      prompt: "hi",
      model: "m",
      timeoutMs: 5_000,
      maxOutputBytes: 4096,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ ok: true, text: "hello" });
  });

  it("works with a base URL that already ends in a slash", async () => {
    handler = () => ({ status: 200, body: JSON.stringify({ data: [] }) });
    const health = await new OpenAiHttpBackend({
      baseUrl: `${baseUrl}/`,
    }).health();
    expect(health.healthy).toBe(true);
  });
});
