import { PublicIdentity } from "@byollm/protocol";
import { routeKey } from "./state.js";
import { z } from "zod";

/**
 * What the relay is told about the world — cloud_004 §14.
 *
 * The relay decides nothing about who may talk to whom. It is handed a
 * projection of the control plane and routes according to it. Today that
 * projection is a file; later it is whatever the suite serves. Either way the
 * relay's own state is derived and disposable: delete it and the fixture
 * rebuilds it.
 *
 * ## This shape is a contract, not a test convenience
 *
 * cloud_004 §14 flags it and the flag is worth repeating here, where someone
 * will be tempted to add a field: **this is the projection contract.** The
 * first real control plane will be written to produce whatever this says, and
 * a field added carelessly now is a field the suite must produce forever.
 *
 * So two rules for anything added later:
 *
 * 1. **It must be something a control plane can actually know.** The relay
 *    cannot be given facts that only a daemon or only a site holds — that is
 *    how a blind relay stops being blind, one convenient field at a time.
 * 2. **It must be a decision, not a derivation.** Consent is a decision.
 *    Presence is not: the relay learns that from heartbeats. Anything the
 *    relay can observe does not belong in the projection.
 *
 * ## What is deliberately absent
 *
 * No private keys, of any party, ever. The relay holds public keys so it can
 * *verify* signatures and *tell a site who to seal to*. It holds no key that
 * can open anything, and {@link RelayFixture} has no field where one could be
 * put — `RELAY_BLIND` as a type, not as a promise.
 */

/**
 * A site the control plane registered and domain-verified — cloud_004 §5.
 *
 * **The one authority for a site's public identity.** It used to be inlined on
 * every consent record, which meant a site's key had as many homes as it had
 * users and nothing checked they agreed — the exact shape this project has now
 * found in a version constant, a clock read, an envelope deadline, a reseal
 * implementation, a package list and a docs page. Consents now reference a
 * site by id and the key is looked up here.
 *
 * The relay needs it for two things it cannot do without:
 *
 * 1. **Telling a daemon who to pin** at pairing — the key that makes relayed
 *    work unforgeable, since the relay holds no key that could produce it.
 * 2. **Authenticating the site plane.** A site calls a relay the way a daemon
 *    does, signing with this identity, and this is the key those signatures
 *    are checked against.
 */
export const SiteRecord = z
  .object({
    /** How the control plane names the site. */
    siteId: z.string().min(1),
    /**
     * The site's public identity.
     *
     * The relay distributes it and cannot use it: an identity key verifies
     * signatures and seals nothing. This is the key-exchange half of consent
     * (cloud_004 §3), and both endpoints pin what they receive.
     */
    site: PublicIdentity,
  })
  .strict();
export type SiteRecord = z.infer<typeof SiteRecord>;

/**
 * A user's decision to let one site use their compute — cloud_004 §3.
 *
 * `CONSENT_BEFORE_ROUTE`: with no record here, the relay refuses to route,
 * and there is no discovery path that creates one. Consent is a click in the
 * control plane; the relay only ever reads the result.
 */
export const ConsentRecord = z
  .object({
    /** The user, as the control plane identifies them. */
    owner: z.string().min(1),
    /** Which site this consent is for. Scoped: consent is never global. */
    siteId: z.string().min(1),
    /**
     * The consent stands, and nothing routes under it — cloud_008 finding 48.
     *
     * The disclosure this user agreed to no longer describes their
     * arrangements: they read that their prompts stay on machines they own,
     * and they have since been added to a roster whose owner can read them.
     * Until they have been shown the other sentence and clicked, their work
     * does not move.
     *
     * **A third state, because the two we had are both wrong here.** Dropping
     * the consent makes `consentFor` return null, and the daemon plane reads
     * exactly that as revoked: heartbeat answers `revoked: true` with `lost:
     * all`, and the daemon prints "this runner was revoked" and *deletes its
     * pairing*. So a user whose team changed a setting would be told a human
     * cut them off, lose their pinned keys, and have to re-run `byollm
     * connect` after re-consenting. Under cloud_009 that is worse still: the
     * pairing is keyed by origin, so one stale consent would drop the pairing
     * for every other site reached through that hub.
     *
     * Reporting it as revoked is the same falsehood finding 48 exists to
     * delete, told one layer down. So the record stays, the relationship
     * stays, and the routing stops.
     */
    paused: z.boolean().default(false),
  })
  .strict();
export type ConsentRecord = z.infer<typeof ConsentRecord>;

/**
 * A named group whose members may use a shared machine — cloud_004 §11.
 *
 * The roster lives here and **never reaches a site**. A site learns whether a
 * consenting user has reachable compute; it never learns who else is on the
 * roster. That is `ROSTERS_NEVER_LEAK` in cloud_004 §11.4, and the reason
 * this type has no outbound representation anywhere in this package.
 */
export const RosterRecord = z
  .object({
    /** Stable id for the group, used only inside the relay. */
    id: z.string().min(1),
    /** Who owns the shared compute. */
    owner: z.string().min(1),
    /** Members who may route to it. The owner is not implicitly a member. */
    members: z.array(z.string().min(1)),
  })
  .strict();
export type RosterRecord = z.infer<typeof RosterRecord>;

/**
 * A device its owner has approved — cloud_005 §7.1.
 *
 * The relay refuses a device that is not here, and that refusal is the point.
 * byollm_009's seventh finding stopped a daemon from *naming* itself; this
 * stops it from *keying* itself. A device that presents keys nobody approved
 * is a device whose owner never saw a fingerprint, and pairing it would make
 * the relay the authority on identity — which is exactly what it must not be.
 *
 * The three-party shape consent already has, applied to identity: the device
 * asserts, a human confirms in the control plane, the relay checks.
 */
export const DeviceRecord = z
  .object({
    /** Who approved it. */
    owner: z.string().min(1),
    /** The id the control plane assigned — the device does not choose it. */
    runnerId: z.string().min(1),
    /** The keys a human compared a fingerprint of before approving. */
    device: PublicIdentity,
  })
  .strict();
export type DeviceRecord = z.infer<typeof DeviceRecord>;

/** A revoked route, named by its parts. */
export const RevocationRecord = z
  .object({ owner: z.string().min(1), siteId: z.string().min(1) })
  .strict();
export type RevocationRecord = z.infer<typeof RevocationRecord>;

export const RelayFixture = z
  .object({
    /** Registered sites, by id. A consent for a site absent here routes not. */
    sites: z.array(SiteRecord).default([]),
    consents: z.array(ConsentRecord),
    devices: z.array(DeviceRecord).default([]),
    rosters: z.array(RosterRecord).default([]),
    /**
     * Routes that were revoked, as structured pairs.
     *
     * A separate list rather than deleting the consent record, because the
     * freeze gate needs revocation to be an observable *event* rather than an
     * absence — "the row is gone" and "the row was revoked" are different
     * answers to someone debugging why routing stopped.
     *
     * `{owner, siteId}` and never the composite string `"owner:siteId"`. A
     * composite key is a parser waiting to meet an id containing its
     * separator, which is the lesson the composite lease ids taught against
     * Postgres — applied here before it became a contract.
     */
    revoked: z.array(RevocationRecord).default([]),
  })
  .strict();
export type RelayFixture = z.infer<typeof RelayFixture>;

/** An empty projection: nothing consented, so nothing routes. */
export const EMPTY_FIXTURE: RelayFixture = {
  sites: [],
  consents: [],
  devices: [],
  rosters: [],
  revoked: [],
};

/**
 * The relay's read-only view of the projection.
 *
 * Deliberately a handful of questions rather than the raw fixture: every
 * caller asking "may this route?" through one method is what makes
 * `CONSENT_BEFORE_ROUTE` reviewable, and it leaves room for the projection to
 * become a service without touching a single call site.
 */
export class Projection {
  #fixture: RelayFixture;

  constructor(fixture: RelayFixture = EMPTY_FIXTURE) {
    this.#fixture = RelayFixture.parse(fixture);
  }

  /** Replace the projection wholesale — the control plane pushed a new one. */
  replace(fixture: RelayFixture): void {
    this.#fixture = RelayFixture.parse(fixture);
  }

  /**
   * The site this id names, if the control plane registered it.
   *
   * The only source of a site's public identity in this package. Everything
   * that pins, verifies or seals to a site starts here.
   */
  siteFor(siteId: string): SiteRecord | null {
    return this.#fixture.sites.find((s) => s.siteId === siteId) ?? null;
  }

  /**
   * The device this runner id names, if a human approved it.
   *
   * Returns null for a device the control plane does not know, which is how
   * the relay refuses to be the authority on identity.
   */
  deviceFor(runnerId: string): DeviceRecord | null {
    return this.#fixture.devices.find((d) => d.runnerId === runnerId) ?? null;
  }

  /** The device approved for these exact keys, if any. */
  deviceByFingerprint(identityPublic: string): DeviceRecord | null {
    return (
      this.#fixture.devices.find((d) => d.device.identity === identityPublic) ??
      null
    );
  }

  /**
   * The consent binding this owner to this site, if it exists and stands.
   *
   * **Liveness, not routing.** A paused consent is returned here: the
   * relationship exists, the daemon is not revoked, the pairing stands. Ask
   * {@link Projection.mayRouteFor} before moving anybody's work — the two
   * questions have different answers and one method answering both is how a
   * paused user would quietly start routing again.
   */
  consentFor(owner: string, siteId: string): ConsentRecord | null {
    const revoked = this.#fixture.revoked.some(
      (r) => r.owner === owner && r.siteId === siteId,
    );
    if (revoked) return null;
    return (
      this.#fixture.consents.find(
        (c) => c.owner === owner && c.siteId === siteId,
      ) ?? null
    );
  }

  /**
   * Every site this owner may route with — cloud_009 §3.
   *
   * The set a pairing covers, and the set a claim will filter on. Consent
   * decides it, which is the sentence the whole design rests on: a site
   * appears here because a human clicked, never because a site asked to be
   * here and never because a daemon named it.
   *
   * **Paused sites are here, and that is deliberate** — cloud_008 finding 48
   * as ratified. A paused consent routes nothing and keeps its pin: the
   * relationship stands, the key the daemon compared a fingerprint of stays
   * pinned, and re-consenting never costs a re-pair. Written the other way
   * round first, and three of the paused tests failed by refusing to pair at
   * all — which is the trap the finding is about, arriving through the door
   * marked "be stricter".
   *
   * So this is the *pairing* set and `mayRouteFor` is the *routing* set. Two
   * questions with different answers, kept apart for the same reason
   * `consentFor` and `mayRouteFor` are: one method answering both is how a
   * paused user quietly starts routing again, or quietly loses their machine.
   *
   * Sorted by site id so two calls with the same projection produce the same
   * answer: this ends up in a pairings file and in a fingerprint list a human
   * compares by eye, and an order that drifts between polls is a diff nobody
   * can read.
   */
  sitesFor(owner: string): SiteRecord[] {
    return this.#fixture.sites
      .filter((site) => this.consentFor(owner, site.siteId) !== null)
      .sort((a, b) => (a.siteId < b.siteId ? -1 : 1));
  }

  /**
   * May this owner's work move for this site, right now?
   *
   * Consent exists, was not revoked, and is not paused. The routing question,
   * kept apart from {@link Projection.consentFor}'s liveness one so that a
   * caller has to pick which it means.
   */
  mayRouteFor(owner: string, siteId: string): boolean {
    const consent = this.consentFor(owner, siteId);
    return consent !== null && !consent.paused;
  }

  /**
   * Has this owner's relationship *ended* — V1-2?
   *
   * Not "is there nothing to serve". Those were one question until the pre-v1
   * review pulled them apart, and the difference is a machine's pinned keys:
   * an empty answer made the daemon stop, cancel everything and **delete its
   * pairings file**, so a projection that arrived empty or half-written — one
   * bad control-plane push — cost every daemon its pins and every user a
   * re-pair they never asked for.
   *
   * Revocation is a thing somebody did, and this asks for the evidence of it:
   * a revocation record for this owner, and nothing left standing. A
   * projection that simply knows nothing says nothing — the relay answers
   * normally, the daemon serves nobody, and the pairing survives to be
   * correct again when the next push lands.
   *
   * The `revoked` list exists precisely for this and was consulted by
   * nothing. Its own doc said why: "the row is gone" and "the row was
   * revoked" are different answers, and only one of them is a decision.
   */
  revokedOutright(owner: string): boolean {
    if (this.sitesFor(owner).length > 0) return false;
    return this.#fixture.revoked.some((record) => record.owner === owner);
  }

  /** Whether this pair is consented and paused — what heartbeat reports. */
  pausedFor(owner: string, siteId: string): boolean {
    return this.consentFor(owner, siteId)?.paused === true;
  }

  /**
   * Every (site, owner) route this device may run — cloud_009 §3.
   *
   * The claim filter, collapsed to data a store can match on. `routableOwners`
   * was this for one site; the hub needs it for the set, and the shape had to
   * change rather than repeat, because **a set of sites and a set of owners
   * multiply**. A device whose owner consented to site A, serving a roster
   * member who consented to site B, appears in both sets and has no consented
   * route between them. Pairs cannot express a route nobody agreed to.
   *
   * Both halves of the rule are here, and neither was enforced before finding
   * 48's work:
   *
   * - **This machine's owner** must have a live consent for the site, or
   *   nothing of that site's runs here at all — including a roster member's
   *   work. The roster says whose jobs may land on this machine; consent says
   *   whether this machine is available to that site.
   * - **Each job's owner** must have one too. That check did not exist:
   *   consent was enforced by the daemon plane's blanket revoked guard, which
   *   asks only about the claiming device's owner, so a roster member who
   *   never consented to a site could have their work claimed by their admin's
   *   machine — `CONSENT_BEFORE_ROUTE` read the other way round.
   */
  routesFor(deviceOwner: string): Set<string> {
    const routes = new Set<string>();
    for (const site of this.#fixture.sites) {
      if (!this.mayRouteFor(deviceOwner, site.siteId)) continue;
      for (const owner of this.ownersRunnableBy(deviceOwner)) {
        if (!this.mayRouteFor(owner, site.siteId)) continue;
        routes.add(routeKey(site.siteId, owner));
      }
    }
    return routes;
  }

  /**
   * Every owner whose work this device's owner may run, as a list.
   *
   * The same question {@link mayRunFor} answers, asked in the direction a
   * *store* can use. That difference is the crux of making `claim` atomic
   * (cloud_006 §3.2).
   *
   * Today `claim` scans every job and calls `mayRunFor` per candidate, which
   * works because the projection is a local object. A shared routing store
   * cannot do that: the filter has to travel to the store, and a predicate
   * does not travel — you cannot send a closure to Valkey. So the projection
   * is collapsed to **data** here and handed over as a set the store can
   * match on.
   *
   * That the collapse is possible at all is a property of the design worth
   * noticing: `mayRunFor` is a finite lookup over consent and rosters, not a
   * computation over the jobs. If it ever became job-dependent — "may run
   * work of this size", say — an atomic claim would stop being expressible,
   * and that is the moment to argue rather than to add a parameter.
   *
   * The owner is always included: a device runs its owner's work, and the
   * relay checks that before it checks a roster.
   */
  ownersRunnableBy(deviceOwner: string): string[] {
    const owners = new Set([deviceOwner]);
    for (const roster of this.#fixture.rosters) {
      if (roster.owner !== deviceOwner) continue;
      for (const member of roster.members) owners.add(member);
    }
    return [...owners];
  }

  /**
   * May this device's owner run work belonging to `jobOwner`?
   *
   * The relay's half of `AUDIENCE_BOTH_SIDES`. It is only ever a *narrowing*:
   * the daemon re-checks its own allowlist locally and may still refuse, and
   * the site's audience already bounded who could be offered the job. A relay
   * that answered `true` for everyone would not widen anything — which is
   * exactly the property that lets it be blind.
   */
  mayRunFor(deviceOwner: string, jobOwner: string): boolean {
    if (deviceOwner === jobOwner) return true;
    return this.#fixture.rosters.some(
      (r) => r.owner === deviceOwner && r.members.includes(jobOwner),
    );
  }
}
