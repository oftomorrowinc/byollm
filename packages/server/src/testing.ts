import type { Capability } from "@byollm/protocol";
import { ByollmApp } from "./app.js";
import {
  ENVELOPE_MAX_AGE_MS,
  generateKeys,
  keyId,
  publicIdentityOf,
  seal,
  signRequest,
  type Endpoint,
  type JobOutcome,
  type StoredKeys,
} from "@byollm/protocol";
import { generateSiteKeys } from "./keys.js";
import { type HandlerResult, ByollmHandlers } from "./handlers.js";
import { MemoryStore } from "./memory.js";

/**
 * A controllable clock.
 *
 * Tests that assert lease expiry and TTL need to move time, and doing that
 * with real sleeps would make the suite slow *and* flaky. Every time-reading
 * path in this package takes an injected `now`, so nothing here has to guess.
 */
class FakeClock {
  #current: number;

  constructor(start = 1_700_000_000_000) {
    this.#current = start;
  }

  now = (): number => this.#current;

  advance(ms: number): void {
    this.#current += ms;
  }

  set(ms: number): void {
    this.#current = ms;
  }
}

/** A capability matrix serving both v1 kinds from a local HTTP model. */
export function httpCapabilities(
  offerScope: Capability["offerScope"] = "private",
  model = "gemma4:26b",
): Capability[] {
  return [
    {
      kind: "llm.generate",
      service: "local",
      backendId: "openai-http",
      backendClass: "http",
      model,
      offerScope,
    },
    {
      kind: "llm.chat",
      service: "local",
      backendId: "openai-http",
      backendClass: "http",
      model,
      offerScope,
    },
  ];
}

/** A capability matrix backed by the subscription-class claude CLI. */
export function subscriptionCapabilities(
  offerScope: Capability["offerScope"] = "private",
): Capability[] {
  return [
    {
      kind: "llm.generate",
      service: "local",
      backendId: "claude-cli",
      backendClass: "process",
      model: "claude-opus-5",
      offerScope,
    },
  ];
}

export interface Harness {
  /** A clock the tests can move, described structurally so the class stays internal. */
  readonly clock: {
    now(): number;
    advance(ms: number): void;
    set(ms: number): void;
  };
  readonly store: MemoryStore;
  readonly app: ByollmApp;
  readonly handlers: ByollmHandlers;
  /** Pair a daemon end to end and return its ids and signing keys. */
  pair(args?: {
    owner?: string;
    label?: string;
    capabilities?: Capability[];
  }): Promise<PairedRunner>;
  /**
   * Call an authenticated endpoint as a paired runner would — signed.
   *
   * Tests go through the real verification path rather than a bypass, so a
   * change that breaks signing breaks the tests rather than being papered
   * over by a harness that skips it.
   */
  call(
    endpoint: Endpoint,
    body: Record<string, unknown>,
    runner: PairedRunner,
  ): Promise<HandlerResult>;
  /**
   * Build a `result` body the way a daemon does — sealed to the site, signed
   * by the device.
   *
   * A helper rather than a per-test fixture because the alternative is
   * eighteen tests each constructing an envelope, and the first time one of
   * them got it slightly wrong the sealing would be quietly untested.
   */
  resultBody(input: {
    jobId: string;
    runner: PairedRunner;
    outcome: JobOutcome;
    model?: string;
    backendClass?: "http" | "process";
    /** The grant the result was produced under — cloud_008 §1.4a. */
    leaseId?: string;
  }): Promise<Record<string, unknown>>;
}

/** A paired daemon, with what it needs to sign. */
export interface PairedRunner {
  readonly token: string;
  readonly runnerId: string;
  readonly owner: string;
  readonly keys: StoredKeys;
}

/**
 * A server wired to the reference store with a fake clock — the fixture both
 * the unit tests and the conformance kit build on.
 */
export function createHarness(
  options: {
    leaseMs?: number;
    defaultTtlMs?: number;
    /** Shrink the no-runner grace so a test need not wait ten real seconds. */
    noRunnerGraceMs?: number;
  } = {},
): Harness {
  const clock = new FakeClock();
  const store = new MemoryStore(
    options.defaultTtlMs === undefined
      ? {}
      : { defaultTtlMs: options.defaultTtlMs },
  );
  const siteKeys = generateSiteKeys();
  const app = new ByollmApp({
    store,
    siteKeys,
    now: clock.now,
    ...(options.noRunnerGraceMs === undefined
      ? {}
      : { noRunnerGraceMs: options.noRunnerGraceMs }),
  });
  const handlers = new ByollmHandlers({
    store,
    verificationUrl: "https://app.test/settings/runners",
    siteKeys,
    now: clock.now,
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
  });

  /** `pair` carries no signature: it is how a machine gets an identity. */
  const UNAUTHENTICATED = {
    endpoint: "pair",
    rawBody: "",
    signature: undefined,
  };

  async function pair(
    args: {
      owner?: string;
      label?: string;
      capabilities?: Capability[];
    } = {},
  ): Promise<PairedRunner> {
    const owner = args.owner ?? "alice";
    // A real keypair per simulated daemon: the harness signs exactly the way
    // a daemon does, so the tests exercise the real verification path rather
    // than a bypass.
    const deviceKeys = generateKeys(clock.now());
    const start = await handlers.handle(
      "pair",
      {
        protocolVersion: "0",
        action: "start",
        daemon: {
          version: "0.1.0",
          label: args.label ?? "test-machine",
          platform: "darwin",
        },
        // Every simulated daemon gets its own identity, so a test with two
        // runners is a test with two machines.
        device: publicIdentityOf(deviceKeys),
        capabilities: args.capabilities ?? httpCapabilities(),
      },
      UNAUTHENTICATED,
    );
    const started = start.body as { deviceCode: string; userCode: string };
    await app.approvePairing({ userCode: started.userCode, owner });

    const poll = await handlers.handle(
      "pair",
      {
        protocolVersion: "0",
        action: "poll",
        deviceCode: started.deviceCode,
      },
      UNAUTHENTICATED,
    );
    const approved = poll.body as {
      status: string;
      runnerToken: string;
      runnerId: string;
    };
    if (approved.status !== "approved") {
      throw new Error(`pairing did not approve: ${approved.status}`);
    }
    return {
      token: approved.runnerToken,
      runnerId: approved.runnerId,
      owner,
      keys: deviceKeys,
    };
  }

  /** Call an authenticated endpoint as this runner would: signed. */
  async function call(
    endpoint: Endpoint,
    body: Record<string, unknown>,
    runner: { runnerId: string; keys: StoredKeys },
  ): Promise<HandlerResult> {
    const rawBody = JSON.stringify(body);
    return handlers.handle(endpoint, body, {
      endpoint,
      rawBody,
      signature: signRequest(runner.keys, {
        endpoint,
        runnerId: runner.runnerId,
        issuedAt: clock.now(),
        body: rawBody,
      }),
    });
  }

  /** Seal an outcome back to the site, exactly as the daemon's runner does. */
  async function resultBody(input: {
    jobId: string;
    runner: PairedRunner;
    outcome: JobOutcome;
    model?: string;
    backendClass?: "http" | "process";
    /**
     * The grant this result was produced under — cloud_008 §1.4a.
     *
     * Defaults to the job's current lease, because for most tests here the
     * lease is not the subject and "the grant I hold" is what a daemon would
     * send. Tests *about* `LEASE_HONORED` pass a stale id explicitly, which
     * is the only way this default could hide anything.
     */
    leaseId?: string;
  }): Promise<Record<string, unknown>> {
    const envelope = await seal({
      // The sealed shape is `{ outcome, ran }` — cloud_008 §2.5. A daemon
      // signs how it ran alongside what it produced.
      plaintext: JSON.stringify({
        outcome: input.outcome,
        ran: {
          model: input.model ?? "test-model",
          backendClass: input.backendClass ?? "http",
          durationMs: 1,
        },
      }),
      senderKeys: input.runner.keys,
      recipientEncryptionPublic: publicIdentityOf(siteKeys).encryption,
      context: {
        jobId: input.jobId,
        senderKeyId: keyId(publicIdentityOf(input.runner.keys).identity),
        recipientKeyId: keyId(publicIdentityOf(siteKeys).identity),
        deadlineAt: clock.now() + ENVELOPE_MAX_AGE_MS,
        direction: "result",
      },
    });
    return {
      protocolVersion: "0",
      runnerId: input.runner.runnerId,
      jobId: input.jobId,
      leaseId:
        input.leaseId ??
        (await store.get(input.jobId))?.lease?.id ??
        "no-lease",
      envelope,
      disposition: input.outcome.outcome,
    };
  }

  return { clock, store, app, handlers, pair, call, resultBody };
}
