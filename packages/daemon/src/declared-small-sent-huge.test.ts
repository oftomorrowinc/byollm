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
import { removeTemp, testControlPlane } from "./test-support.js";

/**
 * A stranger declares `small` and sends forty times that — B188.
 *
 * Declared a BLOCKER on 2026-08-27 and then on no board for fifteen days;
 * `open-door-readiness.md` gates it: *"must be fixed before any site opens to
 * untrusted end users."*
 *
 * The community budget was checked against `sizeClassCeiling(job.sizeClass)` —
 * **a number chosen by whoever enqueued the job** — and the payload itself was
 * never measured, though `budgets.check`'s own parameter is documented as
 * *"total payload text length"*. So an untrusted end user declared `small` and
 * spent the owner's metered backend on whatever they liked.
 *
 * ## The numbers here are the attack, not a fixture
 *
 * `small` has a ceiling of 4,000. The owner's community limit is set ABOVE that
 * at 10,000 — which is what makes this reachable, and is the ordinary case: an
 * owner generous enough to accept any small job. The admission check therefore
 * PASSES, because 4,000 < 10,000, and before this fix nothing else looked.
 *
 * The payload is 400,000 characters — the ~40x overrun the 08-27 review
 * measured.
 *
 * ## What the assertion has to be
 *
 * Not "it was refused". **The backend must never be reached**, because the harm
 * B188 describes is spend on somebody else's metered account. A refusal
 * recorded after the vendor was called would read identically in a log and cost
 * the owner exactly as much.
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

/** The owner's community ceiling, deliberately ABOVE `small`'s 4,000. */
const COMMUNITY_LIMIT = 10_000;
/** The ~40x overrun the 08-27 review measured. */
const HUGE = 400_000;

async function sealedFor(jobId: string, chars: number): Promise<unknown> {
  return seal({
    plaintext: JSON.stringify({ prompt: "x".repeat(chars) }),
    senderKeys: SITE_KEYS,
    recipientEncryptionPublic: DEVICE_KEYS.encryptionPublic,
    context: {
      jobId,
      senderKeyId: keyId(publicIdentityOf(SITE_KEYS).identity),
      recipientKeyId: keyId(publicIdentityOf(DEVICE_KEYS).identity),
      deadlineAt: Date.now() + 3_600_000,
      direction: "payload",
    },
  });
}

let executed: number;

class CountingBackend implements Backend {
  readonly stopReasons = {
    kind: "unavailable" as const,
    why: "a test double reads no vendor signal",
  };
  readonly id = "openai-http" as const;
  readonly class = "http" as const;
  health(): Promise<{ healthy: boolean; models: string[] }> {
    return Promise.resolve({ healthy: true, models: ["m"] });
  }
  execute(_request: BackendRequest): Promise<BackendResult> {
    /* The meter. This is the thing the owner pays for, and the only assertion
       that distinguishes "refused" from "refused after we were billed". */
    executed += 1;
    return Promise.resolve({
      ok: true,
      text: "answered",
      durationMs: 1,
      stop: "end" as const,
    });
  }
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-b188-"));
  executed = 0;
});
afterEach(async () => {
  await removeTemp(dir);
});

/**
 * The control plane whose grant admits this job.
 *
 * A `team` job carries a signed grant or it never reaches the budget at all —
 * the first version of this file left it out and every case failed on *"this
 * device serves its owner only"*, which is admission refusing before the thing
 * under test could run. A refusal is not a refusal for the right reason.
 */
/* Signed against the same clock the runner reads. The first version used the
   fixture default (1.8e12) while the runner ran on a 2026 clock, and every
   grant looked expired by 125 days — a refusal, but not the one under test. */
const NOW = Date.now();
const plane = testControlPlane(NOW);

/** A job from somebody who is NOT this device's owner, declaring `small`. */
const communityJob = () => ({
  id: "job_1",
  kind: "llm.generate",
  audience: "team",
  /* Not "me". The owner's own work never reaches the community budget, so a
     job owned by the device owner would prove nothing here. */
  owner: "a-stranger",
  site: SITE_ID,
  sizeClass: "small",
  streaming: false,
  deadlineAt: Date.now() + 60_000,
  lease: {
    id: "lease_job_1",
    runnerId: "runner_1",
    expiresAt: 4_000_000_000_000,
  },
  grant: plane.sign({
    jobId: "job_1",
    user: "a-stranger",
    site: SITE_ID,
    service: "primary",
  }),
});

async function makeRunner(payloadChars: number) {
  const loaded = resolveConfig(
    DaemonConfig.parse({
      services: {
        primary: {
          model: "m",
          kinds: ["llm.generate"],
          type: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
          /* Offered to the team, or admission refuses before the budget is
             consulted — "this service is offered to its owner only". The
             whole row is about work from other people, so a device that
             offered nothing could not exhibit it. */
          offer: "team",
        },
      },
    }),
  );
  const budgets = new Budgets(join(dir, "b.json"), {
    maxJobsPerHour: 100,
    maxJobsPerDay: 100,
    maxWallClockMs: 60_000,
    maxOutputBytes: 1_000_000,
    maxPayloadChars: COMMUNITY_LIMIT,
  });
  await budgets.load(Date.now());
  const spend = new SpendLedger(join(dir, "spend.json"));
  await spend.load(Date.now());
  const ingress = new IngressLog({
    path: join(dir, "ingress.log"),
    communityPromptDays: 7,
    keepSelfPrompts: true,
  });

  const released: { jobId: string; reason: string }[] = [];
  const refusals: string[] = [];
  const clock = NOW;
  const settled: { yet: boolean } = { yet: false };
  const reset = () => {
    settled.yet = false;
  };

  const runner = new Runner({
    client: new ProtocolClient({
      origin: "https://app.test",
      identity: SIGNER,
      fetch: (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.endsWith("/fetch")) {
          return sealedFor("job_1", payloadChars).then(
            (envelope) =>
              new Response(JSON.stringify({ envelope }), {
                headers: { "content-type": "application/json" },
              }),
          );
        }
        if (url.endsWith("/release")) {
          const body = JSON.parse(
            typeof init?.body === "string" ? init.body : "{}",
          ) as { leases: { jobId: string }[]; reason: string };
          for (const lease of body.leases) {
            released.push({ jobId: lease.jobId, reason: body.reason });
          }
        }
        const body = url.endsWith("/claim")
          ? JSON.stringify({ jobs: [communityJob()], leaseMs: 60_000 })
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
    controlPlanePublic: plane.controlPlanePublic,
    loaded,
    budgets,
    spend,
    ingress,
    now: () => clock,
    onEvent: (event) => {
      if (event.type === "refused") refusals.push(event.reason);
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

  /* Waited out by its result rather than by a clock — the rule
     `poison-job.test.ts` wrote down after a fixed sleep went red on CI. */
  const cycle = async () => {
    reset();
    await runner.tick();
    const deadline = Date.now() + 10_000;
    while (!settled.yet && Date.now() < deadline) {
      await new Promise((wake) => setTimeout(wake, 5));
    }
    if (!settled.yet) throw new Error("the job never reached an end");
  };

  return { cycle, released, refusals };
}

describe("a community job that declared a size it is not", () => {
  it("never reaches the backend, which is where the owner's money is", async () => {
    const { cycle } = await makeRunner(HUGE);
    await cycle();
    expect(
      executed,
      "the vendor was called for a payload forty times over the owner's limit",
    ).toBe(0);
  });

  it("is refused, and the refusal names the real size rather than the bucket", async () => {
    /* The number in the sentence is what tells the difference between this
       fix and the old one. `sizeClassCeiling("small")` is 4,000; the payload
       is 400,000. A refusal quoting 4,000 would be the bug still in place,
       wearing a refusal. */
    const { cycle, refusals } = await makeRunner(HUGE);
    await cycle();
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain(String(COMMUNITY_LIMIT));
    expect(refusals[0]).toContain(String(HUGE));
  });

  it("releases the lease as refused, so the hub stops offering it here", async () => {
    /* Without this the job comes straight back to the same device and the
       refusal becomes a loop — B041's shape. */
    const { cycle, released } = await makeRunner(HUGE);
    await cycle();
    expect(released).toEqual([{ jobId: "job_1", reason: "refused" }]);
  });

  it("admission alone would have let it through, which is why this exists", async () => {
    /**
     * The case that proves the OLD check could not catch this, rather than
     * asserting it.
     *
     * `small`'s ceiling is 4,000 and the owner's limit is 10,000, so the
     * admission-time comparison — ceiling against limit — passes. If that
     * were not true this job would have been refused before the fetch and
     * every case above would pass without the new code existing at all.
     */
    const { SIZE_CLASS_LIMITS } = await import("@byollm/protocol");
    expect(SIZE_CLASS_LIMITS.small).toBeLessThan(COMMUNITY_LIMIT);
    expect(HUGE).toBeGreaterThan(COMMUNITY_LIMIT);
  });
});

describe("a community job that told the truth", () => {
  it("runs, so the check refuses a lie rather than refusing strangers", async () => {
    /**
     * The control, and it is the one that stops this fix from being a
     * community off-switch. A device that refused every community job would
     * pass all four cases above and would look, in a log, exactly like a
     * device enforcing a limit.
     */
    const { cycle, refusals } = await makeRunner(1_000);
    await cycle();
    expect(refusals, refusals.join(" / ")).toEqual([]);
    expect(executed).toBe(1);
  });
});
