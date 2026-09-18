import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@byollm/protocol";
import { createHarness, httpCapabilities } from "./testing.js";

/**
 * A cloud-lane job that takes longer than one lease still gets delivered —
 * B258, from Kevin's read of the docs against a real integration.
 *
 * ## The chain, verified in source before this was written
 *
 * On the cloud lane the site adopts the relay's lease at claim time with
 * `expiresAt = claim.leaseExpiresAt` (`cloud.ts:346`). The device then
 * heartbeats **the relay**, and the relay renews — but `renewLeases` is called
 * from exactly one place in this package, `handlers.ts:494`, which is the
 * DIRECT lane's heartbeat handler. A cloud-lane site therefore never hears
 * that the lease was renewed.
 *
 * Its own sweep expires the lease at claim + `LEASE_MS` (`memory.ts:457`) and
 * requeues the row. When the device's result finally arrives, `complete`
 * refuses it: `job.lease?.id === args.holder.leaseId` is false against a job
 * whose lease is now `null` (`memory.ts:293`).
 *
 * `LEASE_MS` defaults to **60 000**. Sixty seconds is shorter than a great
 * deal of LLM generation, and the cloud lane is the one the docs teach —
 * Kevin's case is book translation, where this is the difference between
 * shipping a chapter and shipping half of one without knowing.
 *
 * ## Why this models the pump rather than driving it
 *
 * The pump's own path seals and verifies a real envelope, so driving it end to
 * end would spend the case on crypto that is not what broke. These are the
 * four store calls the pump makes, in the order it makes them, with the clock
 * moved between them — which is exactly where the defect lives and nowhere
 * else.
 */

const LEASE_MS = 60_000;

/**
 * The four store calls `cloud.ts` makes, in its order, with the clock moved
 * between them.
 *
 * The job is enqueued through the real app so its envelope is real; only the
 * relay's side is modelled, because the relay is the part a unit test cannot
 * have and is not the part that broke.
 */
const cloudLaneJob = async (deviceTakesMs: number) => {
  const h = createHarness({ leaseMs: LEASE_MS });
  const handle = await h.app.enqueue({
    kind: "llm.generate",
    payload: { prompt: "translate chapter one" },
    owner: "alice",
  });

  /* 1. The relay says a device claimed it, and names the lease it issued. */
  const leaseId = "lease_from_the_relay";
  const adopted = await h.store.adopt({
    jobId: handle.id,
    leaseId,
    expiresAt: h.clock.now() + LEASE_MS,
    now: h.clock.now(),
  });

  /* 2. The device works. It heartbeats the RELAY, which renews; this site is
        never told, because nothing calls `renewLeases` off the direct lane. */
  h.clock.advance(deviceTakesMs);

  /* 3. The site pumps again, and `expireDue` runs on almost every store call
        whether or not the pump asks for it. */
  await h.store.expireDue(h.clock.now());

  /* 4. The relay hands over the sealed result and the pump completes it. */
  const done = await h.store.complete({
    jobId: handle.id,
    /* The relay names the device; the pump passes it through — `cloud.ts`
       does the same, from `done.runnerId`. */
    runnerId: "runner_from_the_relay",
    holder: { by: "lease", leaseId },
    outcome: { outcome: "ok", text: "chapter one, translated" },
    provenance: {
      audience: "private",
      runnerId: "runner_from_the_relay",
      runnerOwner: "alice",
      backendClass: "http",
      model: "a-model",
      untrusted: false,
    },
    now: h.clock.now(),
  });

  return { adopted, done, store: h.store, jobId: handle.id };
};

describe("a cloud-lane job the device takes longer than one lease to finish", () => {
  it("is adopted in the first place, or the rest of this proves nothing", async () => {
    const { adopted } = await cloudLaneJob(1_000);
    expect(adopted, "the store refused the relay's claim").not.toBeNull();
  });

  it("is delivered when the device finishes inside the lease", async () => {
    /* The control. Without it, a store that never accepted anything would
       satisfy the case below by accident. */
    const { done } = await cloudLaneJob(LEASE_MS / 2);
    expect(done.accepted, "a job finished inside the lease was refused").toBe(
      true,
    );
  });

  it("is delivered when the device takes twice the lease", async () => {
    /**
     * The defect. The device did the work and the relay renewed its lease
     * throughout; only this site failed to hear it, and the result is thrown
     * away at the last step.
     */
    const { done } = await cloudLaneJob(2 * LEASE_MS);
    expect(
      done.accepted,
      "the device finished and the relay held the lease throughout; the site " +
        "expired its own copy and refused the result",
    ).toBe(true);
  });

  it("does not leave the job queued for somebody else to run again", async () => {
    /* The second cost, and the worse one for a site paying per token: the row
       goes back to `queued`, so the work can be handed out a second time. */
    const { store, jobId } = await cloudLaneJob(2 * LEASE_MS);
    const after = await store.get(jobId);
    expect(
      after?.state,
      "the job was requeued after the device had already finished it",
    ).toBe("ok");
  });
});

describe("what still ends an adopted job, so nothing leaks", () => {
  /**
   * Declining to expire a relay-owned lease opens a hole if nothing replaces
   * it: the requeue loop is what used to end these rows, and the expiry loop
   * below it only ever considered `queued` jobs. A cloud-lane job whose relay
   * went silent would sit `claimed` forever.
   *
   * `deadlineAt` is the bound that replaces the lease clock — absolute, and
   * the relay honours the same one.
   */
  it("expires at its deadline even though its lease is not ours to expire", async () => {
    const h = createHarness({ leaseMs: LEASE_MS });
    const handle = await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "a job whose relay goes quiet" },
      owner: "alice",
    });
    /* No explicit `deadlineAt` on an ordinary enqueue, so the bound is the
       TTL fallback — the same one `deadlineFor` gives the store. Computed
       here rather than assumed, because assuming it was `deadlineAt` is what
       made the first version of this case fail against a null. */
    const before = await h.store.get(handle.id);
    const deadline =
      before?.deadlineAt ?? (before?.claimableAt ?? 0) + (before?.ttlMs ?? 0);
    expect(deadline, "the job has no bound to test against").toBeGreaterThan(
      h.clock.now(),
    );

    await h.store.adopt({
      jobId: handle.id,
      leaseId: "lease_from_the_relay",
      expiresAt: h.clock.now() + LEASE_MS,
      now: h.clock.now(),
    });

    /* Long past the lease, and past the deadline: the relay never spoke. */
    h.clock.set(deadline + 1);
    await h.store.expireDue(h.clock.now());

    const after = await h.store.get(handle.id);
    expect(
      after?.state,
      "an adopted job outlived its own deadline, so nothing would ever end it",
    ).toBe("expired");
  });

  it("does not expire it one tick BEFORE the deadline", async () => {
    /* The boundary, because "expires eventually" is satisfied by expiring
       immediately, which is the defect in the other direction. */
    const h = createHarness({ leaseMs: LEASE_MS });
    const handle = await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "still inside its deadline" },
      owner: "alice",
    });
    const row = await h.store.get(handle.id);
    const deadline =
      row?.deadlineAt ?? (row?.claimableAt ?? 0) + (row?.ttlMs ?? 0);
    await h.store.adopt({
      jobId: handle.id,
      leaseId: "lease_from_the_relay",
      expiresAt: h.clock.now() + LEASE_MS,
      now: h.clock.now(),
    });

    h.clock.set(deadline - 1);
    await h.store.expireDue(h.clock.now());

    expect((await h.store.get(handle.id))?.state).toBe("claimed");
  });

  it("still expires a DIRECT-lane lease that lapsed, which is ours to expire", async () => {
    /**
     * The control on the scoping. The fix keys on `runnerId === ""`, which
     * `adopt` sets and `claim` does not — so a direct-lane lease must still
     * lapse exactly as before, or this traded one lost job for another.
     *
     * Claimed through the real handler rather than by calling the store: the
     * distinction under test is what `claim` writes versus what `adopt`
     * writes, and reaching past the door would let me write either.
     */
    const h = createHarness({ leaseMs: LEASE_MS });
    const runner = await h.pair();
    await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "direct lane" },
      owner: runner.owner,
    });
    const claimed = await h.call(
      "claim",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: runner.runnerId,
        capabilities: httpCapabilities(),
        max: 8,
      },
      runner,
    );
    const jobs = (claimed.body as { jobs: { id: string }[] }).jobs;
    expect(jobs.length, "nothing was claimed, so this proves nothing").toBe(1);

    h.clock.advance(2 * LEASE_MS);
    await h.store.expireDue(h.clock.now());

    expect(
      (await h.store.get(jobs[0]!.id))?.state,
      "a lapsed direct-lane lease must still requeue",
    ).toBe("queued");
  });
});
