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
 * A teammate's job declared `large` is admitted when the owner's limit could
 * hold it — #5738.
 *
 * Admission charged `sizeClassCeiling(job.sizeClass)`, and `large`'s ceiling is
 * `Infinity`: every declared-large job from another person was refused before
 * the fetch, at every `community.maxPayloadChars` the owner could set. The
 * status line told them to raise that limit, and raising it changed nothing.
 *
 * Admission now charges the bucket's FLOOR (64,001 for `large`), refusing only
 * what cannot fit; the measured payload, after opening, is the gate
 * (`declared-small-sent-huge.test.ts` owns that half).
 *
 * ## What each assertion has to be
 *
 * The refusal at a small limit must show NO fetch. The post-open measurement
 * refuses a 70,000-character payload at a 50,000 limit whatever admission
 * charged — floor, ceiling or zero — so "it was refused" alone would pass with
 * admission deleted. Only the fetch count tells admission refused it.
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

/** Over `medium`'s 64,000, so honestly `large` by `sizeClassOf`. */
const LARGE = 70_000;

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

/** A job from somebody who is NOT this device's owner, declaring `sizeClass`. */
const communityJob = (sizeClass: string) => ({
  id: "job_1",
  kind: "llm.generate",
  audience: "team",
  /* Not "me". The owner's own work never reaches the community budget, so a
     job owned by the device owner would prove nothing here. */
  owner: "a-stranger",
  site: SITE_ID,
  sizeClass,
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

async function makeRunner(input: {
  readonly sizeClass: string;
  readonly payloadChars: number;
  readonly limit: number;
}) {
  const { sizeClass, payloadChars, limit } = input;
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
    maxPayloadChars: limit,
  });
  await budgets.load(Date.now());
  const spend = new SpendLedger(join(dir, "spend.json"));
  await spend.load(Date.now());
  const ingress = new IngressLog({
    path: join(dir, "ingress.log"),
    communityPromptDays: 7,
    keepSelfPrompts: true,
  });

  let fetches = 0;
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
          /* Every fetch is counted: the envelope cannot be opened without
             one, so zero fetches is zero envelopes opened. */
          fetches += 1;
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
          ? JSON.stringify({ jobs: [communityJob(sizeClass)], leaseMs: 60_000 })
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

  return { cycle, released, refusals, ingress, fetched: () => fetches };
}

describe("a teammate's job declared large", () => {
  it("runs when the owner's limit is above its real size", async () => {
    const { cycle, refusals, fetched } = await makeRunner({
      sizeClass: "large",
      payloadChars: LARGE,
      limit: 100_000,
    });
    await cycle();
    expect(refusals, refusals.join(" / ")).toEqual([]);
    expect(fetched()).toBe(1);
    expect(executed, "the backend never ran for a job the limit holds").toBe(1);
  });

  it("is refused before the fetch when the limit is below the class's floor", async () => {
    const { cycle, refusals, fetched, released, ingress } = await makeRunner({
      sizeClass: "large",
      payloadChars: LARGE,
      limit: 50_000,
    });
    await cycle();
    expect(fetched(), "admission let it through to the fetch").toBe(0);
    expect(executed).toBe(0);
    expect(refusals).toHaveLength(1);
    /* The declaration, not a measurement nobody made. */
    expect(refusals[0]).toContain("50000");
    expect(refusals[0]).toContain("at least 64001");
    expect(released).toEqual([{ jobId: "job_1", reason: "refused" }]);
    const outcomes = (await ingress.read()).filter(
      (entry) => entry.type === "outcome",
    );
    expect(outcomes).toMatchObject([
      { outcome: "refused", brake: "payload-too-large" },
    ]);
  });

  it("that is larger than declared-large allows is still caught after opening", async () => {
    /* The floor admits it to the fetch; the measurement refuses it. The
       limit sits above the floor and below the payload. */
    const { cycle, refusals, fetched } = await makeRunner({
      sizeClass: "large",
      payloadChars: 400_000,
      limit: 100_000,
    });
    await cycle();
    expect(fetched()).toBe(1);
    expect(executed).toBe(0);
    expect(refusals[0]).toContain("400000");
  });
});

describe("a teammate's unbounded job", () => {
  it("is still refused at admission, at any limit, and never says Infinity", async () => {
    const { cycle, refusals, fetched, ingress } = await makeRunner({
      sizeClass: "unbounded",
      payloadChars: 10,
      limit: 1_000_000_000,
    });
    await cycle();
    expect(fetched()).toBe(0);
    expect(executed).toBe(0);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).not.toContain("Infinity");
    expect(refusals[0]).toContain("streamed");
    /* No brake: the payload brake's remedy, raising maxPayloadChars, cannot
       admit it — and `byollm status` would say it could. */
    const outcomes = (await ingress.read()).filter(
      (entry) => entry.type === "outcome",
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ outcome: "refused" });
    expect(outcomes[0]).not.toHaveProperty("brake");
  });
});
