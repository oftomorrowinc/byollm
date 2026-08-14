import type { Capability } from "@byollm/protocol";
import { ByollmApp } from "./app.js";
import {
  generateKeys,
  publicIdentityOf,
  signRequest,
  type Endpoint,
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
  offerScope: Capability["offerScope"] = "self",
  model = "gemma4:26b",
): Capability[] {
  return [
    {
      kind: "llm.generate",
      backendId: "openai-http",
      backendClass: "http",
      model,
      offerScope,
    },
    {
      kind: "llm.chat",
      backendId: "openai-http",
      backendClass: "http",
      model,
      offerScope,
    },
  ];
}

/** A capability matrix backed by the subscription-class claude CLI. */
export function subscriptionCapabilities(
  offerScope: Capability["offerScope"] = "self",
): Capability[] {
  return [
    {
      kind: "llm.generate",
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
  const app = new ByollmApp({
    store,
    now: clock.now,
    ...(options.noRunnerGraceMs === undefined
      ? {}
      : { noRunnerGraceMs: options.noRunnerGraceMs }),
  });
  const handlers = new ByollmHandlers({
    store,
    verificationUrl: "https://app.test/settings/runners",
    siteKeys: generateSiteKeys(),
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

  return { clock, store, app, handlers, pair, call };
}
