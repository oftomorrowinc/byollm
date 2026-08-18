import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENVELOPE_MAX_AGE_MS,
  PROTOCOL_VERSION,
  keyId,
  open,
  seal,
  type JobOutcome,
  publicIdentityOf,
  signRequest,
  type PublicIdentity,
  type SealedEnvelope,
  type StoredKeys,
  type Capability,
  type ClaimedStub,
} from "@byollm/protocol";
import {
  Allowlist,
  Budgets,
  IngressLog,
  SpendLedger,
  ProtocolClient,
  DeviceIdentity,
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
  /** This daemon's keys, so a check can sign as it — or deliberately not. */
  readonly keys: StoredKeys;
  /** This daemon's keys, and the site identity it pinned at pairing. */
  identityKeys(): Promise<StoredKeys>;
  readonly sitePinned: PublicIdentity;
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
  // A real DeviceIdentity per harness daemon, backed by its own temp home —
  // not a shared fixture. Each simulated daemon is a distinct machine, which
  // is what makes a multi-runner check (C019) mean anything.
  const deviceIdentity = new DeviceIdentity(join(home, "keys.json"));

  const pairing = connect({
    client: pairingClient,
    daemonVersion: "conformance",
    device: await deviceIdentity.publicIdentity(Date.now()),
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
      // The harness signs exactly as a daemon does, so certification
      // exercises the real verification path.
      identity: {
        runnerId: result.pairing.runnerId,
        sign: (input) => deviceIdentity.signRequest(input),
      },
      fetch: fetchImpl,
    }),
    runnerId: result.pairing.runnerId,
    owner: result.pairing.owner,
    identity: {
      keys: () => deviceIdentity.load(Date.now()),
      // Pinned at pairing, exactly as a real daemon does.
      sitePinned: result.pairing.site,
    },
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
    keys: await deviceIdentity.load(Date.now()),
    identityKeys: () => deviceIdentity.load(Date.now()),
    sitePinned: result.pairing.site,
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
      await removeHome(home);
    },
    abandon: async () => {
      await removeHome(home);
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
/**
 * Longest real sleep a check may ask of a target that cannot fake time.
 *
 * A target with no `advanceTime` waits for real, so a check written against
 * the reference server's fake clock can silently become a ten-minute hang
 * somewhere else — which is exactly what `C020_PAIR_CODE_EXPIRES` did on the
 * Supabase target, whose pairing TTL was still the ten-minute product
 * default. Failing fast with the number in the message turns "CI is stuck"
 * into "configure a shorter TTL on this target".
 */
const MAX_REAL_WAIT_MS = 30_000;

export async function advance(
  target: ConformanceTarget,
  ms: number,
): Promise<void> {
  if (target.advanceTime) {
    await target.advanceTime(ms);
  } else {
    if (ms > MAX_REAL_WAIT_MS) {
      throw new Error(
        `this check needs to advance ${String(Math.round(ms / 1000))}s and ` +
          `"${target.name}" cannot fake time, so it would sleep for real. ` +
          `Configure a shorter TTL on the target, or give it advanceTime().`,
      );
    }
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
): Promise<ClaimedStub> {
  const capabilities = await daemon.runner.detectCapabilities();
  // Signed, not bearer. This helper predated signed requests and kept
  // sending a token: it 401'd the moment a check actually used it, which
  // C022 had not.
  const body = JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    runnerId: daemon.runnerId,
    capabilities,
    max: 1,
  });
  const signature = signRequest(daemon.keys, {
    endpoint: "claim",
    runnerId: daemon.runnerId,
    issuedAt: Date.now(),
    body,
  });
  const response = await target.fetch(
    new Request(`${target.origin}/byollm/claim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-byollm-runner": signature.runnerId,
        "x-byollm-issued-at": String(signature.issuedAt),
        "x-byollm-signature": signature.signature,
      },
      body,
    }),
  );
  if (response.status !== 200) {
    throw new Error(`claim answered ${String(response.status)}`);
  }
  const parsed = (await response.json()) as { jobs: ClaimedStub[] };
  const job = parsed.jobs[0];
  if (!job) throw new Error("claim returned no jobs");
  return job;
}

/**
 * Release one named lease over the wire, signed, as a daemon would.
 *
 * Raw rather than through the runner, because the property under test is what
 * the *server* does with a request naming a particular grant — including a
 * request the daemon would never send twice.
 */
export async function releaseLease(
  target: ConformanceTarget,
  daemon: HarnessDaemon,
  jobId: string,
  leaseId: string,
): Promise<Response> {
  const body = JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    runnerId: daemon.runnerId,
    leases: [{ jobId, leaseId }],
    reason: "backend-down",
  });
  const signature = signRequest(daemon.keys, {
    endpoint: "release",
    runnerId: daemon.runnerId,
    issuedAt: Date.now(),
    body,
  });
  return target.fetch(
    new Request(`${target.origin}/byollm/release`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-byollm-runner": signature.runnerId,
        "x-byollm-issued-at": String(signature.issuedAt),
        "x-byollm-signature": signature.signature,
      },
      body,
    }),
  );
}

/**
 * Collect a payload for a lease, signed. Returns `null` when refused.
 *
 * A refusal is a normal answer here, not an error: the check asks both
 * whether a held lease can fetch and whether an unheld one cannot.
 */
export async function fetchPayload(
  target: ConformanceTarget,
  daemon: HarnessDaemon,
  jobId: string,
  leaseId: string,
): Promise<{ raw: unknown; opened: unknown } | null> {
  const body = JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    runnerId: daemon.runnerId,
    jobId,
    leaseId,
  });
  const signature = signRequest(daemon.keys, {
    endpoint: "fetch",
    runnerId: daemon.runnerId,
    issuedAt: Date.now(),
    body,
  });
  const response = await target.fetch(
    new Request(`${target.origin}/byollm/fetch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-byollm-runner": signature.runnerId,
        "x-byollm-issued-at": String(signature.issuedAt),
        "x-byollm-signature": signature.signature,
      },
      body,
    }),
  );
  // `null` for a refusal — a normal answer here, not an error.
  if (response.status !== 200) return null;

  // Both halves are returned: the raw response, so a check can assert no
  // plaintext crossed the wire, and the opened work, so it can assert the
  // device it was sealed to can still read it.
  const raw = (await response.json()) as { envelope: SealedEnvelope };
  const keys = await daemon.identityKeys();
  const opened = await open({
    envelope: raw.envelope,
    recipientKeys: keys,
    senderIdentityPublic: daemon.sitePinned.identity,
    expected: {
      jobId,
      senderKeyId: keyId(daemon.sitePinned.identity),
      recipientKeyId: keyId(publicIdentityOf(keys).identity),
      direction: "payload",
    },
  });
  return {
    raw,
    opened: opened.ok ? (JSON.parse(opened.plaintext) as unknown) : null,
  };
}

/**
 * Report a result, sealed to the site — with the sealing key left open.
 *
 * `sealWith` defaults to the daemon's own keys, which is what a real daemon
 * does. A check passes something else to be the relay: the request is still
 * signed by the genuine device, so what the site is being asked to swallow is
 * an *outcome* nobody it trusts produced. Separating the two keys is the whole
 * point — an implementation that only checked the request signature would look
 * correct until this check ran.
 */
export async function postResult(
  target: ConformanceTarget,
  daemon: HarnessDaemon,
  input: {
    jobId: string;
    outcome: JobOutcome;
    sealWith?: StoredKeys;
    disposition?: "ok" | "error" | "canceled";
    /** The grant the work was done under — cloud_008 §1.4a. */
    leaseId: string;
  },
): Promise<Response> {
  const keys = await daemon.identityKeys();
  const sealer = input.sealWith ?? keys;
  const envelope = await seal({
    // `{ outcome, ran }` — cloud_008 §2.5.
    plaintext: JSON.stringify({
      outcome: input.outcome,
      ran: { model: "test-model", backendClass: "http", durationMs: 1 },
    }),
    senderKeys: sealer,
    recipientEncryptionPublic: daemon.sitePinned.encryption,
    context: {
      jobId: input.jobId,
      // Always the *device's* key id, even when a relay sealed it: an
      // attacker naming itself would be refused for the wrong reason, and
      // this check exists to prove the signature is what refuses it.
      senderKeyId: keyId(publicIdentityOf(keys).identity),
      recipientKeyId: keyId(daemon.sitePinned.identity),
      deadlineAt: Date.now() + ENVELOPE_MAX_AGE_MS,
      direction: "result",
    },
  });

  const body = JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    runnerId: daemon.runnerId,
    jobId: input.jobId,
    leaseId: input.leaseId,
    envelope,
    disposition: input.disposition ?? input.outcome.outcome,
  });
  const signature = signRequest(daemon.keys, {
    endpoint: "result",
    runnerId: daemon.runnerId,
    issuedAt: Date.now(),
    body,
  });
  return target.fetch(
    new Request(`${target.origin}/byollm/result`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-byollm-runner": signature.runnerId,
        "x-byollm-issued-at": String(signature.issuedAt),
        "x-byollm-signature": signature.signature,
      },
      body,
    }),
  );
}

/**
 * Remove a harness home, tolerating a write that lands mid-removal.
 *
 * `rm -rf` walks a tree; a file created during the walk makes the parent
 * non-empty again and the whole call fails with ENOTEMPTY. The daemon writes
 * lazily — its key file appears the first time anything asks for its
 * identity — so a late call can land after the last job has finished, which
 * is what `dispose` waits for.
 *
 * Retried rather than serialised, because the alternative is the harness
 * knowing every path on which the daemon might touch disk, which it should
 * not have to.
 */
async function removeHome(home: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rm(home, { recursive: true, force: true });
      return;
    } catch {
      await sleep(20);
    }
  }
  // A leaked temp directory is not worth failing a conformance run over.
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
}

/** Enqueue, claim and open one job — the happy path, end to end. */
export async function fetchGenuine(
  target: ConformanceTarget,
  daemon: HarnessDaemon,
  owner = "alice",
): Promise<boolean> {
  const marker = "genuine work";
  await target.enqueue({
    kind: "llm.generate",
    payload: { prompt: marker },
    // The target's own name for the user, not the id it mapped that to —
    // passing a mapped id back in addresses a user the target never made.
    owner,
    audience: "self",
  });
  // Retried: an in-memory store makes a job claimable the instant enqueue
  // returns, and a real database does not. Claiming once passes everywhere
  // the kit is developed and fails where it is meant to certify.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const stub = await claimOne(target, daemon);
      const fetched = await fetchPayload(
        target,
        daemon,
        stub.id,
        stub.lease.id,
      );
      return JSON.stringify(fetched?.opened ?? {}).includes(marker);
    } catch {
      await sleep(50);
    }
  }
  return false;
}
