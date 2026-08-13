import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  type Capability,
  type ClaimedJob,
} from "@byollm/protocol";
import {
  Allowlist,
  Budgets,
  IngressLog,
  SpendLedger,
  ProtocolClient,
  Runner,
  connect,
  resolveConfig,
  DaemonConfig,
  type Backend,
  type BackendRequest,
  type BackendResult,
  type LoadedConfig,
} from "byollm";
import type { ConformanceTarget } from "./target.js";

/**
 * A model that answers instantly and predictably.
 *
 * The conformance kit certifies the *protocol*, not anyone's model. Using a
 * real backend would make the suite slow, non-deterministic, and dependent on
 * whatever happens to be installed — so the daemon under test is real in
 * every respect except the thing at the very end of the call.
 */
export class EchoBackend implements Backend {
  readonly id = "openai-http" as const;
  readonly class = "http" as const;
  /** Prompts this backend was asked to run, in order. */
  readonly seen: string[] = [];
  /** Set to make the next call hang, for lease and cancel checks. */
  hangMs = 0;
  /** Set false to simulate the model not being installed or not running. */
  healthy = true;
  /** What the backend reports it can serve. Empty means "does not enumerate". */
  models: string[] = ["echo-model"];

  health(): Promise<{ healthy: boolean; models: string[] }> {
    return Promise.resolve({ healthy: this.healthy, models: this.models });
  }

  async execute(request: BackendRequest): Promise<BackendResult> {
    this.seen.push(request.prompt);
    const started = Date.now();

    if (this.hangMs > 0) {
      // `aborted` first: a signal that has already fired never calls a
      // listener added afterwards. The real backends check the same way.
      const hung = request.signal.aborted
        ? "aborted"
        : await new Promise<"done" | "aborted">((resolve) => {
            const timer = setTimeout(() => {
              resolve("done");
            }, this.hangMs);
            request.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve("aborted");
              },
              { once: true },
            );
          });
      if (hung === "aborted") {
        return {
          ok: false,
          code: "canceled",
          message: "the job was canceled",
          retryable: false,
          durationMs: Date.now() - started,
        };
      }
    }

    return {
      ok: true,
      text: `echo: ${request.prompt}`,
      durationMs: Date.now() - started,
    };
  }
}

export interface HarnessDaemon {
  readonly runner: Runner;
  readonly backend: EchoBackend;
  readonly allowlist: Allowlist;
  readonly runnerId: string;
  readonly owner: string;
  /** The runner token, for checks that drive the protocol wire directly. */
  readonly token: string;
  readonly home: string;
  readonly ingress: IngressLog;
  /** The owner's spend ledger, so a check can drive it past its ceiling. */
  readonly spend: SpendLedger;
  /** The resolved config — the effective offer scope lives here. */
  readonly loaded: LoadedConfig;
  /** Stop cleanly: cancel in-flight work and clean up. */
  dispose(): Promise<void>;
  /**
   * Simulate `kill -9`: clean up the daemon's files but do **not** cancel its
   * in-flight work, so nothing is released and no result is ever reported.
   *
   * Cancelling would make the backend return `canceled`, the runner would
   * dutifully report it, and the job would reach a terminal state — which is
   * the opposite of the lease-reclaim scenario being tested.
   */
  abandon(): Promise<void>;
}

/** Build the daemon-side config for a given offer scope and backend class. */
function daemonConfig(options: {
  offer: "self" | "named" | "public";
  subscription: boolean;
  metered?: MeteredOptions;
}): LoadedConfig {
  const metered = options.metered;
  const backendId = metered
    ? (metered.provider ?? "openai")
    : options.subscription
      ? "claude-cli"
      : "openai-http";
  // A named provider carries its own address; only the generic backend and a
  // deliberate override need one written down. Note that a base URL never
  // changes a named provider's cost — that is the point of the checks that
  // use this ({@link MUSTS.COST_NOT_CONFIGURABLE}).
  const baseUrl = metered
    ? metered.baseUrl
    : options.subscription
      ? undefined
      : "http://127.0.0.1:11434/v1";
  return resolveConfig(
    DaemonConfig.parse({
      backends: {
        primary: {
          backend: backendId,
          ...(baseUrl === undefined ? {} : { baseUrl }),
          offer: options.offer,
          ...(metered === undefined
            ? {}
            : {
                spend: {
                  acknowledged: metered.acknowledged ?? false,
                  ...(metered.dailyCapCents === undefined
                    ? {}
                    : { dailyCapCents: metered.dailyCapCents }),
                },
              }),
        },
      },
      routes: {
        "llm.generate": { backend: "primary", model: "echo-model" },
        "llm.chat": { backend: "primary", model: "echo-model" },
      },
      concurrency: 4,
    }),
  );
}

/**
 * Pair a real daemon against the target and return it, ready to tick.
 *
 * "Real" matters: this is the shipped {@link Runner}, doing the shipped
 * pairing exchange, with the shipped allowlist and budget checks. Only the
 * model at the far end is substituted.
 */
/**
 * A paid backend, and what the owner said about spending on it — byollm_007.
 *
 * The kit needs this because "who pays" is visible on the wire: a daemon
 * advertises the *effective* offer scope, so a metered backend nobody
 * consented to share shows up to the server as `self` and the server is
 * obliged to act on that.
 */
export interface MeteredOptions {
  /**
   * `openai` takes its cost from the registry; `openai-http` has it inferred
   * from {@link MeteredOptions.baseUrl}.
   */
  readonly provider?: "openai" | "openai-http";
  readonly baseUrl?: string;
  readonly acknowledged?: boolean;
  readonly dailyCapCents?: number;
}

export async function pairDaemon(
  target: ConformanceTarget,
  options: {
    owner: string;
    label?: string;
    offer?: "self" | "named" | "public";
    /** Use the subscription-class backend, to exercise the self-lock. */
    subscription?: boolean;
    /** Use a paid backend, to exercise the cost rules. */
    metered?: MeteredOptions;
  },
): Promise<HarnessDaemon> {
  const home = await mkdtemp(join(tmpdir(), "byollm-conformance-"));
  const loaded = daemonConfig({
    offer: options.offer ?? "self",
    subscription: options.subscription ?? false,
    ...(options.metered === undefined ? {} : { metered: options.metered }),
  });

  const allowlist = new Allowlist(join(home, "allow.json"));
  await allowlist.load();
  const budgets = new Budgets(
    join(home, "budgets.json"),
    loaded.config.community,
  );
  await budgets.load(Date.now());
  const spend = new SpendLedger(join(home, "spend.json"));
  await spend.load(Date.now());
  const ingress = new IngressLog({
    path: join(home, "ingress.log"),
    communityPromptDays: 7,
    keepSelfPrompts: true,
  });

  const backend = new EchoBackend();
  // `Request` accepts every shape `fetch` does, so the target sees a normal
  // request whether the kit is driving an in-process handler or a real server.
  const fetchImpl: typeof fetch = (input, init) =>
    target.fetch(new Request(input, init));

  const capabilities: Capability[] = loaded.routes.map((route) => ({
    kind: route.kind,
    backendId: route.backendId,
    backendClass: route.backendClass,
    model: route.model,
    offerScope: route.offerScope,
  }));

  const pairingClient = new ProtocolClient({
    origin: target.origin,
    fetch: fetchImpl,
  });

  let userCode = "";
  // The poll must be abortable and its rejection must always be handled: a
  // check that fails partway through would otherwise leave a pairing loop
  // running, and when the next check's `reset()` wipes the pairings table
  // that orphan turns into an unhandled rejection that kills the whole run
  // instead of failing one check.
  const pairingAbort = new AbortController();
  let pairingError: unknown;
  const pairing = connect({
    client: pairingClient,
    daemonVersion: "conformance",
    label: options.label ?? `daemon-${options.owner}`,
    capabilities,
    onCode: (info) => {
      userCode = info.userCode;
    },
    // A real macrotask, not `Promise.resolve()`: a zero-delay microtask loop
    // never yields to the event loop, so the approval below could never run
    // and the poll would spin until the process died.
    sleep: () => sleep(1),
    signal: pairingAbort.signal,
  }).catch((error: unknown) => {
    pairingError = error;
    return { ok: false as const, reason: "aborted" as const, message: "" };
  });

  try {
    // Approve as soon as the code exists, exactly as a user clicking would.
    await waitFor(() => userCode !== "", { what: "a pairing code" });
    await target.approvePairing(userCode, options.owner);
  } catch (error) {
    pairingAbort.abort();
    await pairing;
    await rm(home, { recursive: true, force: true });
    throw error;
  }

  const result = await pairing;
  if (!result.ok) {
    pairingAbort.abort();
    await rm(home, { recursive: true, force: true });
    throw new Error(
      `conformance harness could not pair: ${
        pairingError instanceof Error ? pairingError.message : result.message
      }`,
    );
  }

  const runner = new Runner({
    client: new ProtocolClient({
      origin: target.origin,
      token: result.pairing.token,
      fetch: fetchImpl,
    }),
    runnerId: result.pairing.runnerId,
    owner: result.pairing.owner,
    daemonVersion: "conformance",
    loaded,
    allowlist,
    budgets,
    spend,
    ingress,
    backendFactory: () => backend,
  });

  return {
    runner,
    backend,
    allowlist,
    runnerId: result.pairing.runnerId,
    owner: result.pairing.owner,
    token: result.pairing.token,
    home,
    ingress,
    spend,
    loaded,
    dispose: async () => {
      runner.cancelAll();
      // Wait for cancelled jobs to finish unwinding before removing the
      // directory: a job still writing its outcome to the ingress log would
      // otherwise fail on a path that no longer exists.
      await waitFor(() => runner.status().activeJobs === 0, {
        timeoutMs: 2_000,
        what: "in-flight jobs to unwind",
      }).catch(() => undefined);
      await rm(home, { recursive: true, force: true });
    },
    abandon: async () => {
      await rm(home, { recursive: true, force: true });
    },
  };
}

/**
 * The id this target uses for a person, given the friendly name the checks
 * use. Identity when the target does not translate.
 */
export async function ownerIdFor(
  target: ConformanceTarget,
  name: string,
): Promise<string> {
  return target.ownerId ? target.ownerId(name) : name;
}

/** Poll a predicate until it holds or the deadline passes. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${String(timeoutMs)}ms waiting for ${options.what ?? "a condition"}`,
      );
    }
    await sleep(intervalMs);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Move the target's clock forward, faking it if the target can and genuinely
 * waiting if it cannot.
 */
export async function advance(
  target: ConformanceTarget,
  ms: number,
): Promise<void> {
  if (target.advanceTime) {
    await target.advanceTime(ms);
  } else {
    await sleep(ms);
  }
  await target.sweep();
}

/**
 * Claim one job over the protocol wire, bypassing the runner.
 *
 * `runner.tick()` claims and *runs*, which is what most checks want. This is
 * for the ones that need to inspect the claim response itself — what the
 * server hands a daemon is a protocol surface in its own right, and the
 * daemon's own handling of it can mask what arrived.
 */
export async function claimOne(
  target: ConformanceTarget,
  daemon: HarnessDaemon,
): Promise<ClaimedJob> {
  const capabilities = await daemon.runner.detectCapabilities();
  const response = await target.fetch(
    new Request(`${target.origin}/byollm/claim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        runnerId: daemon.runnerId,
        capabilities,
        max: 1,
      }),
    }),
  );
  if (response.status !== 200) {
    throw new Error(`claim answered ${String(response.status)}`);
  }
  const body = (await response.json()) as { jobs: ClaimedJob[] };
  const job = body.jobs[0];
  if (!job) throw new Error("claim returned no jobs");
  return job;
}
