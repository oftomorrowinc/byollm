import { generateKeys, publicIdentityOf, type JobStub } from "@byollm/protocol";
import { describe, expect, it } from "vitest";
import type { RoutingStore } from "./store.js";

/**
 * The routing store's behaviour, written once and run against every
 * implementation — cloud_008 finding 54.
 *
 * There were two copies. This package tested `RelayState`; `byollm-cloud`
 * tested `ValkeyRoutingStore` with a file that opened by explaining it was
 * "written once and parameterised… a second copy of the scenario is a second
 * place for two implementations to quietly diverge" — and was itself the
 * second copy. It had drifted to sixteen cases against the eighteen in the
 * ledger, which is exactly the divergence the sentence predicted, happening
 * to the sentence.
 *
 * So the contract lives here, in the package that declares `RoutingStore`,
 * and both repositories import it. A store that cannot pass this is not a
 * routing store, whatever it implements.
 *
 * ## Why this ships in the published package
 *
 * Because the implementation that matters most is in another repository. A
 * contract only the author can run is a description; one a third party runs
 * against their own implementation is a contract. `@byollm/relay/store-contract`
 * is a subpath export so nothing that imports the relay itself pulls in a
 * test framework.
 *
 * ## What this cannot prove
 *
 * `CLAIM_ATOMIC` is a MUST and every case here would pass against a store
 * that read, decided and wrote in three steps — in one process there is
 * nothing to interleave. Concurrency belongs with the implementation that
 * has a network in it, and `byollm-cloud`'s suite runs it against Valkey with
 * many connections. Named here so the omission is a decision rather than an
 * oversight.
 */

/** The control-plane site id these cases route under. */
export const CONTRACT_SITE = "site_store";

/** A site's identity key id — byollm_009 Amendment A §A.3. */
const SITE_KEY_ID = "BYOLLM-TEST-SITE-KEY-ID";

const SITE = CONTRACT_SITE;

const stub = (id: string, owner = "alice"): JobStub => ({
  id,
  kind: "llm.generate",
  owner,
  site: SITE_KEY_ID,
  audience: "self",
  sizeClass: "small",
  streaming: false,
  deadlineAt: 4_102_444_800_000,
});

const ENVELOPE = {
  ciphertext: "AAAA",
  recipientKeyId: "r",
  senderKeyId: "s",
  direction: "payload" as const,
  deadlineAt: 4_102_444_800_000,
};

const claimArgs = (over: Record<string, unknown> = {}) => ({
  runnerId: "runner_1",
  owner: "alice",
  device: publicIdentityOf(generateKeys(Date.now())),
  siteId: SITE,
  kinds: new Set(["llm.generate"]),
  owners: new Set(["alice"]),
  max: 10,
  leaseMs: 60_000,
  ...over,
});

export interface StoreContractOptions {
  /**
   * A fresh, empty store, and how to dispose of it.
   *
   * Arrow-typed rather than a method, because the caller passes these
   * around: a method signature lets `this` travel with the call, and a
   * factory read off an options object is exactly where that goes wrong.
   */
  readonly make: () => Promise<{
    store: RoutingStore;
    done: () => Promise<void>;
  }>;
  /**
   * Whether this store writes stubs as bytes and reads them back.
   *
   * An in-process store holds typed objects and cannot hold a stub it cannot
   * parse; a serialising one can, because what it wrote may have been written
   * by a previous version. The case that covers it is skipped rather than
   * hidden — a reader should know which half of this contract each store is
   * proving (cloud_008 §2.1a).
   */
  readonly serialising?: boolean;
  /** Write a stub's raw bytes, bypassing serialisation. */
  readonly writeRawStub?: (
    store: RoutingStore,
    id: string,
    raw: string,
  ) => Promise<void>;
}

/** Run the contract. Call inside a suite; it declares its own `describe`. */
export function describeStoreContract(
  name: string,
  options: StoreContractOptions,
): void {
  const { make, serialising, writeRawStub } = options;
  describe(`the routing store — ${name}`, () => {
    it("is idempotent by job id", async () => {
      const { store, done } = await make();
      await store.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
      await store.claim(claimArgs());
      // A republish must not disturb work in flight — byollm_009 §4.2's replay
      // argument rests on it.
      await store.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
      expect((await store.job("a"))?.state).toBe("awaiting-payload");
      await done();
    });

    it("refuses an id another site is already using", async () => {
      // cloud_008 finding 58. Idempotence by bare id made a second site's
      // enqueue return the *first* site's job: site B would be handed A's stub,
      // and B's `seal` and `cancel` would then be refused for a job B believes
      // it published. Two tenants, one namespace, and the symptom is a relay
      // that looks broken to the innocent party.
      const { store, done } = await make();
      await store.enqueue({ id: "shared", siteId: SITE, stub: stub("shared") });

      const collision = await store.enqueue({
        id: "shared",
        siteId: "site_other",
        stub: stub("shared"),
      });

      expect(collision).toEqual({ refused: "id-taken" });
      // The refusal names nothing about the other site. What the *store* says
      // reaches the site plane, which must not turn it into "somebody else has
      // that id" — cloud_008 finding 58, second pass. One value, and it is the
      // same value for every collision, so there is nothing here to correlate.
      expect(JSON.stringify(collision)).not.toContain("site_other");
      expect(JSON.stringify(collision)).not.toContain(SITE);
      // And the original is untouched: a refusal must not disturb the job it
      // refused on behalf of.
      expect((await store.job("shared"))?.siteId).toBe(SITE);

      // The same site republishing is still absorbed, which is the behaviour
      // this exception is carved out of — byollm_009 §4.2's replay argument.
      const replay = await store.enqueue({
        id: "shared",
        siteId: SITE,
        stub: stub("shared"),
      });
      expect(replay).toEqual(await store.job("shared"));
      await done();
    });

    it("grants only what the owners set allows", async () => {
      const { store, done } = await make();
      await store.enqueue({ id: "mine", siteId: SITE, stub: stub("mine") });
      await store.enqueue({
        id: "theirs",
        siteId: SITE,
        stub: stub("theirs", "mallory"),
      });
      const granted = await store.claim(claimArgs());
      expect(granted.map((job) => job.id)).toEqual(["mine"]);
      await done();
    });

    it("refuses a stale lease and honours the current one", async () => {
      const { store, done } = await make();
      await store.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
      const [granted] = await store.claim(claimArgs());
      await store.seal({ jobId: "a", siteId: SITE, envelope: ENVELOPE });

      expect(
        await store.takePayload({
          jobId: "a",
          runnerId: "runner_1",
          leaseId: "an-older-grant",
        }),
      ).toEqual({ refused: "stale-lease" });

      expect(
        await store.takePayload({
          jobId: "a",
          runnerId: "runner_1",
          leaseId: granted!.lease.id,
        }),
      ).toEqual({ envelope: ENVELOPE });
      await done();
    });

    it("renews a grant it still holds, and extends the sweep with it", async () => {
      // cloud_008 §0.6, at the contract level: renewal has to be one operation,
      // because between a read and a write another replica can sweep the lease
      // — and the renewal would then resurrect a grant on a job already back in
      // the queue. In Valkey that is a script; in memory it is a method; the
      // guarantee is the same one, so it is tested here rather than twice.
      const { store, done } = await make();
      await store.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
      const [granted] = await store.claim(claimArgs({ leaseMs: 1_000 }));

      const renewed = await store.renewLeases({
        runnerId: "runner_1",
        leases: [{ jobId: "a", leaseId: granted!.lease.id }],
        leaseMs: 60_000,
      });

      expect(renewed.lost).toEqual([]);
      expect(renewed.renewed.map((r) => r.jobId)).toEqual(["a"]);
      // The store's own clock did the arithmetic — the caller passed a duration,
      // never an instant, which is what keeps two replicas from measuring one
      // lease against two clocks (cloud_006 §3.4).
      expect(renewed.renewed[0]!.expiresAt).toBeGreaterThan(
        granted!.lease.expiresAt,
      );

      // And it is the *stored* grant that moved, not just the number returned.
      // Reporting a renewal without performing one is the mutation that
      // survived the first version of the relay's own test for this.
      expect((await store.job("a"))?.claimedBy?.leaseExpiresAt).toBe(
        renewed.renewed[0]!.expiresAt,
      );
      await done();
    });

    it("reports a lease the runner no longer holds as lost, and renews nothing", async () => {
      const { store, done } = await make();
      await store.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
      const [granted] = await store.claim(claimArgs({ leaseMs: 1_000 }));
      const before = (await store.job("a"))?.claimedBy?.leaseExpiresAt;

      const renewed = await store.renewLeases({
        runnerId: "runner_1",
        leases: [{ jobId: "a", leaseId: "a-grant-that-ended" }],
        leaseMs: 60_000,
      });

      expect(renewed.renewed).toEqual([]);
      expect(renewed.lost).toEqual(["a"]);
      // A refusal must not advance anything — the current holder's grant is
      // untouched by somebody else's stale renewal.
      expect((await store.job("a"))?.claimedBy?.leaseExpiresAt).toBe(before);
      expect((await store.job("a"))?.claimedBy?.leaseId).toBe(
        granted!.lease.id,
      );
      await done();
    });

    it("does not hand out a stub it cannot parse", async () => {
      // cloud_008 §2.1a, and the case is not hypothetical: two jobs enqueued
      // before alpha.15 had no `site`, came back in a claim, and the daemon's
      // `.strict()` parse rejected the whole response. Two dead rows denied
      // claims to every device on the hub, and the queue could not drain past
      // them.
      //
      // The store had `JSON.parse(stub) as JobStub` — trusting what it wrote,
      // when what it wrote was written by a previous version. A routing store
      // outlives the deployment that filled it, so a wire change to `JobStub`
      // is a data migration whether or not anyone plans one.
      //
      // Only meaningful against a store that serialises: `RelayState` holds
      // typed objects and cannot reach this state, so it passes by
      // construction — which is worth saying rather than hiding, because a
      // reader should know which half of this contract each store is proving.
      const { store, done } = await make();
      if (!serialising || writeRawStub === undefined) {
        await done();
        return;
      }

      await store.enqueue({ id: "good", siteId: SITE, stub: stub("good") });
      await store.enqueue({ id: "old", siteId: SITE, stub: stub("old") });
      // Exactly what alpha.14 wrote: a stub with no `site`.
      const legacy = { ...stub("old") } as Record<string, unknown>;
      delete legacy["site"];
      await writeRawStub(store, "old", JSON.stringify(legacy));

      const granted = await store.claim(claimArgs({ max: 10 }));

      // The good one is still handed out — "return nothing" would pass a test
      // that only checked the bad one was absent, and would stop all routing.
      expect(granted.map((job) => job.id)).toEqual(["good"]);
      // And the bad one is back in the queue rather than stuck holding a lease
      // nobody received.
      expect((await store.job("old"))?.state).toBe("queued");
      await done();
    });

    it("honours a self job's audience", async () => {
      // cloud_008 §2.1 at the contract level. The owners set is everyone this
      // device may run for, which for a Team owner's machine is the whole
      // roster — right for public and named, wrong for the one audience a user
      // picks because they want their own machine.
      const { store, done } = await make();
      await store.enqueue({
        id: "private",
        siteId: SITE,
        stub: { ...stub("private", "alice"), audience: "self" },
      });

      // A roster owner's machine: may run alice's work in general.
      const granted = await store.claim(
        claimArgs({ owner: "owner", owners: new Set(["owner", "alice"]) }),
      );

      expect(granted).toEqual([]);
      expect((await store.job("private"))?.state).toBe("queued");
      await done();
    });

    it("still offers that job to its owner's own machine", async () => {
      const { store, done } = await make();
      await store.enqueue({
        id: "private",
        siteId: SITE,
        stub: { ...stub("private", "alice"), audience: "self" },
      });
      const granted = await store.claim(
        claimArgs({ owner: "alice", owners: new Set(["alice"]) }),
      );
      expect(granted.map((job) => job.id)).toEqual(["private"]);
      await done();
    });

    it("does not offer a job back to the runner that refused it", async () => {
      // `REFUSAL_NOT_REOFFERED`. `releaseLeases` gained an **optional** reason,
      // which means a store can ignore it and still typecheck — this class has
      // now diverged from the interface that way twice, so the contract is the
      // only thing that catches it.
      const { store, done } = await make();
      await store.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
      const [granted] = await store.claim(claimArgs());

      await store.releaseLeases({
        runnerId: "runner_1",
        leases: [{ jobId: "a", leaseId: granted!.lease.id }],
        reason: "refused",
      });

      expect(await store.claim(claimArgs())).toEqual([]);
      expect((await store.job("a"))?.state).toBe("queued");
      // And somebody else may still run it.
      expect(
        (await store.claim(claimArgs({ runnerId: "runner_2" }))).map(
          (j) => j.id,
        ),
      ).toEqual(["a"]);
      await done();
    });

    it("keeps a job claimable by a runner that only went away", async () => {
      const { store, done } = await make();
      await store.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
      const [granted] = await store.claim(claimArgs());

      await store.releaseLeases({
        runnerId: "runner_1",
        leases: [{ jobId: "a", leaseId: granted!.lease.id }],
        reason: "shutdown",
      });

      expect((await store.claim(claimArgs())).map((j) => j.id)).toEqual(["a"]);
      await done();
    });

    it("stops offering a job past its deadline, and drops the ciphertext", async () => {
      // cloud_008 §2.2. `deadlineAt` travelled on every stub and nothing read
      // it, so expired jobs were offered forever and their sealed payloads kept
      // for as long as the store lived.
      const { store, done } = await make();
      await store.enqueue({
        id: "late",
        siteId: SITE,
        stub: { ...stub("late"), deadlineAt: Date.now() - 1_000 },
      });

      expect(await store.claim(claimArgs())).toEqual([]);
      expect(await store.job("late")).toBeUndefined();
      await done();
    });

    it("names a cancelled job to the device holding it, and offers it to nobody", async () => {
      // cloud_008 §2.2.
      const { store, done } = await make();
      await store.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
      await store.claim(claimArgs());

      expect(await store.cancel({ jobId: "a", siteId: SITE })).toBe(true);
      expect(await store.cancelRequests("runner_1")).toEqual(["a"]);

      // Scoped to the caller's site: a site must not reach another's work by
      // guessing an id.
      expect(await store.cancel({ jobId: "a", siteId: "someone_else" })).toBe(
        false,
      );
      await done();
    });

    it("records a result once", async () => {
      const { store, done } = await make();
      await store.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
      const [granted] = await store.claim(claimArgs());

      const first = await store.complete({
        jobId: "a",
        runnerId: "runner_1",
        leaseId: granted!.lease.id,
        envelope: ENVELOPE,
        disposition: "ok",
      });
      const replay = await store.complete({
        jobId: "a",
        runnerId: "runner_1",
        leaseId: granted!.lease.id,
        envelope: { ...ENVELOPE, ciphertext: "different" },
        disposition: "error",
      });

      expect(first).toEqual({ accepted: true, state: "done" });
      // `duplicate` — cloud_008 §3.6. Case 18 above is the one that says why.
      expect(replay).toEqual({
        accepted: false,
        duplicate: true,
        state: "done",
      });
      // The property, not the boolean: the second result did not overwrite.
      expect((await store.job("a"))?.disposition).toBe("ok");
      await done();
    });

    it("answers the device that finished it with `duplicate`", async () => {
      // Contract case 18 — cloud_008 §3.6, and the eighteenth exists because
      // the compiler cannot see any of this: the return type's `duplicate` is
      // optional, so a store that never sets it typechecks perfectly while
      // enforcing `RESULT_IDEMPOTENT` by accident or not at all.
      //
      // A daemon whose acknowledgment was lost hears that its answer is already
      // recorded, rather than that its lease is stale — the second message
      // invents a worry about a result safely on disk.
      const { store, done } = await make();
      await store.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
      const [granted] = await store.claim(claimArgs());

      const first = await store.complete({
        jobId: "a",
        runnerId: "runner_1",
        leaseId: granted!.lease.id,
        envelope: ENVELOPE,
        disposition: "ok",
      });
      expect(first).toEqual({ accepted: true, state: "done" });

      const replay = await store.complete({
        jobId: "a",
        runnerId: "runner_1",
        leaseId: granted!.lease.id,
        envelope: { ...ENVELOPE, ciphertext: "a-different-result" },
        disposition: "error",
      });
      expect(replay).toEqual({
        accepted: false,
        duplicate: true,
        state: "done",
      });

      // A *different* device, on a job that is terminal, gets the refusal it
      // would get for one that is not — otherwise the two answers differ and a
      // job id becomes a terminality probe.
      const stranger = await store.complete({
        jobId: "a",
        runnerId: "runner_2",
        leaseId: granted!.lease.id,
        envelope: ENVELOPE,
        disposition: "ok",
      });
      expect(stranger).toEqual({ refused: "not-holder" });

      // And the first answer is what survived, which is the property rather
      // than any of the booleans above.
      expect((await store.job("a"))?.disposition).toBe("ok");
      await done();
    });

    it("refuses a result produced under a grant that ended", async () => {
      // cloud_008 §1.4a at the contract level, and it belongs here more than
      // anywhere: `RoutingStore.complete` gained `leaseId` and this class kept
      // typechecking without it, because a parameter object with fewer
      // properties is assignable to one with more. The relay would have
      // enforced LEASE_HONORED on the memory store and not on the store that
      // runs in production, with nothing red on the way.
      const { store, done } = await make();
      await store.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
      await store.claim(claimArgs());

      const late = await store.complete({
        jobId: "a",
        runnerId: "runner_1",
        leaseId: "a-grant-that-ended",
        envelope: ENVELOPE,
        disposition: "ok",
      });

      expect(late).toEqual({ refused: "stale-lease" });
      // Untouched: the current holder can still finish it.
      expect((await store.job("a"))?.state).toBe("awaiting-payload");
      expect((await store.job("a"))?.result).toBeUndefined();
      await done();
    });

    it("stamps deadlines from its own clock", async () => {
      const { store, done } = await make();
      await store.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
      const before = await store.now();
      const [granted] = await store.claim(claimArgs({ leaseMs: 45_000 }));
      const after = await store.now();

      // Bracketed rather than exact: a real store's clock moves between the two
      // reads, which is the whole reason it is the store's clock and not ours.
      expect(granted!.lease.expiresAt).toBeGreaterThanOrEqual(before + 45_000);
      expect(granted!.lease.expiresAt).toBeLessThanOrEqual(after + 45_000);
      await done();
    });
  });
}
