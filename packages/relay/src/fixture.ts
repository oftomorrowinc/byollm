import { PublicIdentity } from "@byollm/protocol";
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
     * The site's public identity, as the relay will hand it to the daemon.
     *
     * The relay distributes it and cannot use it: an identity key verifies
     * signatures and seals nothing. This is the key-exchange half of consent
     * (cloud_004 §3), and both endpoints pin what they receive.
     */
    site: PublicIdentity,
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

export const RelayFixture = z
  .object({
    consents: z.array(ConsentRecord),
    rosters: z.array(RosterRecord).default([]),
    /**
     * Owners whose routing is revoked, by `owner:siteId`.
     *
     * A separate list rather than deleting the consent record, because the
     * freeze gate needs revocation to be a *fixture edit* observable within
     * one heartbeat, and "the row is gone" and "the row was revoked" are
     * different things to a reader debugging why routing stopped.
     */
    revoked: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type RelayFixture = z.infer<typeof RelayFixture>;

/** An empty projection: nothing consented, so nothing routes. */
export const EMPTY_FIXTURE: RelayFixture = {
  consents: [],
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

  /** The consent binding this owner to this site, if it exists and stands. */
  consentFor(owner: string, siteId: string): ConsentRecord | null {
    if (this.#fixture.revoked.includes(`${owner}:${siteId}`)) return null;
    return (
      this.#fixture.consents.find(
        (c) => c.owner === owner && c.siteId === siteId,
      ) ?? null
    );
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
