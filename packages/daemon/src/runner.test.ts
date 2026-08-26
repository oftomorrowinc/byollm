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
import type {
  Backend,
  BackendRequest,
  BackendResult,
} from "./backends/index.js";
import { Budgets } from "./budgets.js";
import { ProtocolClient } from "./client.js";
import { composePrompt } from "./compose.js";
import { DaemonConfig, resolveConfig, type ResolvedRoute } from "./config.js";
import { IngressLog } from "./ingress.js";
import { SpendLedger } from "./spend.js";
import { Runner, type RunnerEvent } from "./runner.js";
import { removeTemp, testControlPlane } from "./test-support.js";

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
  /** How many times detection asked. One service is asked once. */
  healthChecks = 0;

  health(): Promise<{ healthy: boolean; models: string[] }> {
    this.healthChecks += 1;
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
    offer?: "private" | "team";
    subscription?: boolean;
    /** Override the whole services stanza, for the per-service cases. */
    services?: Record<string, unknown>;
    /** Which service wins each kind, when more than one claims it. */
    defaults?: Record<string, string>;
    /**
     * Which backend each route gets. Defaults to the shared spy; the
     * selection cases pass one that records *which* route was asked for,
     * because that is the whole question there.
     */
    backendFactory?: (route: ResolvedRoute) => Backend;
    /** Events the runner emits, for the cases that are about a notice. */
    onEvent?: (event: RunnerEvent) => void;
  } = {},
) {
  const loaded = resolveConfig(
    DaemonConfig.parse({
      ...(options.defaults === undefined ? {} : { defaults: options.defaults }),
      services: options.services ?? {
        primary: {
          model: "m",
          kinds: ["llm.generate"],
          type: options.subscription === true ? "claude-cli" : "openai-http",
          ...(options.subscription === true
            ? {}
            : { baseUrl: "http://127.0.0.1:11434/v1" }),
          offer: options.offer ?? "private",
        },
      },
    }),
  );

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
    // Every runner in this file has a control plane, so admission is a
    // signed document rather than a device-local list: `job()` attaches a
    // genuine grant, and a test that wants one refused bends a field.
    controlPlanePublic: plane.controlPlanePublic,
    client: new ProtocolClient({
      origin: "https://app.test",
      identity: TEST_SIGNER,
    }),
    runnerId: "runner_1",
    owner: options.owner ?? "me",
    daemonVersion: "0.0.0",
    loaded,
    budgets,
    spend,
    ingress,
    backendFactory: options.backendFactory ?? (() => backend),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  });
  return { runner, ingress, budgets };
}

/**
 * The control plane behind every runner here — Amendment J.
 *
 * File-level, so `job()` can attach a genuine grant by default and the tests
 * that are *about* a bad grant can bend one field at a time. That is how the
 * four device checks get tested individually rather than through whichever
 * one happens to fire first.
 */
const plane = testControlPlane();

const job = (
  overrides: Partial<ClaimedStub & { payload: JobPayload }> = {},
): ClaimedStub & { payload: JobPayload } => ({
  id: "job_1",
  kind: "llm.generate",
  payload: { prompt: "hello" },
  audience: "private",
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
  grant: plane.sign({
    jobId: overrides.id ?? "job_1",
    user: overrides.owner ?? "me",
    service: overrides.service ?? "primary",
  }),
  ...overrides,
});

describe("capability detection [CAPABILITY_IS_DETECTED]", () => {
  it("advertises a healthy route", async () => {
    const { runner } = await makeRunner();
    expect(await runner.detectCapabilities()).toHaveLength(1);
  });

  it("asks a service once, however many kinds it answers", async () => {
    // Detection ran per route, so a service answering two kinds was asked
    // twice — doubling every heartbeat's network cost, and letting one
    // service give two different answers about itself in a single tick.
    const { runner } = await makeRunner({
      services: {
        local: {
          type: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "m",
          kinds: ["llm.generate", "llm.chat"],
        },
      },
    });

    const advertised = await runner.detectCapabilities();

    expect(advertised.map((c) => c.kind).sort()).toEqual([
      "llm.chat",
      "llm.generate",
    ]);
    expect(backend.healthChecks).toBe(1);
  });

  it("drops every kind of a service that is down, not just one", async () => {
    const { runner } = await makeRunner({
      services: {
        local: {
          type: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "m",
          kinds: ["llm.generate", "llm.chat"],
        },
      },
    });
    backend.healthy = false;

    expect(await runner.detectCapabilities()).toEqual([]);
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
    const result = runner.admit(job({ owner: "alice", audience: "private" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("private to its owner");
  });

  it("refuses a team job the control plane did not grant [NAMED_LOCAL_ALLOWLIST]", async () => {
    // The MUST keeps its id, because ids are public and cited by conformance
    // output. What satisfies it has moved: it used to be a device-local
    // allowlist, and it is now a signed grant. The law never changed — a
    // stranger's work runs only on something this device could check.
    const { runner } = await makeRunner({ owner: "me", offer: "team" });
    const result = runner.admit(
      job({ owner: "alice", audience: "team", grant: undefined }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("no grant arrived");
  });

  it("admits a team job the control plane granted", async () => {
    const { runner } = await makeRunner({ owner: "me", offer: "team" });
    expect(runner.admit(job({ owner: "alice", audience: "team" })).ok).toBe(
      true,
    );
  });

  it("refuses another owner's work on a subscription backend at any scope", async () => {
    const { runner } = await makeRunner({
      owner: "me",
      offer: "team",
      subscription: true,
    });
    const result = runner.admit(job({ owner: "alice", audience: "team" }));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.reason).toContain("protocol rule, not a setting");
  });

  it("refuses community work past the owner's budget [COMMUNITY_BUDGETS]", async () => {
    const { runner, budgets } = await makeRunner({
      owner: "me",
      offer: "team",
    });
    // Fill the hourly allowance.
    const now = Date.now();
    for (let i = 0; i < 20; i += 1) await budgets.record(now);

    const result = runner.admit(job({ owner: "alice", audience: "team" }));
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
      offer: "team",
    });
    await runner.runJob(job({ owner: "alice", audience: "team" }));
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

  it("advertises one default per kind, not one per row", async () => {
    /**
     * byollm_016 Phase B, found in production on 2026-08-25.
     *
     * Todd's device offered four services for `llm.generate` and told the hub
     * all four were the default. Nothing mis-routed — the daemon picks the
     * default from its own config, and it did — but `isDefault` is the field
     * Phase B added *expressly* so a consumer would never have to re-derive
     * which row an unselected job takes. A guard field that lies is worse
     * than no field, because the inference it replaced at least matched the
     * data.
     *
     * The line read `isDefault: true` under a comment whose last sentence
     * predicted this exact break: Phase A advertised one row per kind, "and
     * Phase B advertises the whole menu, and that inference would silently
     * stop being true."
     */
    const { runner } = await makeRunner({
      services: {
        alpha: {
          model: "m",
          kinds: ["llm.generate", "llm.chat"],
          type: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
        beta: {
          model: "m",
          kinds: ["llm.generate"],
          type: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
        gamma: {
          model: "m",
          kinds: ["llm.generate"],
          type: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
      },
      defaults: { "llm.generate": "beta" },
    });

    await runner.detectCapabilities();
    const caps = runner.status().capabilities;
    // The menu still travels in full — that is the point of Phase B, and a
    // "fix" that advertised only the default would pass the count below while
    // removing selection entirely.
    expect(caps.filter((c) => c.kind === "llm.generate")).toHaveLength(3);

    for (const kind of ["llm.generate", "llm.chat"]) {
      const defaults = caps.filter((c) => c.kind === kind && c.isDefault);
      expect(
        defaults.map((c) => c.service),
        kind,
      ).toHaveLength(1);
    }
    // And it is the one the config names, not merely the first row.
    expect(
      caps.find((c) => c.kind === "llm.generate" && c.isDefault)?.service,
    ).toBe("beta");
  });

  it("withdraws a service that says it is not signed in, after one job", async () => {
    /**
     * The free half of closing healthy-but-every-job-fails, ruled 2026-08-25.
     *
     * A signed-out CLI passes its own health check — `--version` needs no
     * credentials — so the service stays advertised and every job dies. One
     * job is enough to know: "not signed in" is not flaky, it is a fact that
     * holds until somebody logs in, and each further job spent confirming it
     * is somebody's work refused for a reason already known.
     */
    const events: RunnerEvent[] = [];
    const { runner } = await makeRunner({
      backendFactory: () => ({
        id: "claude-cli" as const,
        class: "process" as const,
        health: () =>
          // Healthy, which is the whole point: the probe cannot see this.
          Promise.resolve({ healthy: true, models: [] }),
        execute: () =>
          Promise.resolve({
            ok: false as const,
            code: "unauthorized" as const,
            message: "the claude CLI is not signed in",
            retryable: false,
            durationMs: 1,
          }),
      }),
      onEvent: (e) => events.push(e),
    });

    expect(await runner.detectCapabilities()).toHaveLength(1);
    await runner.runJob(job());

    expect(events.map((e) => e.type)).toContain("service-not-signed-in");
    // Withdrawn, while its own health check still says healthy.
    expect(await runner.detectCapabilities()).toHaveLength(0);
  });

  it("runs a canary only when asked, never on the polling loop", async () => {
    /**
     * The rule that keeps this from becoming a standing cost — ruled
     * 2026-08-25. A canary spends a real subscription call, so it belongs at
     * daemon start and enablement and nowhere else. The polling loop asks the
     * same method for capabilities every heartbeat.
     *
     * Asserted as a count of calls rather than by reading the call site,
     * because the call site is one word and the bill is not.
     */
    let canaries = 0;
    const backend = {
      id: "claude-cli" as const,
      class: "process" as const,
      health: () => Promise.resolve({ healthy: true, models: [] }),
      canary: () => {
        canaries += 1;
        return Promise.resolve({ healthy: true, models: [] });
      },
      execute: () =>
        Promise.resolve({ ok: true as const, text: "ok", durationMs: 1 }),
    };
    const { runner } = await makeRunner({ backendFactory: () => backend });

    await runner.detectCapabilities();
    await runner.detectCapabilities();
    expect(canaries, "the default must not spend anything").toBe(0);

    await runner.detectCapabilities({ canary: true });
    expect(canaries).toBe(1);
  });

  it("withdraws a service whose canary cannot sign in, before any job", async () => {
    // The paid leg's whole point: the failure is found before somebody else's
    // work is refused, rather than by refusing it.
    const events: RunnerEvent[] = [];
    const { runner } = await makeRunner({
      backendFactory: () => ({
        id: "claude-cli" as const,
        class: "process" as const,
        // Healthy — `--version` needs no credentials.
        health: () => Promise.resolve({ healthy: true, models: [] }),
        canary: () =>
          Promise.resolve({
            healthy: false,
            models: [],
            detail: "the claude CLI is not signed in",
          }),
        execute: () =>
          Promise.resolve({ ok: true as const, text: "ok", durationMs: 1 }),
      }),
      onEvent: (e) => events.push(e),
    });

    expect(await runner.detectCapabilities({ canary: true })).toHaveLength(0);
    expect(events.map((e) => e.type)).toContain("service-not-signed-in");
    // And it stays withdrawn on the polling loop, which runs no canary and
    // would otherwise re-advertise it on the next heartbeat.
    expect(await runner.detectCapabilities()).toHaveLength(0);
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

describe("which service runs a job — byollm_016 Phase B", () => {
  /**
   * The menu travels now, so a kind can have several routes and the daemon has
   * to pick deliberately. It used to take the first match, which was correct
   * while there was only ever one and became a coin-flip the moment there were
   * two — the exact guess `withheld` exists to refuse, arriving by another
   * door.
   *
   * A mutation replacing the default lookup with `find(r => r.kind === kind)`
   * survived all 422 tests before these existed, which is how they came to be
   * written.
   */
  const TWO = {
    studio: {
      type: "openai-http",
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "studio-model",
      kinds: ["llm.generate"],
    },
    spare: {
      type: "openai-http",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "spare-model",
      kinds: ["llm.generate"],
    },
  };

  /** Which route the runner actually asked for a backend. */
  const asked = async (
    over: Partial<ClaimedStub & { payload: JobPayload }>,
    defaults: Record<string, string>,
  ) => {
    const seen: string[] = [];
    const made = await makeRunner({
      services: TWO,
      defaults,
      backendFactory: (route) => {
        seen.push(route.service);
        return backend;
      },
    });
    const outcome = await made.runner.runJob(job(over));
    return { seen, outcome };
  };

  it("sends an unselected job to the default, not to whichever is first", async () => {
    const { seen } = await asked({}, { "llm.generate": "spare" });
    expect(seen).toEqual(["spare"]);
  });

  it("sends a selected job to the service it named", async () => {
    const { seen } = await asked(
      { service: "spare" },
      { "llm.generate": "studio" },
    );
    expect(seen).toEqual(["spare"]);
  });

  it("refuses a name this device does not have, never substituting", async () => {
    // The daemon's half of the both-sides rule. The hub already matched on the
    // pair; serving a selection from something else is the substitution
    // NO_PAYLOAD_ROUTING forbids, and falling back to the default would be
    // exactly that — silently, behind a successful-looking job.
    const { seen, outcome } = await asked(
      { service: "not-here" },
      { "llm.generate": "studio" },
    );
    expect(outcome.outcome).toBe("error");
    expect(seen).toEqual([]);
  });
});
