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
}

const SITE = "site_demo";
const OWNER = "bob";
const USER = "alice";
const MAPPING: Mapping = {
  purpose: "writing_assistant",
  kind: "llm.generate",
  service: "qwen",
  owner: null,
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
      expect(snapshot.consented).toBe(false);
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
      expect(snapshot.consented).toBe(true);
      expect([...snapshot.mappings]).toEqual([MAPPING]);
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
      expect(snapshot.consented).toBe(true);
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
      expect(snapshot.consented).toBe(false);
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
      expect(snapshot.consented).toBe(false);
      await s.done();
    });

    it("keeps one person's consent out of another's", async () => {
      const s = await options.make();
      await s.consent({ siteId: SITE, user: USER, mappings: [MAPPING] });
      const other = await s.store.read({
        siteId: SITE,
        user: "carol",
        owner: OWNER,
      });
      expect(other.consented).toBe(false);
      await s.done();
    });

    it("keeps one site's consent out of another's", async () => {
      const s = await options.make();
      await s.consent({ siteId: SITE, user: USER, mappings: [MAPPING] });
      const other = await s.store.read({
        siteId: "site_other",
        user: USER,
        owner: OWNER,
      });
      expect(other.consented).toBe(false);
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
        owner: "carol",
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
      expect(noConsent.consented).toBe(false);

      await s.consent({ siteId: SITE, user: "carol", mappings: [MAPPING] });
      const noMembership = await s.store.read({
        siteId: SITE,
        user: "carol",
        owner: OWNER,
      });
      expect(noMembership.consented).toBe(true);
      expect(noMembership.member).toBe(false);
      await s.done();
    });

    it("does not let a site id and a user id be confused for each other", async () => {
      // Composite keys are parsers waiting to meet an id containing their
      // separator. These two consents differ only in where the boundary
      // falls, and a store that joined them naively would answer one for the
      // other.
      const s = await options.make();
      await s.consent({ siteId: "a", user: "b:c", mappings: [MAPPING] });
      const confusable = await s.store.read({
        siteId: "a:b",
        user: "c",
        owner: OWNER,
      });
      expect(confusable.consented).toBe(false);
      await s.done();
    });
  });
}
