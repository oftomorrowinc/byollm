import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@byollm/protocol";
import type { ByollmStore } from "./store.js";
import { supabaseStore } from "./supabase/index.js";
import { createHarness, httpCapabilities, type Harness } from "./testing.js";

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
 *
 * ## Over both stores — BY-05
 *
 * B258 was fixed in MemoryStore and nowhere else: the Supabase adapter's
 * sweep is a SQL function, and it kept requeueing adopted leases for another
 * month because every case here ran against the reference store only. So
 * each case runs once per adapter, and the Postgres one runs in the CI job
 * that starts a local stack (`freeze-gate-postgres`), which sets
 * `REQUIRE_SUPABASE` so a stack that failed to start cannot pass as memory.
 *
 * Postgres reads `now()` and that clock cannot be faked. The harness clock
 * starts at wall time there, and moving it forward moves the job's own
 * timestamps BACK by the same amount before the sweep runs — the one row
 * under test sees exactly the time it would have seen. What cannot be had is
 * one-millisecond resolution across a network round trip, so the boundary
 * case steps a store-specific {@link StoreCase.tick} rather than 1 ms.
 */

const LEASE_MS = 60_000;

const SUPABASE_URL = process.env["SUPABASE_URL"] ?? "";
const SERVICE_KEY =
  process.env["SUPABASE_SERVICE_ROLE_KEY"] ??
  process.env["SUPABASE_SECRET_KEY"] ??
  "";
const HAS_SUPABASE = SUPABASE_URL !== "" && SERVICE_KEY !== "";

/** One adapter under test. */
interface StoreCase {
  readonly name: string;
  /** A harness over this store, and an owner it will accept. */
  make(): Promise<{ h: Harness<ByollmStore>; owner: string }>;
  /** Sweep with the store's clock standing at `h.clock.now()`. */
  sweep(h: Harness<ByollmStore>, jobId: string): Promise<void>;
  /** The smallest step this store's clock resolves reliably. */
  readonly tick: number;
  /** Delete a runner's row the way an owner can from the browser. */
  readonly deleteRunner?: (runnerId: string) => Promise<void>;
}

const CASES: StoreCase[] = [
  {
    name: "MemoryStore",
    make: () =>
      Promise.resolve({
        h: createHarness({ leaseMs: LEASE_MS }),
        owner: "alice",
      }),
    sweep: async (h) => {
      await h.store.expireDue(h.clock.now());
    },
    tick: 1,
  },
];

if (HAS_SUPABASE) {
  const client = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const shift = (at: string | null, byMs: number): string | null =>
    at === null ? null : new Date(Date.parse(at) - byMs).toISOString();

  CASES.push({
    name: "supabaseStore (real Postgres)",
    make: async () => {
      // `owner` references `auth.users`, so it is a fresh user, not "alice".
      const { data, error } = await client.auth.admin.createUser({
        email: `long-job+${randomUUID().slice(0, 8)}@byollm.test`,
        email_confirm: true,
      });
      if (error) throw new Error(`could not create a user: ${error.message}`);
      return {
        h: createHarness({
          store: supabaseStore({ client }),
          startAt: Date.now(),
          leaseMs: LEASE_MS,
        }),
        owner: data.user.id,
      };
    },
    sweep: async (h, jobId) => {
      // The harness clock has run ahead of `now()` by this much; move the
      // row's clocks back by the same, so the sweep judges it at the
      // harness's time.
      const ahead = h.clock.now() - Date.now();
      const { data, error } = await client
        .from("byollm_jobs")
        .select("claimable_at, lease_expires_at, deadline_at")
        .eq("id", jobId)
        .single<{
          claimable_at: string | null;
          lease_expires_at: string | null;
          deadline_at: string | null;
        }>();
      if (error) throw new Error(`read ${jobId}: ${error.message}`);
      const moved = await client
        .from("byollm_jobs")
        .update({
          claimable_at: shift(data.claimable_at, ahead),
          lease_expires_at: shift(data.lease_expires_at, ahead),
          deadline_at: shift(data.deadline_at, ahead),
        })
        .eq("id", jobId);
      if (moved.error)
        throw new Error(`shift ${jobId}: ${moved.error.message}`);
      await h.store.expireDue(h.clock.now());
    },
    // Wide enough for a round trip to a local stack on a slow CI runner.
    tick: 5_000,
    deleteRunner: async (runnerId) => {
      const { error } = await client
        .from("byollm_runners")
        .delete()
        .eq("id", runnerId);
      if (error) throw new Error(`delete ${runnerId}: ${error.message}`);
    },
  });
}

it("says so when the Postgres case is not running", () => {
  // Not a skip, which is easy to stop noticing: the gap is named every run.
  if (!HAS_SUPABASE) {
    expect(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are unset — the Postgres " +
        "case did not run. `cd packages/server && supabase start` to include it.",
    ).toBeTruthy();
  }
  expect(CASES.length).toBeGreaterThanOrEqual(1);
});

if (process.env["REQUIRE_SUPABASE"] === "1") {
  it("runs the Postgres case, because this job exists to run it", () => {
    expect(HAS_SUPABASE).toBe(true);
  });
}

/** The job's bound — `deadlineFor`, computed here rather than assumed. */
const deadlineOf = async (h: Harness<ByollmStore>, jobId: string) => {
  const row = await h.store.get(jobId);
  return row?.deadlineAt ?? (row?.claimableAt ?? 0) + (row?.ttlMs ?? 0);
};

describe.each(CASES)("over $name", (storeCase) => {
  /**
   * The four store calls `cloud.ts` makes, in its order, with the clock moved
   * between them.
   *
   * The job is enqueued through the real app so its envelope is real; only
   * the relay's side is modelled, because the relay is the part a unit test
   * cannot have and is not the part that broke.
   */
  const cloudLaneJob = async (deviceTakesMs: number) => {
    const { h, owner } = await storeCase.make();
    const handle = await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "translate chapter one" },
      owner,
    });

    /* 1. The relay says a device claimed it, and names the lease it issued.
          A uuid, because that is what a relay issues and what Postgres
          stores — the memory store would take any string. */
    const leaseId = randomUUID();
    const adopted = await h.store.adopt({
      jobId: handle.id,
      leaseId,
      expiresAt: h.clock.now() + LEASE_MS,
      now: h.clock.now(),
    });

    /* 2. The device works. It heartbeats the RELAY, which renews; this site
          is never told, because nothing calls `renewLeases` off the direct
          lane. */
    h.clock.advance(deviceTakesMs);

    /* 3. The site pumps again, and `expireDue` runs on almost every store
          call whether or not the pump asks for it. */
    await storeCase.sweep(h, handle.id);

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
        runnerOwner: owner,
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
       * throughout; only this site failed to hear it, and the result is
       * thrown away at the last step.
       */
      const { done } = await cloudLaneJob(2 * LEASE_MS);
      expect(
        done.accepted,
        "the device finished and the relay held the lease throughout; the " +
          "site expired its own copy and refused the result",
      ).toBe(true);
    });

    it("does not leave the job queued for somebody else to run again", async () => {
      /* The second cost, and the worse one for a site paying per token: the
         row goes back to `queued`, so the work can be handed out twice. */
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
     * Declining to expire a relay-owned lease opens a hole if nothing
     * replaces it: the requeue step is what used to end these rows, and the
     * expiry step below it only ever considered `queued` jobs. A cloud-lane
     * job whose relay went silent would sit `claimed` forever.
     *
     * `deadlineAt` is the bound that replaces the lease clock — absolute, and
     * the relay honours the same one.
     */
    const adoptedJob = async (prompt: string) => {
      const { h, owner } = await storeCase.make();
      const handle = await h.app.enqueue({
        kind: "llm.generate",
        payload: { prompt },
        owner,
      });
      /* No explicit `deadlineAt` on an ordinary enqueue, so the bound is the
         TTL fallback — the same one `deadlineFor` gives the store. Computed
         rather than assumed, because assuming it was `deadlineAt` is what
         made the first version of this case fail against a null. */
      const deadline = await deadlineOf(h, handle.id);
      expect(deadline, "the job has no bound to test against").toBeGreaterThan(
        h.clock.now(),
      );
      await h.store.adopt({
        jobId: handle.id,
        leaseId: randomUUID(),
        expiresAt: h.clock.now() + LEASE_MS,
        now: h.clock.now(),
      });
      return { h, jobId: handle.id, deadline };
    };

    it("expires at its deadline even though its lease is not ours to expire", async () => {
      const { h, jobId, deadline } = await adoptedJob(
        "a job whose relay goes quiet",
      );

      /* Long past the lease, and past the deadline: the relay never spoke. */
      h.clock.set(deadline + 1);
      await storeCase.sweep(h, jobId);

      expect(
        (await h.store.get(jobId))?.state,
        "an adopted job outlived its own deadline, so nothing would ever end it",
      ).toBe("expired");
    });

    it("does not expire it one tick BEFORE the deadline", async () => {
      /* The boundary, because "expires eventually" is satisfied by expiring
         immediately, which is the defect in the other direction. */
      const { h, jobId, deadline } = await adoptedJob(
        "still inside its deadline",
      );

      h.clock.set(deadline - storeCase.tick);
      await storeCase.sweep(h, jobId);

      expect((await h.store.get(jobId))?.state).toBe("claimed");
    });

    it("still expires a DIRECT-lane lease that lapsed, which is ours to expire", async () => {
      /**
       * The control on the scoping. MemoryStore keys on `runnerId === ""`,
       * Postgres on `lease_runner is null`; both are what `adopt` writes and
       * `claim` does not — so a direct-lane lease must still lapse exactly as
       * before, or this traded one lost job for another.
       *
       * Claimed through the real handler rather than by calling the store:
       * the distinction under test is what `claim` writes versus what `adopt`
       * writes, and reaching past the door would let me write either.
       */
      const { h, owner } = await storeCase.make();
      const runner = await h.pair({ owner });
      await h.app.enqueue({
        kind: "llm.generate",
        payload: { prompt: "direct lane" },
        owner,
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
      expect(jobs.length, "nothing was claimed, so this proves nothing").toBe(
        1,
      );
      const jobId = jobs[0]!.id;

      h.clock.advance(2 * LEASE_MS);
      await storeCase.sweep(h, jobId);

      expect(
        (await h.store.get(jobId))?.state,
        "a lapsed direct-lane lease must still requeue",
      ).toBe("queued");
    });

    if (storeCase.deleteRunner !== undefined) {
      const deleteRunner = storeCase.deleteRunner;
      it("requeues a DELETED runner's job rather than mistaking it for adopted", async () => {
        /**
         * Postgres only: `lease_runner` is `on delete set null`, so deleting
         * a runner leaves its claimed rows in exactly the shape `adopt`
         * writes — and the adopted arm would let them sit until their
         * deadline. The migration requeues them before the row goes.
         */
        const { h, owner } = await storeCase.make();
        const runner = await h.pair({ owner });
        await h.app.enqueue({
          kind: "llm.generate",
          payload: { prompt: "a runner about to be deleted" },
          owner,
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
        expect(jobs.length, "nothing was claimed, so this proves nothing").toBe(
          1,
        );
        const jobId = jobs[0]!.id;

        await deleteRunner(runner.runnerId);
        await storeCase.sweep(h, jobId);

        expect(
          (await h.store.get(jobId))?.state,
          "a deleted runner's job was left claimed, waiting on a lease nobody holds",
        ).toBe("queued");
      });
    }
  });

  describe("a job whose first claimant died", () => {
    /**
     * #9585. The relay reclaims a lease when its device stops answering and
     * grants the job to the next claimant. The site's row still holds the
     * first adopted lease, and refusing the second left the job refused on
     * every pump until its deadline — a healthy device never sealed to.
     */
    const adoptTwice = async () => {
      const { h, owner } = await storeCase.make();
      const handle = await h.app.enqueue({
        kind: "llm.generate",
        payload: { prompt: "outlives its first device" },
        owner,
      });
      const lease = () => ({
        jobId: handle.id,
        leaseId: randomUUID(),
        expiresAt: h.clock.now() + LEASE_MS,
        now: h.clock.now(),
      });
      const first = lease();
      expect(await h.store.adopt(first)).not.toBeNull();
      h.clock.advance(LEASE_MS + 1);
      const second = lease();
      const adopted = await h.store.adopt(second);
      return { h, owner, jobId: handle.id, first, second, adopted };
    };

    const finishedBy = (owner: string, leaseId: string) => ({
      runnerId: "runner_from_the_relay",
      holder: { by: "lease" as const, leaseId },
      outcome: { outcome: "ok" as const, text: "answered" },
      provenance: {
        audience: "private" as const,
        runnerId: "runner_from_the_relay",
        runnerOwner: owner,
        backendClass: "http" as const,
        model: "a-model",
        untrusted: false,
      },
    });

    it("adopts the second claimant's lease in place of the first", async () => {
      const { h, jobId, second, adopted } = await adoptTwice();
      expect(
        adopted,
        "the store refused the job's second claimant",
      ).not.toBeNull();
      expect((await h.store.get(jobId))?.lease?.id).toBe(second.leaseId);
    });

    it("takes the second claimant's result, and not the first's", async () => {
      const { h, owner, jobId, first, second } = await adoptTwice();
      const late = await h.store.complete({
        jobId,
        ...finishedBy(owner, first.leaseId),
        now: h.clock.now(),
      });
      expect(late.accepted, "a reclaimed grant completed the job").toBe(false);
      const done = await h.store.complete({
        jobId,
        ...finishedBy(owner, second.leaseId),
        now: h.clock.now(),
      });
      expect(done.accepted).toBe(true);
    });
  });
});
