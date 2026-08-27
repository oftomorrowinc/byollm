import { generateKeys, publicIdentityOf, type JobStub } from "@byollm/protocol";
import { describe, expect, it } from "vitest";
import { routeKey } from "./state.js";
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
  audience: "private",
  sizeClass: "small",
  streaming: false,
  deadlineAt: 4_102_444_800_000,
});

/** One advertised route, as a daemon describes it on every heartbeat. */
const capability = (model: string) => ({
  kind: "llm.generate" as const,
  service: model,
  backendId: "ollama" as const,
  backendClass: "process" as const,
  model,
  offerScope: "private" as const,
});

const ENVELOPE = {
  ciphertext: "AAAA",
  recipientKeyId: "r",
  senderKeyId: "s",
  direction: "payload" as const,
  deadlineAt: 4_102_444_800_000,
};

/**
 * A claim, with its routes written out — cloud_009 §3.
 *
 * `routes` replaced `siteId` + `owners`, and the cases that pass `owners`
 * below now pass the pairs those owners are reachable through. That rewrite
 * is the contract's own statement of the rule: there is no way to express
 * "this owner, any site" here, because that is not a thing consent says.
 */
const claimArgs = (
  over: { owners?: string[]; sites?: string[] } & Record<string, unknown> = {},
) => {
  const { owners = ["alice"], sites = [SITE], ...rest } = over;
  return {
    runnerId: "runner_1",
    owner: "alice",
    device: publicIdentityOf(generateKeys(Date.now())),
    kinds: new Set(["llm.generate"]),
    routes: new Set(
      sites.flatMap((site) => owners.map((owner) => routeKey(site, owner))),
    ),
    max: 10,
    leaseMs: 60_000,
    ...rest,
  };
};

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
      expect((await store.job(SITE, "a"))?.state).toBe("awaiting-payload");
      await done();
    });

    it("gives two sites the same id without either seeing the other", async () => {
      // cloud_009 §3. Keyed by the bare id, the second site's enqueue returned
      // the *first* site's job (cloud_008 finding 58), and the refusal that
      // fixed it was a cross-tenant existence oracle: a site knows its own stub
      // is well-formed, so any answer it can tell apart from success confirms
      // somebody else holds that id. Keyed by (site, id), the collision does
      // not exist and there is nothing to answer.
      const { store, done } = await make();
      await store.enqueue({ id: "shared", siteId: SITE, stub: stub("shared") });
      await store.enqueue({
        id: "shared",
        siteId: "site_other",
        stub: stub("shared", "bob"),
      });

      // Two jobs, each its own site's.
      expect((await store.job(SITE, "shared"))?.stub.owner).toBe("alice");
      expect((await store.job("site_other", "shared"))?.stub.owner).toBe("bob");

      // And a claim for one site does not see the other's, which is the
      // property the key exists for rather than a restatement of it.
      const granted = await store.claim(claimArgs());
      expect(granted.map((job) => job.id)).toEqual(["shared"]);
      expect(granted[0]?.owner).toBe("alice");

      // The same site republishing is still absorbed — byollm_009 §4.2's
      // replay argument, which is what idempotence is for.
      const replay = await store.enqueue({
        id: "shared",
        siteId: SITE,
        stub: stub("shared"),
      });
      expect(replay).toEqual(await store.job(SITE, "shared"));
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

    it("will not answer for one job with another job's lease", async () => {
      // cloud_009 §3. Holder-scoped calls carry a lease id and no site, so the
      // store resolves the job *from the lease* — and a lease id belonging to a
      // different job must not be a way to reach that job's payload.
      //
      // A mutation that dropped the "does this lease's job match the id the
      // caller named" check survived every other case in this contract, on both
      // implementations, because nothing else here ever presents a mismatched
      // pair. The holder of a valid grant is exactly the party who could try
      // it.
      const { store, done } = await make();
      await store.enqueue({ id: "mine", siteId: SITE, stub: stub("mine") });
      await store.enqueue({ id: "other", siteId: SITE, stub: stub("other") });
      const granted = await store.claim(claimArgs());
      const mine = granted.find((job) => job.id === "mine");
      const other = granted.find((job) => job.id === "other");
      await store.seal({ jobId: "other", siteId: SITE, envelope: ENVELOPE });

      // The right runner, a real lease, the wrong job.
      expect(
        await store.takePayload({
          jobId: "other",
          runnerId: "runner_1",
          leaseId: mine!.lease.id,
        }),
      ).toEqual({ refused: "stale-lease" });

      // And the honest pairing still works, so this is not "refuse everything".
      expect(
        await store.takePayload({
          jobId: "other",
          runnerId: "runner_1",
          leaseId: other!.lease.id,
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
      expect((await store.job(SITE, "a"))?.claimedBy?.leaseExpiresAt).toBe(
        renewed.renewed[0]!.expiresAt,
      );
      await done();
    });

    it("reports a lease the runner no longer holds as lost, and renews nothing", async () => {
      const { store, done } = await make();
      await store.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
      const [granted] = await store.claim(claimArgs({ leaseMs: 1_000 }));
      const before = (await store.job(SITE, "a"))?.claimedBy?.leaseExpiresAt;

      const renewed = await store.renewLeases({
        runnerId: "runner_1",
        leases: [{ jobId: "a", leaseId: "a-grant-that-ended" }],
        leaseMs: 60_000,
      });

      expect(renewed.renewed).toEqual([]);
      expect(renewed.lost).toEqual([
        { jobId: "a", leaseId: "a-grant-that-ended" },
      ]);
      // A refusal must not advance anything — the current holder's grant is
      // untouched by somebody else's stale renewal.
      expect((await store.job(SITE, "a"))?.claimedBy?.leaseExpiresAt).toBe(
        before,
      );
      expect((await store.job(SITE, "a"))?.claimedBy?.leaseId).toBe(
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
      expect((await store.job(SITE, "old"))?.state).toBe("queued");
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
        stub: { ...stub("private", "alice"), audience: "private" },
      });

      // A roster owner's machine: may run alice's work in general.
      const granted = await store.claim(
        claimArgs({ owner: "owner", owners: ["owner", "alice"] }),
      );

      expect(granted).toEqual([]);
      expect((await store.job(SITE, "private"))?.state).toBe("queued");
      await done();
    });

    it("still offers that job to its owner's own machine", async () => {
      const { store, done } = await make();
      await store.enqueue({
        id: "private",
        siteId: SITE,
        stub: { ...stub("private", "alice"), audience: "private" },
      });
      const granted = await store.claim(
        claimArgs({ owner: "alice", owners: ["alice"] }),
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
      expect((await store.job(SITE, "a"))?.state).toBe("queued");
      // And somebody else may still run it.
      expect(
        (await store.claim(claimArgs({ runnerId: "runner_2" }))).map(
          (j) => j.id,
        ),
      ).toEqual(["a"]);
      await done();
    });

    it("does not offer a job back to a runner before its not-before", async () => {
      /**
       * The middle ground between "not ever" and "immediately".
       *
       * A control plane declining a job for something the world can change —
       * an unfilled mapping slot, a resolution naming another machine, a
       * store that was briefly unreachable — means neither. Released
       * immediately, the device re-claims at once and is declined again; a
       * spin, and in a deployment one database read per turn of it.
       *
       * Asserted with an explicit moment rather than by moving a clock,
       * because a store on the other side of a network has its own and this
       * contract cannot reach it.
       */
      const { store, done } = await make();
      await store.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
      const [granted] = await store.claim(claimArgs());

      await store.releaseLeases({
        runnerId: "runner_1",
        leases: [{ jobId: "a", leaseId: granted!.lease.id }],
        retryAfter: Date.now() + 600_000,
      });

      expect(await store.claim(claimArgs())).toEqual([]);
      expect((await store.job(SITE, "a"))?.state).toBe("queued");
      // And it is *not* a refusal: another device gets it at once, which is
      // the entire reason this is a different thing.
      expect(
        (await store.claim(claimArgs({ runnerId: "runner_2" }))).map(
          (j) => j.id,
        ),
      ).toEqual(["a"]);
      await done();
    });

    it("offers it again once the not-before has passed", async () => {
      // The other half, and the one that makes it a rate rather than a
      // refusal: a person who fixes their mapping gets their queued work.
      const { store, done } = await make();
      await store.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
      const [granted] = await store.claim(claimArgs());

      await store.releaseLeases({
        runnerId: "runner_1",
        leases: [{ jobId: "a", leaseId: granted!.lease.id }],
        retryAfter: Date.now() - 1_000,
      });

      expect((await store.claim(claimArgs())).map((j) => j.id)).toEqual(["a"]);
      await done();
    });

    it("will not un-finish a job that is already done", async () => {
      /**
       * The third holder-scoped door — byollm-review 2026-08-27.
       *
       * A release naming a valid lease on a **done** job flipped it back to
       * `queued`. The recorded result survives on the row and becomes
       * unreachable, because `finished()` filters on state — so the site
       * never collects it, the job is offered again, and somebody's hardware
       * runs it a second time and overwrites the first answer.
       *
       * Not hypothetical: the daemon's own shutdown races it. A release and a
       * result for one lease are in flight together, and if the result won,
       * this undid it.
       *
       * `takePayload` got a terminal guard at V1-6 and `complete` at
       * cloud_008 §3.6. This one was left open, and no contract case existed
       * for it — so neither implementation could fail for it. Three doors,
       * one rule, shut one at a time; this is the rule stated where every
       * store has to answer for it.
       */
      const { store, done } = await make();
      await store.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
      const [granted] = await store.claim(claimArgs());
      const lease = granted!.lease.id;

      await store.takePayload({
        jobId: "a",
        runnerId: "runner_1",
        leaseId: lease,
      });
      await store.complete({
        jobId: "a",
        runnerId: "runner_1",
        leaseId: lease,
        envelope: ENVELOPE,
        disposition: "ok",
      });

      const released = await store.releaseLeases({
        runnerId: "runner_1",
        leases: [{ jobId: "a", leaseId: lease }],
        reason: "shutdown",
      });

      // Released nothing, and said so — a caller that believed this had
      // requeued would be as wrong as the store that did.
      expect(released).toEqual([]);
      expect((await store.job(SITE, "a"))?.state).toBe("done");

      // And the result is still collectable, which is the harm the state
      // change actually caused: `finished()` filters on state, so a job
      // flipped back to `queued` hid an answer that had already been paid
      // for.
      expect((await store.finished(SITE)).map((j) => j.id)).toEqual(["a"]);

      // Nor is it offered to anybody again. The second execution is the
      // expensive half — somebody's tokens, spent twice, for one job.
      expect(await store.claim(claimArgs({ runnerId: "runner_2" }))).toEqual(
        [],
      );
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
      expect(await store.job(SITE, "late")).toBeUndefined();
      await done();
    });

    it("names a cancelled job to the device holding it, and offers it to nobody", async () => {
      // cloud_008 §2.2.
      const { store, done } = await make();
      await store.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
      await store.claim(claimArgs());

      expect(await store.cancel({ jobId: "a", siteId: SITE })).toBe(true);
      // Named by grant — V1-3, so a daemon holding two sites' `a` knows
      // which one the site withdrew.
      const held = (await store.job(SITE, "a"))?.claimedBy?.leaseId;
      expect(await store.cancelRequests("runner_1")).toEqual([
        { jobId: "a", leaseId: held },
      ]);

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
      expect((await store.job(SITE, "a"))?.disposition).toBe("ok");
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
      expect((await store.job(SITE, "a"))?.disposition).toBe("ok");
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
      expect((await store.job(SITE, "a"))?.state).toBe("awaiting-payload");
      expect((await store.job(SITE, "a"))?.result).toBeUndefined();
      await done();
    });

    it("refuses a payload for a job that already finished [V1-6]", async () => {
      // The holder and lease checks both pass for a job this runner finished
      // moments ago — completing does not end the grant. So a replayed fetch
      // set `state = 'running'` on a **done** job: the site stopped being able
      // to collect its result, and the sweep requeued completed work as though
      // the device had died holding it.
      //
      // Which is `RESULT_IDEMPOTENT` broken through the other door: a
      // duplicate request undoing a finished job.
      const { store, done } = await make();
      await store.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
      const [granted] = await store.claim(claimArgs());
      await store.seal({ jobId: "a", siteId: SITE, envelope: ENVELOPE });
      await store.takePayload({
        jobId: "a",
        runnerId: "runner_1",
        leaseId: granted!.lease.id,
      });
      await store.complete({
        jobId: "a",
        runnerId: "runner_1",
        leaseId: granted!.lease.id,
        envelope: ENVELOPE,
        disposition: "ok",
      });

      const replay = await store.takePayload({
        jobId: "a",
        runnerId: "runner_1",
        leaseId: granted!.lease.id,
      });
      // Its own refusal, not `not-ready`: one says keep asking and this says
      // stop, and a daemon that read them alike would poll a finished job
      // until its lease ran out.
      expect(replay).toEqual({ refused: "terminal" });
      // And the finished job is still finished, which is the property.
      expect((await store.job(SITE, "a"))?.state).toBe("done");
      await done();
    });

    it("tells a runner nothing about another site's job id [V1-8]", async () => {
      // Job ids are chosen per site, so a bare id is a guess about somebody
      // else's namespace. The answer used to depend on whether that guess
      // landed: an id belonging to another tenant came back `not-holder`,
      // an id belonging to nobody came back `not-found`. Two status codes,
      // one bit of somebody else's business — finding 58's oracle, reached
      // through the holder door instead of the site plane.
      const { store, done } = await make();
      // Another tenant's job, under an id this caller can guess but a site it
      // does not route for.
      await store.enqueue({
        id: "secret",
        siteId: "site_somebody_else",
        stub: stub("secret"),
      });
      await store.enqueue({ id: "mine", siteId: SITE, stub: stub("mine") });
      const granted = await store.claim(claimArgs());
      const mine = granted.find((job) => job.id === "mine");

      // Asking about a job this runner does not hold, under a lease it does.
      const other = await store.takePayload({
        jobId: "secret",
        runnerId: "runner_1",
        leaseId: mine!.lease.id,
      });
      const absent = await store.takePayload({
        jobId: "no-such-job-anywhere",
        runnerId: "runner_1",
        leaseId: mine!.lease.id,
      });

      expect(other).toEqual(absent);
      expect(other).toEqual({ refused: "not-found" });
      await done();
    });

    // ── routing by kind ─────────────────────────────────────────────────
    //
    // The selection cases lived here: a job could name one of the owner's
    // services and a store had to offer it only to a device advertising that
    // exact (kind, service) pair. Amendment L removed the field — sites
    // declare purposes and people map them — so a store now matches on kind
    // alone, and the pairs it used to carry are gone from `ClaimInput`.
    //
    // What replaces those cases is the property that a store must *not* have
    // opinions it no longer has the inputs for.

    it("offers a job to any device that serves its kind", async () => {
      // Which of the owner's services answers is resolved at claim by a
      // control plane, from a mapping this store never sees. A store that
      // narrowed further would be deciding something it cannot know, and the
      // job would sit queued behind a judgement nobody made.
      const { store, done } = await make();
      await store.enqueue({ id: "a", siteId: SITE, stub: stub("a") });

      const claimed = await store.claim(
        claimArgs({ runnerId: "runner_any", kinds: new Set(["llm.generate"]) }),
      );
      expect(claimed.map((j) => j.id)).toEqual(["a"]);
      await done();
    });

    it("does not offer a job to a device that serves a different kind", async () => {
      // The control. Kind is the whole of the match, so it has to actually
      // match — a store that offered everything to everybody would push the
      // narrowing onto a control plane that would then decline it, which is
      // a round trip and a wait for a fact this side already had.
      const { store, done } = await make();
      await store.enqueue({ id: "a", siteId: SITE, stub: stub("a") });

      const claimed = await store.claim(
        claimArgs({ runnerId: "runner_chat", kinds: new Set(["llm.chat"]) }),
      );
      expect(claimed).toEqual([]);
      await done();
    });

    // ── presence ────────────────────────────────────────────────────────
    //
    // The seam had no contract coverage at all: presence was exercised
    // against `RelayState` and nothing held a shared store to the same
    // behaviour. That is the shape the pairing ceiling was found in — one
    // seam, two implementations, and the check driving the one nobody
    // deploys — so these land with `Presence.capabilities` rather than after
    // somebody notices.

    it("remembers a device, and what it says it can run", async () => {
      const { store, done } = await make();
      const device = publicIdentityOf(generateKeys(3_000_000_000_000));
      await store.seen({
        runnerId: "runner_1",
        owner: "alice",
        device,
        capabilities: [capability("llama3")],
        withheld: [],
      });

      const known = await store.presence("runner_1");
      expect(known?.owner).toBe("alice");
      expect(known?.device.identity).toBe(device.identity);
      expect(known?.capabilities.map((row) => row.model)).toEqual(["llama3"]);
      await done();
    });

    it("replaces the matrix rather than merging it", async () => {
      // The heartbeat re-sends the whole matrix every time so a server never
      // matches against a stale one. A store that kept the union would go on
      // advertising a backend the machine has lost — and work would route to
      // it, which is worse than forgetting one it still has.
      const { store, done } = await make();
      const device = publicIdentityOf(generateKeys(3_000_000_000_001));
      const seen = { runnerId: "runner_2", owner: "alice", device };
      await store.seen({
        ...seen,
        capabilities: [capability("llama3")],
        withheld: [],
      });
      await store.seen({
        ...seen,
        capabilities: [capability("mistral")],
        withheld: [],
      });

      const known = await store.presence("runner_2");
      expect(known?.capabilities.map((row) => row.model)).toEqual(["mistral"]);
      await done();
    });

    it("keeps an empty matrix, because empty is an answer", async () => {
      // A paired machine with no healthy backend — the connect-first ruling's
      // whole point. A store that treated empty as "nothing to record" would
      // leave the last non-empty matrix standing and the machines page would
      // show models that are gone.
      const { store, done } = await make();
      const device = publicIdentityOf(generateKeys(3_000_000_000_002));
      const seen = { runnerId: "runner_3", owner: "alice", device };
      await store.seen({
        ...seen,
        capabilities: [capability("llama3")],
        withheld: [],
      });
      await store.seen({ ...seen, capabilities: [], withheld: [] });

      expect((await store.presence("runner_3"))?.capabilities).toEqual([]);
      await done();
    });

    it("remembers which kinds are withheld, and drops them when resolved", async () => {
      // byollm_016. Two services answering one kind with no `defaults` entry
      // is a state only the daemon can see: from the matrix alone a withheld
      // kind and an absent one are the same shape, so a store that dropped
      // this field would leave the owner's page saying "nothing serves
      // llm.generate" — true, and useless, when the real sentence is "two
      // services answer it and you have not chosen".
      //
      // It lives in the contract rather than one store's tests because the
      // pairing ceiling was found exactly that way: one seam, two
      // implementations, and the check driving the one nobody deploys.
      const { store, done } = await make();
      const device = publicIdentityOf(generateKeys(3_000_000_000_004));
      const seen = { runnerId: "runner_withheld", owner: "alice", device };

      await store.seen({
        ...seen,
        capabilities: [],
        withheld: [
          {
            kind: "llm.generate",
            claimants: [
              { service: "ollama", offer: "team" },
              { service: "mlx", offer: "private" },
            ],
          },
        ],
      });

      const held = await store.presence("runner_withheld");
      expect(held?.withheld.map((row) => row.kind)).toEqual(["llm.generate"]);
      // The claimants survive the round trip, because naming them is the
      // whole difference between a prompt and a complaint.
      expect(held?.withheld[0]?.claimants.map((c) => c.service)).toEqual([
        "ollama",
        "mlx",
      ]);

      // The owner chooses a default: the kind resolves and stops being
      // reported, or the page goes on asking for a decision already made.
      await store.seen({
        ...seen,
        capabilities: [capability("llama3")],
        withheld: [],
      });
      expect((await store.presence("runner_withheld"))?.withheld).toEqual([]);
      await done();
    });

    it("stamps presence from its own clock, and moves it on the next beat", async () => {
      // `lastSeenAt` is liveness, and liveness is only true if something
      // advances it. It was written once at pairing and never again, so it
      // reported the pairing time under the name "last seen" — a field that
      // is quietly a different fact.
      const { store, done } = await make();
      const device = publicIdentityOf(generateKeys(3_000_000_000_003));
      const seen = { runnerId: "runner_4", owner: "alice", device };

      const before = await store.now();
      const first = await store.seen({
        ...seen,
        capabilities: [],
        withheld: [],
      });
      expect(first.lastSeenAt).toBeGreaterThanOrEqual(before);

      const later = await store.seen({
        ...seen,
        capabilities: [],
        withheld: [],
      });
      expect(later.lastSeenAt).toBeGreaterThanOrEqual(first.lastSeenAt);
      await done();
    });

    it("lists everyone it has seen", async () => {
      const { store, done } = await make();
      await store.seen({
        runnerId: "runner_5",
        owner: "alice",
        device: publicIdentityOf(generateKeys(3_000_000_000_004)),
        capabilities: [],
        withheld: [],
      });
      await store.seen({
        runnerId: "runner_6",
        owner: "bob",
        device: publicIdentityOf(generateKeys(3_000_000_000_005)),
        capabilities: [],
        withheld: [],
      });

      const everyone = await store.everyone();
      const ids = everyone.map((row) => row.runnerId);
      expect(ids).toContain("runner_5");
      expect(ids).toContain("runner_6");
      await done();
    });

    it("does not know a runner it has never seen", async () => {
      const { store, done } = await make();
      expect(await store.presence("runner_never")).toBeUndefined();
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
