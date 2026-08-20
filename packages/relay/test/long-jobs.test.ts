import { cryptoReady, generateKeys, publicIdentityOf } from "@byollm/protocol";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Relay } from "../src/index.js";
import { SITE_ID, SiteConnector, fixtureFor, makeDaemon } from "./harness.js";

/**
 * A job that outlives one lease — cloud_008 §0.6.
 *
 * The relay's heartbeat returned the literal `leases: []`. Not a bug in a
 * branch: it never renewed anything, ever. Meanwhile `sweep` requeues a job
 * whose lease has expired, on the reasonable assumption that a device holding
 * an unrenewed lease has gone away.
 *
 * So every job slower than `leaseMs` was taken off the device running it and
 * offered to the next one. With one daemon that means the *same* device runs
 * it twice; with two it means two devices run it, and one of them sealed a
 * result into a lease that no longer existed. Sixty seconds is not a long
 * inference — this was every real generation on the hub.
 *
 * Nothing failed while it was true. Fifty-four relay tests passed, because
 * every one of them ran work that finished in a millisecond. That is the
 * shape worth naming: the suite tested the relay thoroughly at a duration the
 * product never runs at.
 *
 * Time here is real, and small: a 200 ms lease and a 700 ms job. Faking the
 * clock would have hidden it too — the daemon's `#active` map, the heartbeat
 * cadence and the sweep are three clocks that have to actually interleave.
 */

let disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const d of disposers) await d();
  disposers = [];
});

beforeAll(async () => {
  await cryptoReady();
});

const LEASE_MS = 200;
const JOB_MS = 700;

/** A relay, a site and one daemon whose backend takes longer than a lease. */
async function slowJob() {
  const siteKeys = generateKeys(Date.now());
  const site = publicIdentityOf(siteKeys);
  const fixture = fixtureFor(site);
  const relay = new Relay({ fixture, leaseMs: LEASE_MS });
  const connector = new SiteConnector(relay, siteKeys);
  const daemon = await makeDaemon(relay, fixture, { owner: "alice", site });
  disposers.push(daemon.dispose);
  daemon.backend.hangMs = JOB_MS;

  const { jobId } = await connector.enqueue({
    prompt: "something worth waiting for",
    owner: "alice",
  });

  // Claim, then seal for whoever claimed it. The daemon starts work on the
  // next tick and stays busy for JOB_MS.
  await daemon.runner.tick();
  expect(await connector.sealPending()).toBe(1);
  await daemon.runner.tick();

  return { relay, connector, daemon, jobId };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a job that takes longer than its lease", () => {
  it("stays with the device that is running it, and runs once", async () => {
    const { relay, connector, daemon, jobId } = await slowJob();

    // Heartbeat throughout, which is what a daemon does while it works. Each
    // tick renews; without renewal the sweep inside the next `claim` requeues
    // the job out from under the running device.
    //
    // Sampled, not just checked at the end — and that is the whole lesson of
    // this test. The first version asserted the outcome (one execution, a
    // collected result, state `done`) and **passed against a relay that
    // renewed nothing**: the lease lapsed, the job was requeued, the daemon
    // re-claimed it under a new grant, and the original run finished and
    // posted its result anyway. Every end-state assertion was satisfied by a
    // sequence of events that was entirely wrong in the middle. Renewal is a
    // property of the job's whole life, so the test has to watch it live.
    const grants = new Set<string>();
    const expiries: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      await sleep(100);
      await daemon.runner.tick();
      const held = (await relay.state.job(SITE_ID, jobId))?.claimedBy;
      if (held) {
        grants.add(held.leaseId);
        expiries.push(held.leaseExpiresAt);
      }
    }

    // One grant for the life of the job. A second id means it was taken away
    // and given back, which is the bug however the job ends up.
    expect(grants.size).toBe(1);
    // And the grant was actually extended, rather than merely reported as
    // extended: the relay's own recorded expiry moves forward while the
    // device works.
    expect(expiries.at(-1)).toBeGreaterThan(expiries[0]!);

    const results = await connector.collect();
    expect(results.map((r) => r.jobId)).toEqual([jobId]);
    expect(results[0]?.outcome?.outcome).toBe("ok");
    expect(daemon.backend.seen).toHaveLength(1);
    expect((await relay.state.job(SITE_ID, jobId))?.state).toBe("done");
  });

  it("is taken away from a device that stops heartbeating", async () => {
    // The negative control, and the reason the sweep is right to exist. If
    // this passed too, "renews the lease" would be indistinguishable from
    // "never expires a lease" — which is a worse bug than the one being
    // fixed, because a crashed daemon would strand every job it held.
    const { relay, jobId } = await slowJob();

    await sleep(LEASE_MS + 100);
    await relay.state.sweep();

    const job = await relay.state.job(SITE_ID, jobId);
    expect(job?.state).toBe("queued");
    expect(job?.claimedBy).toBeUndefined();
  });
});

describe("what heartbeat tells the daemon", () => {
  it("names the leases it renewed, not an empty list", async () => {
    // The bug in its smallest form. `leases: []` is what a daemon is told
    // when nothing was renewed, so a relay that never renews is
    // indistinguishable from one whose leases have all lapsed — and the
    // daemon believes the second thing.
    const { relay, daemon, jobId } = await slowJob();
    const held = (await relay.state.job(SITE_ID, jobId))?.claimedBy;
    expect(held).toBeDefined();

    const renewed = await relay.state.renewLeases({
      runnerId: daemon.runnerId,
      leases: [{ jobId, leaseId: held!.leaseId }],
      leaseMs: LEASE_MS,
    });

    expect(renewed.renewed.map((r) => r.jobId)).toEqual([jobId]);
    expect(renewed.lost).toEqual([]);
  });

  it("reports a lease the runner no longer holds as lost", async () => {
    const { relay, daemon, jobId } = await slowJob();

    const renewed = await relay.state.renewLeases({
      runnerId: daemon.runnerId,
      leases: [{ jobId, leaseId: "a-grant-that-ended" }],
      leaseMs: LEASE_MS,
    });

    expect(renewed.renewed).toEqual([]);
    // Both halves — V1-3. A bare id is ambiguous to a daemon serving two
    // sites that chose the same one, and "the grant you no longer hold" is
    // what this list has always meant.
    expect(renewed.lost).toEqual([{ jobId, leaseId: "a-grant-that-ended" }]);
  });
});
