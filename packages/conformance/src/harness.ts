import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@byollm/protocol";
import {
  Allowlist,
  Budgets,
  IngressLog,
  ProtocolClient,
  Runner,
  connect,
  resolveConfig,
  DaemonConfig,
  type Backend,
  type BackendRequest,
  type BackendResult,
  type LoadedConfig,
} from "@byollm/daemon";
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

  health(): Promise<{ healthy: boolean; models: string[] }> {
    return Promise.resolve({ healthy: true, models: ["echo-model"] });
  }

  async execute(request: BackendRequest): Promise<BackendResult> {
    this.seen.push(request.prompt);
    const started = Date.now();

    if (this.hangMs > 0) {
      const hung = await new Promise<"done" | "aborted">((resolve) => {
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
  readonly home: string;
  readonly ingress: IngressLog;
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
}): LoadedConfig {
  const backendId = options.subscription ? "claude-cli" : "openai-http";
  return resolveConfig(
    DaemonConfig.parse({
      backends: {
        primary: {
          backend: backendId,
          ...(options.subscription
            ? {}
            : { baseUrl: "http://127.0.0.1:11434/v1" }),
          offer: options.offer,
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
export async function pairDaemon(
  target: ConformanceTarget,
  options: {
    owner: string;
    label?: string;
    offer?: "self" | "named" | "public";
    /** Use the subscription-class backend, to exercise the self-lock. */
    subscription?: boolean;
  },
): Promise<HarnessDaemon> {
  const home = await mkdtemp(join(tmpdir(), "byollm-conformance-"));
  const loaded = daemonConfig({
    offer: options.offer ?? "self",
    subscription: options.subscription ?? false,
  });

  const allowlist = new Allowlist(join(home, "allow.json"));
  await allowlist.load();
  const budgets = new Budgets(
    join(home, "budgets.json"),
    loaded.config.community,
  );
  await budgets.load(Date.now());
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
    ingress,
    backendFactory: () => backend,
  });

  return {
    runner,
    backend,
    allowlist,
    runnerId: result.pairing.runnerId,
    owner: result.pairing.owner,
    home,
    ingress,
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
