import {
  cryptoReady,
  generateKeys,
  keyId,
  publicIdentityOf,
} from "@byollm/protocol";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Relay, RelayState } from "../src/index.js";
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
    expect((await a.state.job(SITE_ID, jobId))?.state).toBe("awaiting-payload");

    // B has never heard of it. Not an error — an absence, which is what makes
    // this hard to see in production.
    expect(await b.state.job(SITE_ID, jobId)).toBeUndefined();

    // So a site whose next poll lands on B is told there is nothing to do,
    // while a device sits holding a lease waiting for exactly that seal.
    const onB = new SiteConnector(b, siteKeys);
    expect(await onB.sealPending()).toBe(0);

    // And the daemon is not confused, which is the trap: it holds a valid
    // lease on a job that a healthy-looking relay says nothing about.
    expect((await a.state.job(SITE_ID, jobId))?.claimedBy?.runnerId).toBe(
      daemon.runnerId,
    );
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

    expect(await a.state.everyone()).toHaveLength(1);
    expect(await b.state.everyone()).toHaveLength(0);
  });
});

/**
 * The claim race, and what a shared store has to make true — cloud_006 §3.2.
 *
 * The test above demonstrates *split* state: two replicas that cannot see each
 * other. This is the failure a careful port introduces while fixing that one.
 *
 * `claim` used to be `jobs()` → filter → mutate in the plane, atomic for
 * exactly one reason: **Node is single-threaded and the Maps are local.**
 * `CLAIM_ATOMIC` is a MUST, and it held by accident of runtime rather than by
 * design — so a naive port passes every existing test, because every existing
 * test runs one replica.
 *
 * ## Why this replaced an `it.fails`
 *
 * It was first written as a failing assertion: two relays with separate
 * stores, the same job id in both, and both claiming it. That modelled a
 * shared store rather than using one, because there was no way to share.
 *
 * It could never have inverted. Two separate stores stay two separate stores
 * no matter what backs them, so the "red test that goes green when fixed" was
 * red about a situation the fix does not address. Now that `RelayOptions`
 * takes a store, the assertion can be made directly, and a marker that cannot
 * flip is worse than no marker — it looks like a tripwire and is a decoration.
 *
 * ## What this does and does not prove
 *
 * With a shared `RelayState` it proves the **seam and the contract**: two
 * relays, one store, and a job granted to exactly one device.
 *
 * It does **not** prove atomicity under concurrency, and cannot. A memory
 * store is atomic for free — one process, one thread, nothing runs between the
 * read and the write. The assertion that matters is this same test against a
 * store on a network, where those guarantees are gone; that is cloud_006 §4.2,
 * and it belongs with the Valkey implementation rather than here.
 */
describe("two replicas sharing one store", () => {
  it("grants a job to exactly one device", async () => {
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site);

    // One store, two relays — which is what a load balancer in front of two
    // pods looks like once routing state is shared.
    const store = new RelayState();
    const a = new Relay({ siteId: SITE_ID, fixture, store });
    const b = new Relay({ siteId: SITE_ID, fixture, store });

    const one = await makeDaemon(a, fixture, { owner: "alice", site });
    disposers.push(one.dispose);
    const two = await makeDaemon(b, fixture, { owner: "alice", site });
    disposers.push(two.dispose);
    a.project(fixture);
    b.project(fixture);

    const stub = {
      id: "job_contended",
      kind: "llm.generate" as const,
      owner: "alice",
      audience: "self" as const,
      sizeClass: "small" as const,
      streaming: false,
      deadlineAt: Date.now() + 300_000,
      site: keyId(site.identity),
    };
    // Enqueued once. That is the difference: with a shared store there is one
    // job, not one per replica.
    await store.enqueue({ id: stub.id, siteId: SITE_ID, stub });

    await Promise.all([one.runner.tick(), two.runner.tick()]);
    await new Promise((r) => setTimeout(r, 30));

    const holder = (await store.job(SITE_ID, stub.id))?.claimedBy?.runnerId;
    expect(holder).toBeDefined();
    // Both daemons asked; one holds it. The other was told there was nothing,
    // which is the answer that keeps two machines from running one job and
    // sending two results home.
    expect([one.runnerId, two.runnerId]).toContain(holder);

    // And the second daemon holds nothing — asserted rather than implied,
    // because "one holder" is also what you see if the other daemon never
    // asked.
    const jobs = await store.jobs();
    expect(jobs.filter((job) => job.claimedBy !== undefined)).toHaveLength(1);
  });

  it("shows both daemons to both replicas", async () => {
    // Presence is routing state, so a shared store shares it — and this is
    // the half that breaks a *promise* rather than a job. A daemon that is
    // plainly online must not read as offline to whichever pod is asked.
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site);
    const store = new RelayState();
    const a = new Relay({ siteId: SITE_ID, fixture, store });
    const b = new Relay({ siteId: SITE_ID, fixture, store });

    const daemon = await makeDaemon(a, fixture, { owner: "alice", site });
    disposers.push(daemon.dispose);

    // Paired against A. B knows it too, because the store is the same one.
    expect(await b.state.presence(daemon.runnerId)).toBeDefined();
    expect(await b.state.everyone()).toHaveLength(1);
  });
});
