import { cryptoReady, generateKeys, publicIdentityOf } from "@byollm/protocol";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Relay } from "../src/index.js";
import { SITE_ID, SiteConnector, fixtureFor, makeDaemon } from "./harness.js";

/**
 * The ninth finding, predicted and then demonstrated — cloud_005 §7.3.
 *
 * Phase 2's first step is "the published relay, unchanged, behind a real load
 * balancer". That is correct at **exactly one replica**, and this file is why.
 *
 * `RelayState` holds routing in two `Map`s in one process. Two replicas behind
 * a balancer are two worlds: a daemon that claims on replica A is unknown to
 * replica B, and a site that polls B is told there is nothing to seal. Nothing
 * errors. The job simply waits, and the `awaiting-payload` timeout eventually
 * requeues it — so the symptom under load is not a crash but jobs that take a
 * suspiciously round ten seconds and then start again somewhere else.
 *
 * That is the worst shape a distributed bug can have: silent, self-healing,
 * and invisible until throughput matters. Written as a passing test that
 * *demonstrates the limitation* rather than a failing one that complains about
 * it, so it documents the constraint and will start failing the day shared
 * state makes it untrue — which is the day the constraint lifts.
 *
 * The fix is shared routing state (Valkey), and §7.3 sequences it **before**
 * multi-tenancy for this reason: multi-tenancy makes a single replica serve
 * more sites, which is the one thing that cannot help here.
 */

let disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const d of disposers) await d();
  disposers = [];
});

beforeAll(async () => {
  await cryptoReady();
});

describe("two replicas, one load balancer", () => {
  it("do not share routing state, so a job claimed on A is invisible to B", async () => {
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);

    // One projection, two relays. The projection is shared because it comes
    // from the control plane — which is exactly why it is *not* the problem.
    // Everything derived from the control plane replicates for free; only the
    // state the relay invents for itself does not.
    const fixture = fixtureFor(site);
    const a = new Relay({ siteId: SITE_ID, fixture });
    const b = new Relay({ siteId: SITE_ID, fixture });

    const daemon = await makeDaemon(a, fixture, { owner: "alice", site });
    disposers.push(daemon.dispose);

    // The site happens to enqueue against replica A.
    const onA = new SiteConnector(a, siteKeys);
    const { jobId } = await onA.enqueue({
      prompt: "which replica",
      owner: "alice",
    });

    await daemon.runner.tick();
    await new Promise((r) => setTimeout(r, 30));

    // A knows the job is claimed and waiting to be sealed.
    expect(a.state.job(jobId)?.state).toBe("awaiting-payload");

    // B has never heard of it. Not an error — an absence, which is what makes
    // this hard to see in production.
    expect(b.state.job(jobId)).toBeUndefined();

    // So a site whose next poll lands on B is told there is nothing to do,
    // while a device sits holding a lease waiting for exactly that seal.
    const onB = new SiteConnector(b, siteKeys);
    expect(await onB.sealPending()).toBe(0);

    // And the daemon is not confused, which is the trap: it holds a valid
    // lease on a job that a healthy-looking relay says nothing about.
    expect(a.state.job(jobId)?.claimedBy?.runnerId).toBe(daemon.runnerId);
  });

  it("means presence answers differently depending on which replica is asked", async () => {
    // The other half, and the one that breaks the product's promise rather
    // than a job: cloud_001 sells "the site gets an immediate offline signal".
    // Presence lives in the same per-process Map, so with two replicas a user
    // whose daemon is plainly online reads as offline to half the traffic.
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site);
    const a = new Relay({ siteId: SITE_ID, fixture });
    const b = new Relay({ siteId: SITE_ID, fixture });

    const daemon = await makeDaemon(a, fixture, { owner: "alice", site });
    disposers.push(daemon.dispose);

    expect(a.state.everyone()).toHaveLength(1);
    expect(b.state.everyone()).toHaveLength(0);
  });
});

/**
 * The claim race — cloud_006 §3.2, written before the fix.
 *
 * The test above demonstrates *split* state: two replicas that cannot see each
 * other. Shared routing state fixes that, and introduces the failure this file
 * did not previously describe — the one a careful port would ship.
 *
 * `DaemonPlane.claim` scans `state.jobs()`, filters in JavaScript, and mutates
 * the winners. That is atomic today for one reason and one reason only:
 * **Node is single-threaded and the Maps are local**, so nothing can run
 * between the read and the write. Neither of those survives a store on a
 * network.
 *
 * `CLAIM_ATOMIC` is a MUST. It currently holds by accident of runtime rather
 * than by design, which is the "true for an accidental reason" class — and the
 * dangerous property is that a naive port **passes every existing test**,
 * because every existing test runs one replica.
 *
 * ## What a shared store means, modelled honestly
 *
 * Sharing routing state means both replicas see the same job in the same
 * state. So: one job id, `queued` in both. Then a daemon claims on each.
 *
 * With a store that makes claiming a single operation, exactly one wins and
 * the other is told there is nothing to take. Today both win, and two devices
 * hold a lease on one job — which means two machines run it, two results come
 * back, and `RESULT_IDEMPOTENT` decides which one the site keeps by arrival
 * order rather than by anyone's intent.
 */
describe("the claim race that shared state will introduce", () => {
  it.fails(
    "grants one job to exactly one device when both replicas can see it",
    async () => {
      const siteKeys = generateKeys(Date.now());
      const site = publicIdentityOf(siteKeys);
      const fixture = fixtureFor(site);

      const a = new Relay({ siteId: SITE_ID, fixture });
      const b = new Relay({ siteId: SITE_ID, fixture });

      // A daemon per replica, as a load balancer would produce. Both are
      // approved devices belonging to the same consenting owner, so each
      // replica is entitled to offer them work — the projection is shared and
      // is not the problem.
      const one = await makeDaemon(a, fixture, { owner: "alice", site });
      disposers.push(one.dispose);
      const two = await makeDaemon(b, fixture, { owner: "alice", site });
      disposers.push(two.dispose);
      // Both relays learn both devices: presence is routing state, so a shared
      // store shares it too.
      a.project(fixture);
      b.project(fixture);

      // One job, queued on both — which is what "shared routing state" means.
      const stub = {
        id: "job_contended",
        kind: "llm.generate" as const,
        owner: "alice",
        audience: "self" as const,
        sizeClass: "small" as const,
        streaming: false,
        deadlineAt: Date.now() + 300_000,
      };
      a.state.enqueue({ id: stub.id, siteId: SITE_ID, stub });
      b.state.enqueue({ id: stub.id, siteId: SITE_ID, stub });

      // Concurrent, as far as the daemons are concerned: neither waits for the
      // other, and each talks to the replica the balancer gave it.
      await Promise.all([one.runner.tick(), two.runner.tick()]);
      await new Promise((r) => setTimeout(r, 30));

      const holders = [a, b]
        .map((relay) => relay.state.job(stub.id)?.claimedBy?.runnerId)
        .filter((runnerId): runnerId is string => runnerId !== undefined);

      // The assertion `RoutingStore` must make true. It is red today, which is
      // the point of writing it now: `it.fails` inverts the moment the claim
      // becomes a single operation, so whoever lands that change is told to
      // delete this marker rather than having to remember the test exists.
      expect(new Set(holders).size).toBeLessThanOrEqual(1);
    },
  );
});
