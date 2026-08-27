import { describe, expect, it } from "vitest";
import type { Mapping, PolicyStore } from "./store.js";

/**
 * The policy store's behaviour, written once and run against every
 * implementation.
 *
 * The same reasoning as `@byollm/relay/store-contract`, and more of it. The
 * implementation that matters most is byollm.cloud's, in another repository
 * and not open — so this is the only way a reader can know that the hosted
 * product's store answers the same questions the same way the reference one
 * does. A contract only its author can run is a description.
 *
 * ## What a store has to do to be tested
 *
 * `PolicyStore` has one method, and it reads. Everything that *writes* —
 * consenting, mapping, adding somebody to a team — is the deployment's own
 * surface, and no two will agree on it. So the contract takes a small harness
 * that performs those acts however the implementation performs them, and
 * asserts only what `read` must then answer.
 *
 * That is the honest boundary: this proves the store's *answers*, not its
 * admin API. A store that passes has the semantics the engine relies on.
 */
export interface PolicyStoreContractOptions {
  /**
   * A fresh, empty store, its write surface, and how to dispose of it.
   *
   * Arrow-typed rather than methods, for the reason the routing store's
   * contract gives: a method signature lets `this` travel with a call read
   * off an options object, which is exactly where that goes wrong.
   */
  readonly make: () => Promise<{
    store: PolicyStore;
    consent: (input: {
      siteId: string;
      user: string;
      mappings?: readonly Mapping[];
    }) => Promise<void> | void;
    revoke: (input: { siteId: string; user: string }) => Promise<void> | void;
    /**
     * Pause a consent without withdrawing it.
     *
     * Optional because not every deployment offers pausing. A store that does
     * not is not asked to prove it — but one that does must prove a paused
     * consent reads as not-consented, which is the case below.
     */
    pause?: (input: { siteId: string; user: string }) => Promise<void> | void;
    addMember: (input: { owner: string; user: string }) => Promise<void> | void;
    removeMember: (input: {
      owner: string;
      user: string;
    }) => Promise<void> | void;
    done: () => Promise<void>;
  }>;
  /**
   * Whether this store accepts arbitrary strings as ids.
   *
   * True for a store that keys by concatenation, where two ids differing only
   * in where a separator falls is a real hazard and the case below is the
   * point. False for one with typed columns — a Postgres `uuid` cannot hold
   * `"b:c"`, so the confusion is structurally impossible and demanding the
   * case would only stop that store running the contract at all.
   *
   * Named rather than skipped silently: an implementation that opts out is
   * saying its ids are typed, which is a claim about its schema.
   */
  readonly opaqueIds?: boolean;
}

/**
 * Ids as **uuids**, so a real control plane can run this — byollm-review
 * 2026-08-27.
 *
 * These were `"site_demo"`, `"bob"` and `"alice"`: fine for a store that
 * treats an id as an opaque string, and rejected outright by the Postgres
 * `uuid` columns of the implementation this contract exists for. A suite the
 * hosted store could not execute is the "contract only its author can run"
 * this file's own header calls a description rather than a contract.
 *
 * A uuid is an opaque string too, so nothing is lost for stores that do not
 * care — and the names stay in the comments, where they are for people.
 */
const SITE = "5cbc8f4c-96ab-4c1e-b5b6-9d4b2a1f0e01";
/** bob — the device owner. */
const OWNER = "5cbc8f4c-96ab-4c1e-b5b6-9d4b2a1f0e02";
/** alice — whose work it is. */
const USER = "5cbc8f4c-96ab-4c1e-b5b6-9d4b2a1f0e03";
/** carol — somebody else entirely, for the cases about keeping people apart. */
const CAROL = "5cbc8f4c-96ab-4c1e-b5b6-9d4b2a1f0e05";
/**
 * A second site, for the twin of the case that keeps two people apart.
 *
 * Its id was spelled inline until a store with `uuid` columns was finally
 * pointed at this contract and threw on it — the one id the sweep to real
 * uuids missed, because every other case had a named constant and this one
 * did not. The person-isolation case passed throughout, so the gap read as
 * "isolation is covered" when only half of it was.
 */
const OTHER_SITE = "5cbc8f4c-96ab-4c1e-b5b6-9d4b2a1f0e06";
const MAPPING: Mapping = {
  purpose: "writing_assistant",
  kind: "llm.generate",
  service: "qwen",
  owner: null,
};

/**
 * The same service name, on a teammate's machine.
 *
 * byollm-review 2026-08-27. Every case here used `owner: null`, so a store
 * that dropped `owner`, nulled it, or mis-joined it passed the whole suite —
 * while this contract claimed "a store that passes has the semantics the
 * engine relies on". It did not.
 *
 * The engine's wrong-machine check is `(mapped.owner ?? job.owner) !== owner`,
 * and it is the enforcement of the one substitution this design exists to
 * forbid: a mapping naming *carol's* qwen must not be satisfied by *bob's*
 * qwen. It depends entirely on a store round-tripping this field, and nothing
 * asked it to.
 */
const TEAMMATE_MAPPING: Mapping = {
  purpose: "writing_assistant",
  kind: "llm.generate",
  // Deliberately the same name as the mapper's own service above: a store
  // keyed on the name alone would pass a case that used a distinct one.
  service: "qwen",
  // carol — a second teammate, whose qwen is not bob's.
  owner: "5cbc8f4c-96ab-4c1e-b5b6-9d4b2a1f0e04",
};

/** Run the contract. Call inside a suite; it declares its own `describe`. */
export function describePolicyStoreContract(
  name: string,
  options: PolicyStoreContractOptions,
): void {
  describe(`the policy store — ${name}`, () => {
    it("says a site nobody authorised is not consented", async () => {
      // The ordinary answer, not an error. A person who has never heard of a
      // site is the common case, and a store that threw here would make the
      // engine treat "no" as "broken".
      const { store, done } = await options.make();
      const snapshot = await store.read({
        siteId: SITE,
        user: USER,
        owner: OWNER,
      });
      expect(snapshot.consented).toBe("no");
      expect(snapshot.mappings).toEqual([]);
      await done();
    });

    it("returns the mapping the consent carried", async () => {
      const s = await options.make();
      await s.consent({ siteId: SITE, user: USER, mappings: [MAPPING] });
      const snapshot = await s.store.read({
        siteId: SITE,
        user: USER,
        owner: OWNER,
      });
      expect(snapshot.consented).toBe("yes");
      expect([...snapshot.mappings]).toEqual([MAPPING]);
      await s.done();
    });

    it("round-trips whose service a mapping names", async () => {
      /**
       * The field the anti-substitution check is made of.
       *
       * A store that answers `null` here — or the querying device's owner —
       * makes `(mapped.owner ?? job.owner) !== owner` pass for the wrong
       * machine, and a grant gets signed putting somebody's work on a device
       * they never chose. Device-side checks do not save it: the wrong
       * machine's service is team-scoped and the person is a legitimate
       * member, so admission succeeds.
       *
       * `null` and a real owner are both asserted, because the two are read
       * through the same column and a store that swapped them would satisfy
       * either case alone.
       */
      const s = await options.make();
      await s.consent({
        siteId: SITE,
        user: USER,
        mappings: [TEAMMATE_MAPPING],
      });
      await s.addMember({ owner: OWNER, user: USER });

      const snapshot = await s.store.read({
        siteId: SITE,
        user: USER,
        owner: OWNER,
      });

      expect(snapshot.mappings).toEqual([TEAMMATE_MAPPING]);
      expect(snapshot.mappings[0]?.owner).toBe(TEAMMATE_MAPPING.owner);
      await s.done();
    });

    it("keeps two same-named services apart by whose they are", async () => {
      /**
       * The substitution itself, as a stored fact.
       *
       * Alice is on two teams that both run a `qwen`. Those are two different
       * machines and the consent screen shows them as two options; a store
       * that collapsed them would let either claim the work. Two mappings
       * under one consent, which no case here previously exercised either.
       */
      const s = await options.make();
      await s.consent({
        siteId: SITE,
        user: USER,
        mappings: [
          { ...MAPPING, purpose: "mine" },
          { ...TEAMMATE_MAPPING, purpose: "theirs" },
        ],
      });
      await s.addMember({ owner: OWNER, user: USER });

      const snapshot = await s.store.read({
        siteId: SITE,
        user: USER,
        owner: OWNER,
      });

      const byPurpose = new Map(
        snapshot.mappings.map((m) => [m.purpose, m.owner]),
      );
      expect(byPurpose.get("mine")).toBeNull();
      expect(byPurpose.get("theirs")).toBe(TEAMMATE_MAPPING.owner);
      await s.done();
    });

    it("distinguishes consented-and-unmapped from never-consented", async () => {
      // A real signup state: every slot had two candidates, so nothing
      // auto-mapped and the person has not chosen. It is not the same as
      // never having authorised the site, and it sends them somewhere else.
      const s = await options.make();
      await s.consent({ siteId: SITE, user: USER, mappings: [] });
      const snapshot = await s.store.read({
        siteId: SITE,
        user: USER,
        owner: OWNER,
      });
      expect(snapshot.consented).toBe("yes");
      expect(snapshot.mappings).toEqual([]);
      await s.done();
    });

    it("deletes the mapping when consent is withdrawn", async () => {
      // Hole 2: the mapping *is* the consent, so un-consenting unmaps. A
      // store that kept the mapping would hold a resolution pointing at a
      // service its author no longer authorises anybody to reach.
      const s = await options.make();
      await s.consent({ siteId: SITE, user: USER, mappings: [MAPPING] });
      await s.revoke({ siteId: SITE, user: USER });
      const snapshot = await s.store.read({
        siteId: SITE,
        user: USER,
        owner: OWNER,
      });
      expect(snapshot.consented).toBe("no");
      expect(snapshot.mappings).toEqual([]);
      await s.done();
    });

    it("reads a paused consent as not consented", async () => {
      // Three states, one boolean, on purpose: never authorised, revoked and
      // paused are different to a person and identical to a grant. A relay's
      // projection can lag by seconds, so a store that reported a paused
      // consent as live would let a grant be authored for work its owner had
      // just stopped.
      const s = await options.make();
      if (!s.pause) {
        await s.done();
        return;
      }
      await s.consent({ siteId: SITE, user: USER, mappings: [MAPPING] });
      await s.pause({ siteId: SITE, user: USER });
      const snapshot = await s.store.read({
        siteId: SITE,
        user: USER,
        owner: OWNER,
      });
      expect(snapshot.consented).toBe("paused");

      /**
       * `"paused"`, not `"no"` — byollm-review 2026-08-27.
       *
       * The distinction is the whole reason this stopped being a boolean. A
       * store reporting a pause as "no" is not merely imprecise: the engine
       * declines `not-consented`, which is **permanent**, and the relay never
       * offers that job to that device again. The hosted product pauses a
       * consent the moment its author joins a team, so this is an everyday
       * path, and re-consenting minutes later did not bring the work back.
       *
       * A pause is somebody's own to lift, so the job has to still be there
       * when they do.
       */
      await s.done();
    });

    it("keeps one person's consent out of another's", async () => {
      const s = await options.make();
      await s.consent({ siteId: SITE, user: USER, mappings: [MAPPING] });
      const other = await s.store.read({
        siteId: SITE,
        user: CAROL,
        owner: OWNER,
      });
      expect(other.consented).toBe("no");
      await s.done();
    });

    it("keeps one site's consent out of another's", async () => {
      const s = await options.make();
      await s.consent({ siteId: SITE, user: USER, mappings: [MAPPING] });
      const other = await s.store.read({
        siteId: OTHER_SITE,
        user: USER,
        owner: OWNER,
      });
      expect(other.consented).toBe("no");
      await s.done();
    });

    it("reports membership per owner, not per person", async () => {
      // A team is one owner's, and being on one confers nothing about
      // anybody else's devices. A store that kept a global "alice is a team
      // member" flag would share every owner's hardware with her.
      const s = await options.make();
      await s.addMember({ owner: OWNER, user: USER });
      const mine = await s.store.read({
        siteId: SITE,
        user: USER,
        owner: OWNER,
      });
      const theirs = await s.store.read({
        siteId: SITE,
        user: USER,
        // carol — a second teammate, whose qwen is not bob's.
        owner: "5cbc8f4c-96ab-4c1e-b5b6-9d4b2a1f0e04",
      });
      expect(mine.member).toBe(true);
      expect(theirs.member).toBe(false);
      await s.done();
    });

    it("stops reporting membership once somebody is removed", async () => {
      // Removal is the whole of it — there is no blocked-but-still-a-member,
      // because a team *is* access to its owner's devices (Amendment J).
      const s = await options.make();
      await s.addMember({ owner: OWNER, user: USER });
      await s.removeMember({ owner: OWNER, user: USER });
      const snapshot = await s.store.read({
        siteId: SITE,
        user: USER,
        owner: OWNER,
      });
      expect(snapshot.member).toBe(false);
      await s.done();
    });

    it("keeps membership and consent independent", async () => {
      // Two different questions, and both have to be yes. A store that
      // conflated them would let a team member's work run on a site they
      // never authorised, or refuse a person their own site because nobody
      // had added them to a team.
      const s = await options.make();
      await s.addMember({ owner: OWNER, user: USER });
      const noConsent = await s.store.read({
        siteId: SITE,
        user: USER,
        owner: OWNER,
      });
      expect(noConsent.member).toBe(true);
      expect(noConsent.consented).toBe("no");

      await s.consent({ siteId: SITE, user: CAROL, mappings: [MAPPING] });
      const noMembership = await s.store.read({
        siteId: SITE,
        user: CAROL,
        owner: OWNER,
      });
      expect(noMembership.consented).toBe("yes");
      expect(noMembership.member).toBe(false);
      await s.done();
    });

    it.runIf(options.opaqueIds !== false)(
      "does not let a site id and a user id be confused for each other",
      async () => {
        // Composite keys are parsers waiting to meet an id containing their
        // separator. These two consents differ only in where the boundary
        // falls, and a store that joined them naively would answer one for
        // the other.
        const s = await options.make();
        await s.consent({ siteId: "a", user: "b:c", mappings: [MAPPING] });
        const confusable = await s.store.read({
          siteId: "a:b",
          user: "c",
          owner: OWNER,
        });
        expect(confusable.consented).toBe("no");
        await s.done();
      },
    );
  });
}
