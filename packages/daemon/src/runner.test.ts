import {
  type ClaimedJob,
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
  BackendErrorCode,
  BackendRequest,
  BackendResult,
} from "./backends/index.js";
import { Budgets } from "./budgets.js";
import { ProtocolClient } from "./client.js";
import { composePrompt } from "./compose.js";
import { DaemonConfig, resolveConfig, type ResolvedRoute } from "./config.js";
import { IngressLog } from "./ingress.js";
import { SERVICE_UNAVAILABLE, siblingsOf } from "./site-outcome.js";
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
    /** The clock, for the cases that are about one — see the quota block. */
    now?: () => number;
    /** The file the surfaces read, for the case that is about reaching them. */
    onServiceStates?: (
      states: ReadonlyMap<string, { state: { kind: string } }>,
    ) => Promise<void>;
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
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onServiceStates === undefined
      ? {}
      : { onServiceStates: options.onServiceStates }),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  });
  return { runner, ingress, budgets };
}

/**
 * The control plane behind every runner here — Amendment J.
 *
 * File-level, so `job()` can attach a genuine grant by default and the tests
 * that are *about* a bad grant can bend one field at a time. That is how the
 * device checks get tested individually rather than through whichever one
 * happens to fire first.
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
    // The slot the control plane resolved, taken from the job it is for.
    //
    // Derived rather than defaulted, because the device now refuses a grant
    // that disagrees with its stub about kind or purpose — so a helper that
    // fixed these while the stub varied would hand every kind-related case a
    // *tampered* grant and refuse it one check too early, for the wrong
    // reason. A test that wants that disagreement asks for it, by passing a
    // whole `grant`.
    kind: overrides.kind ?? "llm.generate",
    ...(overrides.purpose === undefined ? {} : { purpose: overrides.purpose }),
    // The resolved service now lives only on the grant — a stub cannot name
    // one (Amendment L), so a test that wants a particular service says so
    // where the control plane would.
    service: overrides.grant?.service ?? "primary",
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

  it("advertises every service for a kind, and no default among them", async () => {
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
    /**
     * The whole menu travels, and only the menu.
     *
     * Every service answering a kind is advertised, because a control plane
     * resolves a person's mapping to one of them and can only choose from
     * what it was shown. The rows used to carry `isDefault` so an *unselected*
     * job could find the one its owner had chosen; nothing is unselected any
     * more — a job names a purpose and a mapping names a service — so the
     * flag went with the machinery it served.
     *
     * The owner's default still exists, as a local fact for direct mode. It
     * simply stopped being anybody else's business.
     */
    expect(caps.filter((c) => c.kind === "llm.generate")).toHaveLength(3);
    expect(
      caps
        .filter((c) => c.kind === "llm.generate")
        .map((c) => c.service)
        .sort(),
    ).toEqual(["alpha", "beta", "gamma"]);
    expect(Object.keys(caps[0] ?? {})).not.toContain("isDefault");
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
    over: Partial<ClaimedJob> & { service?: string },
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
    // `runJob` takes the *opened* job, whose `service` is the resolution the
    // grant carried — so these cases set it where the control plane would.
    const outcome = await made.runner.runJob({ ...job(), ...over });
    return { seen, outcome };
  };

  it("sends a job with no resolution to the owner's default", async () => {
    // Direct mode: no control plane, so nothing resolved anything, and the
    // owner's own default answers under the ambiguity law as shipped.
    const { seen } = await asked({}, { "llm.generate": "spare" });
    expect(seen).toEqual(["spare"]);
  });

  it("sends a resolved job to the service its grant names", async () => {
    // The relayed route. A person's mapping chose `spare`; the owner's
    // default is `studio`; the mapping wins, because the default was never
    // anybody else's answer.
    const { seen } = await asked(
      { service: "spare" },
      { "llm.generate": "studio" },
    );
    expect(seen).toEqual(["spare"]);
  });

  it("refuses a resolution this device cannot honour, never substituting", async () => {
    // The device's half of offer-consistency. A grant naming a service this
    // machine does not have is stale or forged either way, and falling back
    // to the default would be the substitution NO_PAYLOAD_ROUTING forbids —
    // silently, behind a successful-looking job.
    const { seen, outcome } = await asked(
      { service: "not-here" },
      { "llm.generate": "studio" },
    );
    expect(outcome.outcome).toBe("error");
    expect(seen).toEqual([]);
  });
});

/**
 * What a site is told when somebody's backend fails — a8137b5.
 *
 * The owner's surfaces get the CLI's own words. The site gets a class and a
 * fixed sentence, and this is the boundary where that has to hold.
 *
 * Two reasons, and the second is the larger. CLI errors quote the owner's
 * machine — paths, usernames, config locations, account emails — and a
 * stranger's page is not where those go. And every message named its backend,
 * so "the claude CLI is not signed in" told a site which model answered:
 * exactly what the disclosure fence exists to prevent, arriving through the
 * error path because nobody was watching the error path.
 */
describe("what leaves the machine when a backend fails", () => {
  const failingUntil = (
    message: string,
    code: BackendErrorCode,
    until: number,
  ) =>
    ({
      execute: () =>
        Promise.resolve({
          ok: false as const,
          code,
          message,
          durationMs: 1,
          until,
        }),
      health: () => Promise.resolve({ healthy: true, models: [] }),
    }) as unknown as Backend;

  const failing = (message: string, code: BackendErrorCode = "backend-error") =>
    ({
      execute: () =>
        Promise.resolve({
          ok: false as const,
          code,
          message,
          durationMs: 1,
        }),
    }) as unknown as Backend;

  it("sends the site a class, not the CLI's words", async () => {
    const { runner } = await makeRunner({
      backendFactory: () =>
        failing("the claude CLI failed: /Users/todd/.claude missing"),
    });

    const outcome = await runner.runJob(job());
    expect(outcome).toMatchObject({
      outcome: "error",
      code: "service_unavailable",
      // The sentence itself, so it cannot drift into naming something.
      message: SERVICE_UNAVAILABLE,
    });
    const said = JSON.stringify(outcome);
    expect(said, "the owner's path travelled to the site").not.toMatch(
      /Users|todd|\.claude/,
    );
    expect(said, "the site learned which model answered").not.toMatch(
      /claude/i,
    );
  });

  /* Not signed in is the same class. Telling it apart from a crash would tell
     the site something about the person's setup, and the person already knows
     — they are the one who has to log in. */
  it("does not tell the site the difference between broken and signed out", async () => {
    const { runner } = await makeRunner({
      backendFactory: () =>
        failing("the claude CLI is not signed in", "unauthorized"),
    });

    const outcome = await runner.runJob(job());
    expect(outcome).toMatchObject({ code: "service_unavailable" });
  });

  /* Quota is the owner's account state. It is actionable as a retry decision,
     but neither the provider nor the reason belongs on the site's surface. */
  it("does not expose subscription exhaustion to the site", async () => {
    const { runner } = await makeRunner({
      backendFactory: () =>
        failing(
          "the codex CLI failed: You've hit your usage limit",
          "quota-exhausted",
        ),
    });

    const outcome = await runner.runJob(job());
    expect(outcome).toMatchObject({
      code: "service_unavailable",
      message: SERVICE_UNAVAILABLE,
    });
    expect(JSON.stringify(outcome)).not.toMatch(/codex|usage|quota/i);
  });

  it("stops advertising a blocked service, and brings it back on its own", async () => {
    /**
     * The fast failover, at the seam that makes it fast — byollm_019 §3.2.
     *
     * Left advertised, the next job is claimed by this device, fails the same
     * way, and the site learns nothing until the job's TTL expires. That is
     * the slow path the whole change exists to close: the fallback Todd
     * promised Eric cannot fire, because the site was never told anything to
     * fall back from.
     *
     * And it comes back **with nobody doing anything**, which is the reason
     * this is not folded into the signed-out set. A signed-out service waits
     * for a person; a blocked one waits for a clock.
     */
    const until = 2_000;
    let now = 1_000;
    const { runner } = await makeRunner({
      now: () => now,
      backendFactory: () =>
        failingUntil(
          "the codex CLI failed: You've hit your usage limit",
          "quota-exhausted",
          until,
        ),
    });

    await runner.runJob(job());

    const blocked = await runner.detectCapabilities({});
    expect(blocked.map((c) => c.service)).not.toContain("primary");
    /* And the *state* survives that pass — S2. The map is rebuilt from
       scratch each time and a blocked service skips the probe that would
       fill its entry, so without carrying it the reason and the clock exist
       for one pass and then vanish, leaving `byollm status` unable to say
       anything at all. */
    expect(runner.serviceStates.get("primary")?.state).toMatchObject({
      kind: "blocked",
      until,
    });

    // Still inside the window: still withdrawn.
    now = until - 1;
    const during = await runner.detectCapabilities({});
    expect(during.map((c) => c.service)).not.toContain("primary");

    // Past it: offered again, unasked.
    now = until;
    const after = await runner.detectCapabilities({});
    expect(after.map((c) => c.service)).toContain("primary");
    // And it stops claiming to be blocked, or the surface would keep saying so
    // about a service that is answering again.
    expect(runner.serviceStates.get("primary")?.state.kind).not.toBe("blocked");
  });

  it("tells the process that writes the file, at the moment it changes", async () => {
    /**
     * S2's other half — and the reason a callback is not enough on its own.
     *
     * The daemon probes; `byollm status` reports; they are different
     * processes and the file between them was written once, at start. A
     * service that went out of quota an hour later was invisible to every
     * surface except the daemon's own stderr, so the state could be perfectly
     * correct in memory and unreadable by the only thing that renders it.
     *
     * **An injection point nobody invokes is dead code wearing an API.** This
     * asserts the call, because without it the wiring could be removed and
     * every other test here would still pass.
     */
    const written: string[] = [];
    const { runner } = await makeRunner({
      backendFactory: () =>
        failingUntil(
          "the codex CLI failed: You've hit your usage limit",
          "quota-exhausted",
          9_999,
        ),
      onServiceStates: (states) => {
        written.push(states.get("primary")?.state.kind ?? "absent");
        return Promise.resolve();
      },
    });

    await runner.runJob(job());
    expect(written).toEqual(["blocked"]);
  });

  it("writes when the block lifts, not only when it lands", async () => {
    /**
     * S-2, found by CW reading the code — 2026-09-04.
     *
     * Only the block was written. An until-less block withdraws for one
     * pass, recovers on the next, and `services.json` goes on saying "out of
     * quota: it needs time, not a fix" forever, about a service that is
     * answering. **A file written when things get worse and never when they
     * get better is not a record, it is an accusation.**
     *
     * The rule, one line: a withdrawal or restoration that `status` would
     * report differently is a state change, and every state change writes.
     */
    const until = 2_000;
    let now = 1_000;
    const written: (string | undefined)[] = [];
    const { runner } = await makeRunner({
      now: () => now,
      backendFactory: () =>
        failingUntil(
          "the codex CLI failed: You've hit your usage limit",
          "quota-exhausted",
          until,
        ),
      onServiceStates: (states) => {
        written.push(states.get("primary")?.state.kind ?? "absent");
        return Promise.resolve();
      },
    });

    await runner.runJob(job());
    expect(written).toEqual(["blocked"]);

    /* The lift is recorded by the pass that re-probes it: the entry stops
       saying "blocked" and starts saying what the probe found. What must
       never happen is the file keeping the old accusation. */
    now = until;
    await runner.detectCapabilities({});
    expect(written).toEqual(["blocked", "unknown"]);
  });

  it("writes once for a machine that has not changed", async () => {
    /* The pass writes at the end, and passes are far more frequent than
       changes — a heartbeat every ten seconds, forever. Without the
       comparison this is a small file rewritten all night on a machine where
       nothing happened, and every process polling it woken for nothing. */
    const written: string[] = [];
    const { runner } = await makeRunner({
      onServiceStates: (states) => {
        written.push([...states.keys()].join(","));
        return Promise.resolve();
      },
    });

    await runner.detectCapabilities({});
    await runner.detectCapabilities({});
    await runner.detectCapabilities({});
    expect(written).toHaveLength(1);
  });

  it("tries again after a write that failed", async () => {
    /* Marking the attempt rather than the success made a failed write
       permanent: the comparison matched on every later pass and never tried
       again, so one unwritable moment left `status` reading a state the
       daemon had long since left. */
    let failing = true;
    const written: string[] = [];
    const { runner } = await makeRunner({
      onServiceStates: (states) => {
        if (failing) return Promise.reject(new Error("disk said no"));
        written.push([...states.keys()].join(","));
        return Promise.resolve();
      },
    });

    await runner.detectCapabilities({});
    // Let the rejection settle before the next pass reads the marker.
    await new Promise((resolve) => setTimeout(resolve, 0));
    failing = false;
    await runner.detectCapabilities({});
    expect(written).toHaveLength(1);
  });

  it("writes when a service signs out mid-run", async () => {
    /* The other half of S-2. This path never got the treatment at all, so a
       mid-run sign-out was invisible to status: the surface said the service
       was answering while every job it took was refused. */
    const written: (string | undefined)[] = [];
    const { runner } = await makeRunner({
      backendFactory: () =>
        failing("the claude CLI is not signed in", "unauthorized"),
      onServiceStates: (states) => {
        written.push(states.get("primary")?.state.kind ?? "absent");
        return Promise.resolve();
      },
    });

    await runner.runJob(job());
    expect(written).toEqual(["signed-out"]);

    /* And it survives the next pass — tick-1 rider. The map is emptied every
       time and a withdrawn service skips the probe that would refill it, so
       this state was visible for one heartbeat and then erased: `status`
       showing a fault once and going quiet, about a service still refusing
       every job. A SECOND pass is the assertion, because the first proves
       nothing about a rebuild. */
    await runner.detectCapabilities({});
    await runner.detectCapabilities({});
    expect(runner.serviceStates.get("primary")?.state.kind).toBe("signed-out");
  });

  it("keeps a signed-out service withdrawn, clock or no clock", async () => {
    /* The control. If the two sets had been folded, the release above would
       let a signed-out service back in after a couple of seconds — which is
       the opposite of what its own ruling says, and would be invisible in the
       test above. */
    let now = 1_000;
    const { runner } = await makeRunner({
      now: () => now,
      backendFactory: () =>
        failing("the claude CLI is not signed in", "unauthorized"),
    });

    await runner.runJob(job());
    now = 10_000_000;
    const after = await runner.detectCapabilities({});
    expect(after.map((c) => c.service)).not.toContain("primary");
  });

  it("tells the owner a time, and never a thing to sign in to", async () => {
    const seen: unknown[] = [];
    const { runner } = await makeRunner({
      backendFactory: () =>
        failingUntil(
          "the codex CLI failed: You've hit your usage limit",
          "quota-exhausted",
          9_999,
        ),
      onEvent: (event) => {
        if (event.type === "service-out-of-quota") seen.push(event);
        // The wrong notice for this cause. A person told to sign in to an
        // account that is working perfectly goes looking for a fault there
        // is not.
        if (event.type === "service-not-signed-in") seen.push("wrong notice");
      },
    });

    await runner.runJob(job());
    expect(seen).toEqual([
      { type: "service-out-of-quota", service: "primary", until: 9_999 },
    ]);
  });

  it("gives every service_unavailable the same retry answer", async () => {
    /**
     * S3 — ruled by CW, 2026-09-04.
     *
     * `retryable` used to travel from the backend result, on the reasoning
     * that whether to try again is the site's decision and says nothing about
     * whose machine it was. True while the flag distinguished nothing. Quota
     * broke it by arriving `true`, and within one site-facing class exactly
     * one path produced that value — so `(service_unavailable, true)` read as
     * **"his account is rate-limited"**, the inference the fence exists to
     * prevent, on the job-failure surface rather than the enqueue one.
     *
     * The two adapters disagreed as well: the same block reported `true` from
     * Codex and `false` from Claude.
     *
     * Asserted as a set, so a fourth sibling added later has to join it. The
     * person-or-time question lives at enqueue, in the slot-level wait-bit,
     * and nowhere else.
     */
    /* Derived, not listed — CW's minor, 2026-09-04. Naming the five by hand
       made this hold by convention: a sixth code mapped into the class would
       be a sixth thing a site could tell apart, and nothing here would have
       noticed. */
    const siblings = siblingsOf("service_unavailable");
    expect(siblings.length).toBeGreaterThan(1);

    const answers = new Set<string>();
    for (const code of siblings) {
      const { runner } = await makeRunner({
        backendFactory: () => failing(`the claude CLI failed: ${code}`, code),
      });
      const outcome = (await runner.runJob(job())) as {
        code: string;
        message: string;
        retryable: boolean;
      };
      expect(outcome.code).toBe("service_unavailable");
      answers.add(JSON.stringify([outcome.code, outcome.retryable]));
    }

    /* Pinned to the value, not merely to agreement — tick-1 rider. Asserting
       uniformity alone is green when all five are flipped back to `false`,
       which is the regression that broke transient retries in the first
       place. */
    expect(answers.size, [...answers].join(" vs ")).toBe(1);
    expect([...answers][0]).toBe(JSON.stringify(["service_unavailable", true]));
  });

  it("still tells a site a timeout is worth retrying", async () => {
    /* The control. Making the flag uniform must not make it constant — a
       class that genuinely is worth retrying still says so, and if it did
       not, the assertion above would pass on a field nobody could use. */
    const { runner } = await makeRunner({
      backendFactory: () => failing("took too long", "timeout"),
    });
    const outcome = (await runner.runJob(job())) as { retryable: boolean };
    expect(outcome.retryable).toBe(true);
  });

  /* And the owner keeps everything. The text is theirs — it is their machine,
     their CLI, and the sentence that tells them what to do about it. */
  it("keeps the CLI's words for the owner", async () => {
    const seen: string[] = [];
    const { runner, ingress } = await makeRunner({
      backendFactory: () =>
        failing("the claude CLI is not signed in", "unauthorized"),
      onEvent: (event) => {
        if (event.type === "service-not-signed-in") seen.push(event.detail);
      },
    });

    await runner.runJob(job());
    expect(seen).toEqual(["the claude CLI is not signed in"]);
    const entries = await ingress.read();
    expect(JSON.stringify(entries)).toContain(
      "the claude CLI is not signed in",
    );
  });

  /* `retryable` still travels: whether to try again is the site's decision
     and says nothing about whose machine it was. */
  it("still tells the site whether trying again is worth it", async () => {
    const { runner } = await makeRunner({
      backendFactory: () =>
        ({
          execute: () =>
            Promise.resolve({
              ok: false as const,
              code: "timeout" as const,
              message: "the claude CLI did not answer within 120000ms",
              durationMs: 1,
            }),
        }) as unknown as Backend,
    });

    const outcome = await runner.runJob(job());
    expect(outcome).toMatchObject({ code: "timeout", retryable: true });
    expect(JSON.stringify(outcome)).not.toMatch(/claude/i);
  });
});
