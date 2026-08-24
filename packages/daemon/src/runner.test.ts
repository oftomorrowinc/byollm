import {
  type ClaimedStub,
  type JobPayload,
  generateKeys,
  signRequest,
} from "@byollm/protocol";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Allowlist } from "./allowlist.js";
import type {
  Backend,
  BackendRequest,
  BackendResult,
} from "./backends/index.js";
import { Budgets } from "./budgets.js";
import { ProtocolClient } from "./client.js";
import { composePrompt } from "./compose.js";
import { DaemonConfig, resolveConfig } from "./config.js";
import { IngressLog } from "./ingress.js";
import { SpendLedger } from "./spend.js";
import { Runner } from "./runner.js";
import { removeTemp } from "./test-support.js";

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

/** A backend that records what it was asked to run. */
class SpyBackend implements Backend {
  readonly id = "openai-http" as const;
  readonly class = "http" as const;
  readonly seen: string[] = [];
  healthy = true;
  models: string[] = ["m"];
  hang = false;

  health(): Promise<{ healthy: boolean; models: string[] }> {
    return Promise.resolve({ healthy: this.healthy, models: this.models });
  }

  async execute(request: BackendRequest): Promise<BackendResult> {
    this.seen.push(request.prompt);
    if (this.hang) {
      // `aborted` first: a signal that has already fired never calls a
      // listener added afterwards. The real backends check the same way.
      if (!request.signal.aborted) {
        await new Promise<void>((resolve) => {
          request.signal.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
        });
      }
      return {
        ok: false,
        code: "canceled",
        message: "the job was canceled",
        retryable: false,
        durationMs: 0,
      };
    }
    return { ok: true, text: `echo: ${request.prompt}`, durationMs: 1 };
  }
}

let dir: string;
let backend: SpyBackend;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-runner-"));
  backend = new SpyBackend();
});

afterEach(async () => {
  await removeTemp(dir);
});

async function makeRunner(
  options: {
    owner?: string;
    offer?: "self" | "named" | "public";
    subscription?: boolean;
    allow?: readonly string[];
  } = {},
) {
  const loaded = resolveConfig(
    DaemonConfig.parse({
      services: {
        primary: {
          model: "m",
          kinds: ["llm.generate"],
          type: options.subscription === true ? "claude-cli" : "openai-http",
          ...(options.subscription === true
            ? {}
            : { baseUrl: "http://127.0.0.1:11434/v1" }),
          offer: options.offer ?? "self",
        },
      },
    }),
  );

  const allowlist = new Allowlist(join(dir, "allow.json"));
  await allowlist.load();
  for (const owner of options.allow ?? []) {
    await allowlist.add({ origin: "https://app.test", owner }, Date.now());
  }

  const budgets = new Budgets(join(dir, "b.json"), loaded.config.community);
  await budgets.load(Date.now());
  const spend = new SpendLedger(join(dir, "spend.json"));
  await spend.load(Date.now());
  const ingress = new IngressLog({
    path: join(dir, "ingress.log"),
    communityPromptDays: 7,
    keepSelfPrompts: true,
  });

  const runner = new Runner({
    client: new ProtocolClient({
      origin: "https://app.test",
      identity: TEST_SIGNER,
    }),
    runnerId: "runner_1",
    owner: options.owner ?? "me",
    daemonVersion: "0.0.0",
    loaded,
    allowlist,
    budgets,
    spend,
    ingress,
    backendFactory: () => backend,
  });
  return { runner, ingress, budgets };
}

const job = (
  overrides: Partial<ClaimedStub & { payload: JobPayload }> = {},
): ClaimedStub & { payload: JobPayload } => ({
  id: "job_1",
  kind: "llm.generate",
  payload: { prompt: "hello" },
  audience: "self",
  owner: "me",
  site: "BYOLLM-TEST-SITE-KEY-ID",
  sizeClass: "small",
  streaming: false,
  deadlineAt: Date.now() + 60_000,
  lease: {
    id: "lease_test",
    runnerId: "runner_1",
    expiresAt: Date.now() + 60_000,
  },
  ...overrides,
});

describe("capability detection [CAPABILITY_IS_DETECTED]", () => {
  it("advertises a healthy route", async () => {
    const { runner } = await makeRunner();
    expect(await runner.detectCapabilities()).toHaveLength(1);
  });

  it("advertises nothing when the backend is down", async () => {
    const { runner } = await makeRunner();
    backend.healthy = false;
    // Never advertise what isn't installed and healthy.
    expect(await runner.detectCapabilities()).toEqual([]);
  });

  it("advertises nothing when the backend lacks the configured model", async () => {
    const { runner } = await makeRunner();
    backend.models = ["some-other-model"];
    expect(await runner.detectCapabilities()).toEqual([]);
  });

  it("tolerates a backend that does not enumerate models", async () => {
    const { runner } = await makeRunner();
    backend.models = [];
    expect(await runner.detectCapabilities()).toHaveLength(1);
  });

  it("matches a model whatever its :latest suffix", async () => {
    const { runner } = await makeRunner();
    backend.models = ["M:latest"];
    expect(await runner.detectCapabilities()).toHaveLength(1);
  });
});

describe("admit — the daemon enforcing against the server", () => {
  it("takes its own owner's work", async () => {
    const { runner } = await makeRunner({ owner: "me" });
    expect(runner.admit(job()).ok).toBe(true);
  });

  it("refuses a kind it has no route for", async () => {
    const { runner } = await makeRunner();
    const result = runner.admit(job({ kind: "llm.chat" }));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.reason).toContain("no backend on this device");
  });

  it("refuses another owner's self job", async () => {
    const { runner } = await makeRunner({ owner: "me" });
    const result = runner.admit(job({ owner: "alice", audience: "self" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("private to its owner");
  });

  it("refuses a named job the local allowlist omits [NAMED_LOCAL_ALLOWLIST]", async () => {
    const { runner } = await makeRunner({ owner: "me", offer: "named" });
    const result = runner.admit(job({ owner: "alice", audience: "named" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("allowlist");
  });

  it("admits a named job once the local allowlist names its owner", async () => {
    const { runner } = await makeRunner({
      owner: "me",
      offer: "named",
      allow: ["alice"],
    });
    expect(runner.admit(job({ owner: "alice", audience: "named" })).ok).toBe(
      true,
    );
  });

  it("refuses another owner's work on a subscription backend at any scope", async () => {
    const { runner } = await makeRunner({
      owner: "me",
      offer: "public",
      subscription: true,
      allow: ["alice"],
    });
    const result = runner.admit(job({ owner: "alice", audience: "public" }));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.reason).toContain("protocol rule, not a setting");
  });

  it("refuses community work past the owner's budget [COMMUNITY_BUDGETS]", async () => {
    const { runner, budgets } = await makeRunner({
      owner: "me",
      offer: "public",
    });
    // Fill the hourly allowance.
    const now = Date.now();
    for (let i = 0; i < 20; i += 1) await budgets.record(now);

    const result = runner.admit(job({ owner: "alice", audience: "public" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("community jobs");
  });

  it("never applies community budgets to the owner's own work", async () => {
    const { runner, budgets } = await makeRunner({ owner: "me" });
    const now = Date.now();
    for (let i = 0; i < 50; i += 1) await budgets.record(now);
    expect(runner.admit(job({ owner: "me" })).ok).toBe(true);
  });
});

describe("runJob [INGRESS_LOGGED_BEFORE_EXECUTION]", () => {
  it("logs the prompt before the backend ever sees it", async () => {
    const { runner, ingress } = await makeRunner();
    let loggedWhenBackendRan: number | undefined;
    const original = backend.execute.bind(backend);
    backend.execute = async (request) => {
      loggedWhenBackendRan = (await ingress.read()).filter(
        (entry) => entry.type === "prompt",
      ).length;
      return original(request);
    };

    await runner.runJob(job());
    // The prompt was already on disk by the time the backend was called.
    expect(loggedWhenBackendRan).toBe(1);
  });

  it("returns the model's text", async () => {
    const { runner } = await makeRunner();
    const outcome = await runner.runJob(job());
    expect(outcome).toEqual({ outcome: "ok", text: "echo: hello" });
  });

  it("records the outcome as a second entry", async () => {
    const { runner, ingress } = await makeRunner();
    await runner.runJob(job());
    const entries = await ingress.read();
    expect(entries.map((entry) => entry.type)).toEqual(["prompt", "outcome"]);
  });

  it("reports an unroutable kind rather than throwing", async () => {
    const { runner } = await makeRunner();
    const outcome = await runner.runJob(job({ kind: "llm.chat" }));
    expect(outcome).toMatchObject({ outcome: "error", code: "no-capability" });
  });

  it("counts a community job against the budget, and its own against nothing", async () => {
    const { runner, budgets } = await makeRunner({
      owner: "me",
      offer: "public",
    });
    await runner.runJob(job({ owner: "alice", audience: "public" }));
    expect(budgets.usage(Date.now()).hour).toBe(1);

    await runner.runJob(job({ id: "job_2", owner: "me" }));
    expect(budgets.usage(Date.now()).hour).toBe(1);
  });

  it("aborts in flight when cancelled [CANCEL_HONORED]", async () => {
    const { runner } = await makeRunner();
    backend.hang = true;
    const running = runner.runJob(job());
    // Wait for the backend to actually hold it, rather than guessing with a
    // sleep — the race this used to lose is the bug it is meant to catch.
    while (backend.seen.length === 0) await new Promise(setImmediate);
    // By lease, because a cancel names the grant — V1-3.
    runner.cancelLease("lease_test");
    expect(await running).toEqual({ outcome: "canceled" });
  });

  it("aborts everything on cancelAll", async () => {
    const { runner } = await makeRunner();
    backend.hang = true;
    const running = runner.runJob(job());
    while (backend.seen.length === 0) await new Promise(setImmediate);
    runner.cancelAll();
    expect(await running).toEqual({ outcome: "canceled" });
  });
});

describe("status", () => {
  it("reports who this daemon is and what it has done", async () => {
    const { runner } = await makeRunner({ owner: "me" });
    await runner.detectCapabilities();
    await runner.runJob(job());

    const status = runner.status();
    expect(status).toMatchObject({
      origin: "https://app.test",
      owner: "me",
      runnerId: "runner_1",
      paused: false,
      revoked: false,
      activeJobs: 0,
      completed: 1,
    });
    expect(status.capabilities).toHaveLength(1);
  });

  it("reflects pause and resume", async () => {
    const { runner } = await makeRunner();
    runner.pause();
    expect(runner.status().paused).toBe(true);
    runner.resume();
    expect(runner.status().paused).toBe(false);
  });
});

describe("composePrompt", () => {
  it("passes a plain prompt through untouched", () => {
    expect(composePrompt(job())).toBe("hello");
  });

  it("folds a system instruction into the text", () => {
    // Process-class backends cannot take it on argv, so it goes on stdin.
    const composed = composePrompt(
      job({ payload: { prompt: "do the thing", system: "be terse" } }),
    );
    expect(composed).toContain("be terse");
    expect(composed).toContain("do the thing");
  });

  it("renders a conversation with roles", () => {
    const composed = composePrompt(
      job({
        kind: "llm.chat",
        payload: {
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
          ],
        },
      }),
    );
    expect(composed).toContain("User: hi");
    expect(composed).toContain("Assistant: hello");
  });

  it("ignores a blank system instruction rather than emitting an empty header", () => {
    expect(
      composePrompt(job({ payload: { prompt: "x", system: "   " } })),
    ).toBe("x");
  });
});
