import { generateKeys, signRequest } from "@byollm/protocol";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
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
  await rm(dir, { recursive: true, force: true });
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
function routed(responses: {
  heartbeat?: unknown;
  claim?: unknown;
  result?: unknown;
  release?: unknown;
}): typeof fetch {
  return (input) => {
    const url = String(input instanceof Request ? input.url : input);
    const endpoint = url.split("/").pop() ?? "";
    const body =
      endpoint === "heartbeat"
        ? (responses.heartbeat ?? {
            revoked: false,
            cancel: [],
            leases: [],
            lost: [],
            serverTime: Date.now(),
          })
        : endpoint === "claim"
          ? (responses.claim ?? { jobs: [], leaseMs: 60_000 })
          : endpoint === "result"
            ? (responses.result ?? { accepted: true, state: "ok" })
            : (responses.release ?? { released: [] });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

describe("the loop", () => {
  it("heartbeats and claims nothing when there is nothing to claim", async () => {
    const runner = await makeRunner(routed({}));
    await runner.tick();
    expect(events.filter((e) => e.type === "heartbeat")).toHaveLength(1);
    expect(backend.seen).toEqual([]);
  });

  it("stops and reports itself revoked when the heartbeat says so", async () => {
    const runner = await makeRunner(
      routed({
        heartbeat: {
          revoked: true,
          cancel: [],
          leases: [],
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
              payload: { prompt: "hi" },
              audience: "self",
              owner: "me",
              lease: {
                id: "lease_test",
                runnerId: "runner_1",
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

  it("runs a claimed job and reports it", async () => {
    const runner = await makeRunner(
      routed({
        claim: {
          jobs: [
            {
              id: "job_1",
              kind: "llm.generate",
              payload: { prompt: "hi" },
              audience: "self",
              owner: "me",
              lease: {
                id: "lease_test",
                runnerId: "runner_1",
                expiresAt: Date.now() + 60_000,
              },
            },
          ],
          leaseMs: 60_000,
        },
      }),
    );
    await runner.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(backend.seen).toEqual(["hi"]);
    expect(events.some((e) => e.type === "finished")).toBe(true);
  });

  it("refuses and releases a job its allowlist does not admit", async () => {
    const runner = await makeRunner(
      routed({
        claim: {
          jobs: [
            {
              id: "job_1",
              kind: "llm.generate",
              payload: { prompt: "hi" },
              audience: "public",
              owner: "stranger",
              lease: {
                id: "lease_test",
                runnerId: "runner_1",
                expiresAt: Date.now() + 60_000,
              },
            },
          ],
          leaseMs: 60_000,
        },
      }),
    );
    await runner.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(backend.seen).toEqual([]);
    expect(events.some((e) => e.type === "refused")).toBe(true);
    expect(runner.status().refused).toBe(1);
  });

  it("surfaces an unreachable server as its last error, and keeps going", async () => {
    const runner = await makeRunner(() =>
      Promise.reject(new Error("ECONNREFUSED")),
    );
    const controller = new AbortController();
    const running = runner.run(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 40));
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
