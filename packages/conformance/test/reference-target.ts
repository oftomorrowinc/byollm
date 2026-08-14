import {
  ByollmApp,
  MemoryStore,
  createFetchHandler,
  generateSiteKeys,
  type ByollmStore,
} from "@byollm/server";
import type { ConformanceTarget } from "../src/index.js";

const ORIGIN = "https://reference.byollm.test";
const LEASE_MS = 2_000;
const TTL_MS = 1_500;
/**
 * One site identity for the life of this target.
 *
 * `reset()` clears state between checks, but a site does not get a new
 * identity when it restarts — and modelling one that did would quietly make
 * every pinning check untestable.
 */
const SITE_KEYS = generateSiteKeys();

/**
 * A controllable clock shared by the handlers and the app.
 *
 * The reference server can fake time, so the lease and TTL checks run in
 * milliseconds instead of seconds. A target that cannot (a real Postgres, say)
 * omits `advanceTime` and the kit waits for real — which is why both this
 * target's `leaseMs` and `ttlMs` are short enough to be waited on either way.
 */
class Clock {
  #now = 1_800_000_000_000;
  now = (): number => this.#now;
  advance(ms: number): void {
    this.#now += ms;
  }
}

/**
 * The reference implementation, as a conformance target.
 *
 * This is what CI certifies on every PR. If the kit and the reference server
 * ever disagree, one of them is wrong and the build says so.
 */
export function referenceTarget(): ConformanceTarget {
  let clock = new Clock();
  let store: ByollmStore & MemoryStore = new MemoryStore({
    defaultTtlMs: TTL_MS,
  });
  let app = new ByollmApp({ store, now: clock.now });
  let handler = createFetchHandler({
    store,
    verificationUrl: `${ORIGIN}/settings/runners`,
    siteKeys: SITE_KEYS,
    leaseMs: LEASE_MS,
    now: clock.now,
  });

  return {
    name: "@byollm/server reference (in-memory)",
    origin: ORIGIN,
    leaseMs: LEASE_MS,
    ttlMs: TTL_MS,

    fetch: (request) => handler(request),

    enqueue: async (input) => {
      const handle = await app.enqueue({
        kind: input.kind,
        payload: input.payload,
        owner: input.owner,
        ...(input.audience === undefined ? {} : { audience: input.audience }),
        ...(input.audienceAllow === undefined
          ? {}
          : { audienceAllow: input.audienceAllow }),
        ...(input.dependsOn === undefined
          ? {}
          : { dependsOn: input.dependsOn }),
        ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
      });
      return { id: handle.id };
    },

    approvePairing: async (userCode, owner) => {
      await app.approvePairing({ userCode, owner });
    },

    revokeRunner: (runnerId) => app.revokeRunner(runnerId),

    cancelJob: async (jobId) => {
      await app.cancel(jobId);
    },

    job: async (jobId) => {
      const record = await app.job(jobId);
      if (!record) return null;
      return {
        state: record.state,
        ...(record.outcome === null
          ? {}
          : {
              outcome: {
                outcome: record.outcome.outcome,
                ...(record.outcome.outcome === "ok"
                  ? { text: record.outcome.text }
                  : {}),
              },
            }),
        ...(record.provenance === null
          ? {}
          : {
              provenance: {
                untrusted: record.provenance.untrusted,
                audience: record.provenance.audience,
                runnerOwner: record.provenance.runnerOwner,
              },
            }),
      };
    },

    runnerAvailability: async (input) => {
      const availability = await app.runnerAvailability(input);
      return {
        available: availability.available,
        ...(availability.reason === undefined
          ? {}
          : { reason: availability.reason }),
      };
    },

    sweep: async () => {
      await app.sweep();
    },

    advanceTime: (ms) => {
      clock.advance(ms);
      return Promise.resolve();
    },

    reset: () => {
      clock = new Clock();
      store = new MemoryStore({ defaultTtlMs: TTL_MS });
      app = new ByollmApp({ store, now: clock.now });
      handler = createFetchHandler({
        store,
        verificationUrl: `${ORIGIN}/settings/runners`,
        siteKeys: SITE_KEYS,
        leaseMs: LEASE_MS,
        now: clock.now,
      });
      return Promise.resolve();
    },
  };
}
