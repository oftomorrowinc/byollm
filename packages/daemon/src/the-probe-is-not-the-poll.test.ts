import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateKeys,
  keyId,
  publicIdentityOf,
  seal,
  signRequest,
} from "@byollm/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Backend,
  BackendRequest,
  BackendResult,
} from "./backends/index.js";
import { Budgets } from "./budgets.js";
import { readHeartbeat } from "./heartbeat.js";
import { ProtocolClient } from "./client.js";
import { DaemonConfig, resolveConfig } from "./config.js";
import { IngressLog } from "./ingress.js";
import { Runner } from "./runner.js";
import { SpendLedger } from "./spend.js";
import { removeTemp } from "./test-support.js";

/**
 * The probe and the poll came apart — B198.
 *
 * Todd: *"Do we really check a poll every time we go to send a message…?
 * Shouldn't we do that poll every 15 minutes or something and use the stored
 * value?"*
 *
 * `health()` spawns `<cli> --version` per configured CLI, and `#tick()` ran it
 * before every claim — about 17,000 spawns a day. **Measured in the box image:
 * ~25 ms bursting at the box's 500m limit, ~2 s throttled to its 50m request.**
 * The box requests 50m and limits 500m, so the cost is invisible on a quiet
 * node and eighty times worse on a contended one — and the probe runs before
 * the claim on the same tick, so under contention it stretches the claim
 * cadence, which is queue latency.
 *
 * **Only the polling path caches**, and the interval is not what keeps it
 * honest: a job-time failure forces a fresh probe, because a service that just
 * failed a real call has answered the question `--version` was guessing at.
 */

const SITE_KEYS = generateKeys(1_800_000_000_000);
const SITE_ID = keyId(publicIdentityOf(SITE_KEYS).identity);
const DEVICE_KEYS = generateKeys(1_800_000_000_000);
const SIGNER_KEYS = generateKeys(1_800_000_000_000);
const SIGNER = {
  runnerId: "runner_1",
  sign: (input: {
    endpoint: string;
    runnerId: string;
    issuedAt: number;
    body: string;
  }) => signRequest(SIGNER_KEYS, input).signature,
};

/** Counts what the probe costs: one `health()` is one `--version` spawn. */
let probes = 0;
/** Whether the backend fails the job — the invalidation case. */
let failJobs = false;
/** Whether the CLI is signed out: refuses jobs, and its canary says no. */
let signedOut = false;
/**
 * Holds a claimed job open, so a slot can be observed as BUSY — B212.
 *
 * The backend here answers instantly, which is right for every other case and
 * useless for one about capacity: by the time a test looks, the job has
 * finished and the slot is free again. `release()` ends it.
 */
let holding: (() => void) | undefined;
/** Every canary attempt — the spawn the recheck interval is spacing out. */
let canaries = 0;
/** When a quota block lifts, or undefined for a backend with no quota fault. */
let quotaUntil: number | undefined;
/** Whether the CLI is absent — `--version` finds nothing to run. */
let missing = false;

class CountingBackend implements Backend {
  readonly stopReasons = {
    kind: "unavailable" as const,
    why: "a test double reads no vendor signal",
  };
  readonly id = "openai-http" as const;
  readonly class = "http" as const;
  health(): Promise<{ healthy: boolean; models: string[] }> {
    probes += 1;
    return Promise.resolve(
      missing
        ? { healthy: false, models: [] }
        : { healthy: true, models: ["m"] },
    );
  }
  canary(): Promise<{ healthy: boolean; models: string[] }> {
    canaries += 1;
    return Promise.resolve({ healthy: !signedOut, models: ["m"] });
  }
  execute(_request: BackendRequest): Promise<BackendResult> {
    if (holding !== undefined) {
      return new Promise<BackendResult>((resolve) => {
        holding = () => {
          resolve({ ok: true, text: "answered", durationMs: 1, stop: "end" });
        };
      });
    }
    if (quotaUntil !== undefined) {
      return Promise.resolve({
        ok: false,
        code: "quota-exhausted" as const,
        message: "the claude CLI failed: You've hit your usage limit",
        durationMs: 1,
        until: quotaUntil,
      });
    }
    if (signedOut) {
      return Promise.resolve({
        ok: false,
        code: "unauthorized" as const,
        message: "the claude CLI is not signed in",
        durationMs: 1,
      });
    }
    return Promise.resolve(
      failJobs
        ? {
            ok: false,
            code: "backend-error" as const,
            message: "the vendor said no",
            durationMs: 1,
          }
        : { ok: true, text: "answered", durationMs: 1, stop: "end" as const },
    );
  }
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-b198-"));
  probes = 0;
  failJobs = false;
  signedOut = false;
  canaries = 0;
  quotaUntil = undefined;
  missing = false;
  holding = undefined;
});
afterEach(async () => {
  await removeTemp(dir);
});

const FIFTEEN_MINUTES = 15 * 60_000;

async function makeRunner() {
  const loaded = resolveConfig(
    DaemonConfig.parse({
      /* One slot, so 'every slot is busy' is reachable with a single job —
         and it is what a hosted box runs (B185 pins concurrency 1). */
      concurrency: 1,
      services: {
        primary: {
          model: "m",
          kinds: ["llm.generate"],
          type: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
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

  const events: string[] = [];
  let clock = 1_800_000_000_000;
  /** One job, once — enough to fail and invalidate. */
  let offerJob = false;
  /**
   * Whether a claimed job has reached an end.
   *
   * An object rather than a `let`, so the compiler cannot narrow a boolean the
   * event handler writes — the reason `poison-job.test.ts` gives for the same
   * shape.
   */
  const settled = { yet: false };
  /* Reset through a helper, or the compiler narrows `yet` to the literal just
     assigned and calls the wait below dead — `poison-job.test.ts` records the
     same workaround, and I applied only half of it the first time. */
  const reset = (): void => {
    settled.yet = false;
  };
  const runner = new Runner({
    client: new ProtocolClient({
      origin: "https://app.test",
      identity: SIGNER,
      fetch: (input) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.endsWith("/fetch")) {
          return seal({
            plaintext: JSON.stringify({ prompt: "hi" }),
            senderKeys: SITE_KEYS,
            recipientEncryptionPublic: DEVICE_KEYS.encryptionPublic,
            context: {
              jobId: "job_1",
              senderKeyId: keyId(publicIdentityOf(SITE_KEYS).identity),
              recipientKeyId: keyId(publicIdentityOf(DEVICE_KEYS).identity),
              deadlineAt: clock + 3_600_000,
              direction: "payload",
            },
          }).then(
            (envelope) =>
              new Response(JSON.stringify({ envelope }), {
                headers: { "content-type": "application/json" },
              }),
          );
        }
        if (url.endsWith("/result")) {
          return Promise.resolve(
            new Response(JSON.stringify({ accepted: true, state: "done" }), {
              headers: { "content-type": "application/json" },
            }),
          );
        }
        const body = url.endsWith("/claim")
          ? JSON.stringify({
              jobs: offerJob
                ? [
                    {
                      id: "job_1",
                      kind: "llm.generate",
                      audience: "private",
                      owner: "me",
                      site: SITE_ID,
                      sizeClass: "small",
                      streaming: false,
                      deadlineAt: clock + 60_000,
                      lease: {
                        id: "lease_job_1",
                        runnerId: "runner_1",
                        expiresAt: clock + 60_000,
                      },
                    },
                  ]
                : [],
              leaseMs: 60_000,
            })
          : JSON.stringify({
              sites: { [SITE_ID]: publicIdentityOf(SITE_KEYS) },
              awaitingConsent: [],
              cancel: [],
              lost: [],
              serverTime: clock,
            });
        return Promise.resolve(
          new Response(body, {
            headers: { "content-type": "application/json" },
          }),
        );
      },
    }),
    runnerId: "runner_1",
    identity: {
      keys: () => Promise.resolve(DEVICE_KEYS),
      sites: new Map([[SITE_ID, publicIdentityOf(SITE_KEYS)]]),
    },
    owner: "me",
    daemonVersion: "0.0.0",
    loaded,
    budgets,
    spend,
    ingress,
    now: () => clock,
    heartbeatPath: join(dir, "heartbeat.json"),
    onEvent: (event) => {
      events.push(event.type);
      if (
        event.type === "finished" ||
        event.type === "refused" ||
        event.type === "error"
      ) {
        settled.yet = true;
      }
    },
    backendFactory: () => new CountingBackend(),
  });

  return {
    runner,
    events,
    /**
     * Read the beat, once it has landed.
     *
     * `#recordBeat` is deliberately fire-and-forget — liveness must not be
     * able to stall the work it describes — so a read immediately after
     * `tick()` can arrive before the write. Production never notices; a test
     * that asserts on the instant does, and waiting on the FILE rather than on
     * a duration is the difference between a slow test and a flaky one.
     */
    beat: async (expected?: number) => {
      const path = join(dir, "heartbeat.json");
      const deadline = Date.now() + 2_000;
      for (;;) {
        const read = await readHeartbeat(path);
        if (
          read !== undefined &&
          (expected === undefined || read.at === expected)
        ) {
          return read;
        }
        if (Date.now() > deadline) return read;
        await new Promise((wake) => setTimeout(wake, 5));
      }
    },
    offer: (yes: boolean) => {
      offerJob = yes;
    },
    tick: () => runner.tick(),
    /**
     * Wait for a claimed job to END — not for `activeJobs` to fall to zero.
     *
     * The first version of this waited on `activeJobs > 0` and exited
     * immediately, because `tick()` returns BEFORE the job is dispatched. The
     * test then finished, `afterEach` removed the temp directory, and the
     * job's ingress write failed with `ENOENT` on a path that had existed
     * moments earlier — which read as "the runner is broken" rather than "the
     * harness left early".
     */
    settle: async () => {
      reset();
      const deadline = Date.now() + 5_000;
      while (!settled.yet && Date.now() < deadline) {
        await new Promise((wake) => setTimeout(wake, 5));
      }
      return settled.yet;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("what a claim costs when nothing has changed", () => {
  it("probes once and then reuses it, instead of once per tick", async () => {
    /* The whole row. Ten ticks used to be ten probes; on a contended box that
       is twenty seconds of CPU to re-learn the same answer. */
    const { tick } = await makeRunner();
    await tick();
    const afterFirst = probes;
    for (let i = 0; i < 9; i += 1) await tick();

    expect(afterFirst, "the first tick still probes").toBeGreaterThan(0);
    expect(probes, "and the next nine do not").toBe(afterFirst);
  });

  it("never probes again while everything it offers is working", async () => {
    /**
     * Todd's amendment, and the whole saving: *"do we even need that if we
     * just try the jobs and assume they are online until we hit an error and
     * know they are not?"*
     *
     * This replaces a control that asserted the opposite — that the cache
     * expires on a clock so an uninstalled CLI stops being advertised. That
     * case is true->false, which a real job's failure already invalidates, and
     * the row accepts the cost by name: the job fails, the release requeues
     * it, another device claims. Paying 17,000 spawns a day to shorten that
     * window is the trade the amendment declines.
     */
    const { tick, advance } = await makeRunner();
    await tick();
    const afterFirst = probes;

    for (let hour = 0; hour < 24; hour += 1) {
      advance(60 * 60_000);
      await tick();
    }
    expect(probes, "a healthy machine probes once, at start").toBe(afterFirst);
  });

  it("looks again for a service it is NOT advertising", async () => {
    /**
     * The half the assumption cannot cover, and the reason the clock is kept
     * for exactly this case.
     *
     * A service that is not advertised is sent no jobs, so no job of its can
     * fail, so failure-invalidation can never fire for it. With no clock at
     * all the owner installs the missing CLI and nothing ever looks again —
     * "assume it is up" turns into "assume it is down, for ever", which is the
     * same silent-and-permanent shape in the other direction.
     */
    missing = true;
    const { tick, advance } = await makeRunner();
    await tick();
    const afterFirst = probes;

    advance(60_000);
    await tick();
    expect(probes, "not on every tick — that was the cost").toBe(afterFirst);

    advance(FIFTEEN_MINUTES + 1);
    await tick();
    expect(
      probes,
      "but it does look again, so an install is noticed without a restart",
    ).toBeGreaterThan(afterFirst);
  });

  it("does not expire early, or the interval means nothing", async () => {
    /* Scoped to the not-advertised arm, which is the only one with an
       interval left to expire. */
    missing = true;
    const { tick, advance } = await makeRunner();
    await tick();
    const afterFirst = probes;
    advance(FIFTEEN_MINUTES - 60_000);
    await tick();

    expect(probes).toBe(afterFirst);
  });

  it("still probes for a person who asks, cache or no cache", async () => {
    /**
     * `detectCapabilities` is untouched, and that is the point of putting the
     * cache on `#tick` rather than inside it. `byollm start`'s canary and the
     * `advertised` read a person triggers both go through here: **somebody who
     * asks is asking now**, and handing them a fifteen-minute-old answer would
     * be the same lie this row is spending a bound to avoid.
     */
    const { runner, tick } = await makeRunner();
    await tick();
    const afterTick = probes;
    await runner.detectCapabilities();

    expect(probes).toBeGreaterThan(afterTick);
  });

  it("re-probes after a job fails, without waiting out the interval", async () => {
    /**
     * **What actually bounds the staleness.** The interval is a cost control;
     * this is the honesty control. A service that just failed a real call has
     * answered the question `--version` was being asked 17,000 times a day to
     * guess at, and answered it with the only evidence that counts.
     *
     * Without it, a CLI that signs out mid-shift keeps being advertised for up
     * to fifteen minutes and every job routed to it fails — which is strictly
     * worse than the cost this row set out to remove.
     */
    const { tick, offer, advance, settle } = await makeRunner();
    await tick();
    const afterFirst = probes;

    failJobs = true;
    offer(true);
    const ended = tick().then(() => settle());
    expect(await ended, "the job reached an end").toBe(true);
    /* Well inside the interval: any re-probe here is the failure's doing. */
    advance(1_000);
    offer(false);
    await tick();

    expect(probes, "the failure forced a fresh probe").toBeGreaterThan(
      afterFirst,
    );
  });

  it("writes a heartbeat every tick, which is what liveness reads", async () => {
    /**
     * B202. `status` calls a daemon dead when this file goes stale, so the
     * daemon has to actually write it — and **nothing checked that until this
     * case**: the status tests write the file themselves, so deleting the
     * daemon's write passed all of them.
     *
     * Found by mutation, not by reading. The fix and its reader can both be
     * right while nothing connects them.
     */
    const { tick, beat } = await makeRunner();

    await tick();
    const first = await beat(1_800_000_000_000);

    expect(first?.at, "stamped with the daemon's clock").toBe(
      1_800_000_000_000,
    );
    expect(first?.pid, "and its pid, so a reader can check it").toBe(
      process.pid,
    );
  });

  it("keeps beating on later ticks, not just the first", async () => {
    /* A beat written once at start would satisfy the case above and would go
       stale under a daemon that is running perfectly — which is the false
       positive this whole row exists to have avoided. */
    const { tick, beat, advance } = await makeRunner();
    await tick();
    advance(30_000);
    await tick();

    expect((await beat(1_800_000_030_000))?.at).toBe(1_800_000_030_000);
  });
});

/**
 * The half of the cache that nothing can invalidate — B198's rider, found
 * reading the row's amendment rather than the code.
 *
 * `#forgetProbe()` has exactly one caller: a failed job. That makes the cache
 * safe in one direction only.
 *
 * - **true -> false** (a service was advertised and has stopped working): a job
 *   is routed to it, the job fails, the probe is forgotten. Self-correcting,
 *   and the row is right that the failure is a better probe than the probe.
 * - **false -> true** (a service was NOT advertised and has started working):
 *   **nothing can trigger a re-probe, because an unadvertised service is sent
 *   no jobs, so no job can fail.** The only thing that ever asked again was the
 *   clock the amendment proposes to drop.
 *
 * Two recoveries live inside `detectCapabilities` and are therefore gated by
 * however often the tick calls it: the signed-out recheck (`AUTH_RECHECK_MS`,
 * 60s — T2-S1's "the remedy has to work") and the quota-block release (019
 * §3.2, *"advertised again with nobody lifting a finger"*).
 */
describe("what a tick tells the poll ladder", () => {
  /**
   * B212. The ladder resets on a PRODUCTIVE tick and climbs on an empty one,
   * so "productive" has to be a fact the tick reports rather than a guess the
   * loop makes. It is the number CLAIMED, not the number finished — the jobs
   * are deliberately not awaited, so "this device just took work" is the only
   * thing knowable at that moment, and it is also the better predictor: a
   * device that just claimed is the one a follow-up is likely for.
   */
  it("reports how many it took, which is what resets the ladder", async () => {
    const { tick, offer, settle } = await makeRunner();
    expect(await tick(), "an empty queue is an unproductive tick").toBe(0);

    offer(true);
    expect(await tick(), "and taking work is a productive one").toBe(1);
    await settle();
  });

  it("reports nothing taken when every slot is busy", async () => {
    /**
     * Found by mutation: making the no-free-slot path report a claim left
     * every case green. It is the worst one to get wrong — a device at its
     * concurrency limit would be read as productive and polled at the FAST
     * end of the ladder, hammering a server to be told each time that it has
     * no room.
     */
    const { tick, offer } = await makeRunner();
    /* The backend parks, so the claimed job keeps its slot while we look. */
    holding = () => {
      /* Replaced by the backend with its own resolver the moment a job
         arrives; this is only the flag that says "park the next one". */
    };
    offer(true);
    expect(await tick(), "the first tick takes the only slot").toBe(1);

    /* The handler is dispatched unawaited, so the slot is taken a turn later.
       Production ticks are seconds apart; these are back to back. */
    await new Promise((wake) => setTimeout(wake, 10));
    expect(await tick(), "and the next one finds no room").toBe(0);
    holding();
  });

  it("reports nothing taken when it is not claiming at all", async () => {
    /**
     * The cases that must NOT read as productive, or a device that is full,
     * draining, or advertising nothing would be polled hardest — the exact
     * inverse of the ladder's intent, and an easy way to build a spin.
     */
    const { runner, tick } = await makeRunner();
    await runner.drain(0);
    expect(await tick()).toBe(0);
  });
});

describe("a service that starts working again", () => {
  /**
   * Withdraw the service, then let the cache REPOPULATE while it is still
   * signed out.
   *
   * The first version of these two cases ticked once after the withdrawal and
   * passed against a 24-hour cache — because the refused job calls
   * `#forgetProbe()`, so that single tick found an empty cache and probed
   * regardless. It asserted nothing about the cache at all. The gap only opens
   * on the SECOND tick onward, when the withdrawn state has been cached and
   * the person signs in during the interval.
   */
  const withdrawAndSettle = async (
    harness: Awaited<ReturnType<typeof makeRunner>>,
  ): Promise<void> => {
    const { tick, offer, settle, advance } = harness;
    await tick();
    offer(true);
    await tick();
    await settle();
    offer(false);
    /* Two more ticks, still signed out: the first refills the cache with the
       withdrawn answer, the second proves it is being reused. */
    advance(61_000);
    await tick();
    advance(1_000);
    await tick();
  };

  it("is noticed about a minute after the owner signs in, not fifteen", async () => {
    const harness = await makeRunner();
    signedOut = true;
    await withdrawAndSettle(harness);
    expect(harness.events, "the sign-out is noticed").toContain(
      "service-not-signed-in",
    );

    /* The owner follows the remedy. Nothing else changes: no job is offered,
       because a withdrawn service is advertised to nobody and so can never be
       sent the job whose failure is the cache's only invalidation. */
    signedOut = false;
    const before = canaries;

    /* One AUTH_RECHECK_MS, plus a tick to notice. That interval is the
       daemon's own promise about how long this takes. */
    harness.advance(60_000 + 1);
    await harness.tick();

    expect(
      canaries,
      "the recheck still runs while the capability set is cached",
    ).toBeGreaterThan(before);
    expect(
      harness.events,
      "signing in is noticed within the recheck interval, not the cache interval",
    ).toContain("service-signed-in");
  });

  it("does not have to wait out the whole cache interval", async () => {
    /* The bound, stated as time rather than as an event: if recovery needs the
       15-minute cache to lapse, the daemon's 60-second promise is decoration.
       Five two-minute steps stay well inside the cache interval. */
    const harness = await makeRunner();
    signedOut = true;
    await withdrawAndSettle(harness);
    signedOut = false;

    for (let i = 0; i < 5; i += 1) {
      harness.advance(120_000);
      await harness.tick();
    }
    expect(
      harness.events.filter((e) => e === "service-signed-in"),
    ).toHaveLength(1);
  });

  it("is advertised again when its quota block lapses", async () => {
    /**
     * The other recovery inside the same function, and the reason the fix is
     * not spelled `#unauthenticated.size > 0`.
     *
     * 019 §3.2 promises a blocked service comes back *"with nobody lifting a
     * finger"*. A blocked service skips its probe, so `probes` staying flat is
     * the block still in force, and `probes` moving is the release — the same
     * observable the daemon itself uses, rather than an event, because the
     * release path deliberately emits none.
     */
    const { tick, offer, settle, advance } = await makeRunner();
    const start = 1_800_000_000_000;
    quotaUntil = start + 5 * 60_000;

    await tick();
    offer(true);
    await tick();
    await settle();
    offer(false);
    quotaUntil = undefined;

    /* Let the blocked answer be cached, well inside the 15-minute interval. */
    advance(60_000);
    await tick();
    const whileBlocked = probes;
    advance(60_000);
    await tick();
    expect(probes, "a blocked service is not probed").toBe(whileBlocked);

    /* Past the block, still far short of the cache interval. */
    advance(4 * 60_000);
    await tick();
    expect(
      probes,
      "the block lapses and the service is looked at again",
    ).toBeGreaterThan(whileBlocked);
  });
});
