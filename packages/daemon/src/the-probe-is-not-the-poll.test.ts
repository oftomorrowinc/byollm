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

class CountingBackend implements Backend {
  readonly stopReasons = {
    kind: "unavailable" as const,
    why: "a test double reads no vendor signal",
  };
  readonly id = "openai-http" as const;
  readonly class = "http" as const;
  health(): Promise<{ healthy: boolean; models: string[] }> {
    probes += 1;
    return Promise.resolve({ healthy: true, models: ["m"] });
  }
  execute(_request: BackendRequest): Promise<BackendResult> {
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
});
afterEach(async () => {
  await removeTemp(dir);
});

const FIFTEEN_MINUTES = 15 * 60_000;

async function makeRunner() {
  const loaded = resolveConfig(
    DaemonConfig.parse({
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
    onEvent: (event) => {
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

  it("probes again once the value is old enough to doubt", async () => {
    /**
     * The control on the case above. A cache that never expired would pass it
     * and would advertise a CLI somebody uninstalled until the daemon
     * restarted — "never advertise what isn't real" with no bound at all.
     */
    const { tick, advance } = await makeRunner();
    await tick();
    const afterFirst = probes;
    advance(FIFTEEN_MINUTES + 1);
    await tick();

    expect(probes).toBeGreaterThan(afterFirst);
  });

  it("does not expire early, or the interval means nothing", async () => {
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
});
