import { randomUUID } from "node:crypto";
import {
  RESERVED_PURPOSE,
  type CapabilityMatrix,
  type ClaimedStub,
  type OfferScope,
  type SignedGrant,
} from "@byollm/protocol";
import type { GrantSigner } from "./signer.js";
import type { PolicyStore } from "./store.js";

/**
 * Which offer scopes reach somebody other than the owner.
 *
 * An allowlist, never a denylist. A filter written against the excluded case
 * fails **open** the moment somebody renames the excluded value — which is
 * exactly what happened when `self` became `private` and every owner-locked
 * route was listed to a whole team. A scope this build has not been taught
 * stays narrow.
 *
 * Exhaustive over the protocol's vocabulary, so a scope added upstream fails
 * this file to compile until somebody decides whether it widens.
 */
const WIDENS: Readonly<Record<OfferScope, boolean>> = {
  private: false,
  team: true,
};
const WIDENING_SCOPES: ReadonlySet<string> = new Set(
  Object.entries(WIDENS)
    .filter(([, widens]) => widens)
    .map(([scope]) => scope),
);

/**
 * The control plane: one signed grant per job, or a reason there is none.
 *
 * byollm_016 Amendment J and L. This is the open engine behind a relay's
 * `authorGrant` seam. It reads policy from a {@link PolicyStore} it does not
 * own and signs with a {@link GrantSigner} whose key it never sees, so the
 * two things byollm.cloud keeps — the data and the key — sit outside it, and
 * the rule over them is readable by anybody.
 *
 * ## One routes, one authorises, only one signs
 *
 * A relay already filters what it offers a device, by consent and by
 * membership. **That filter is an optimisation and this is the authority.**
 * Everything is checked again here, because the relay's projection can be
 * stale and because a grant asserting "consented, member, admitted" must be
 * true when it is signed rather than when something upstream last looked. If
 * the two disagree, this one wins and refuses.
 */
export class ControlPlane {
  readonly #store: PolicyStore;
  readonly #signer: GrantSigner;
  readonly #now: () => number;
  readonly #newId: () => string;

  constructor(options: {
    readonly store: PolicyStore;
    readonly signer: GrantSigner;
    /** Injectable clock, so tests move time instead of sleeping. */
    readonly now?: () => number;
    /** Injectable id source, so a test can assert what was signed. */
    readonly newGrantId?: () => string;
  }) {
    this.#store = options.store;
    this.#signer = options.signer;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newGrantId ?? (() => `grant_${randomUUID()}`);
  }

  /** The key devices pin at pairing, from the same object that signs. */
  get publicKey(): string {
    return this.#signer.publicKey;
  }

  /**
   * Author a grant for one claimed job, or decline with a reason.
   *
   * The order below is the law, and it is ordered by *whose* fact each step
   * is: the device's own owner first, then the person's consent, then their
   * membership, then their mapping, then this machine's ability to honour it.
   * A step that fails stops the rest, so the reason returned names the first
   * thing that was actually wrong rather than whichever check ran last.
   */
  /**
   * Can this purpose be satisfied for this person, asked before a job exists.
   *
   * The two answers a site can act on, each decided where it is knowable and
   * nowhere else. A purpose the manifest does not declare will not appear in
   * it by waiting. A purpose nobody has mapped is the person's own dashboard,
   * and somebody who maps it thirty seconds from now is served by the next
   * job — the same thirty seconds, and it avoids the thing that must never
   * happen: a job the site has already fallen back on being served afterwards.
   *
   * Everything else is `ok`, including every case the transient path was
   * always for — declared, mapped, and nothing able to claim right now.
   *
   * Deliberately not a second gate at claim. This answers at enqueue, claim
   * answers at claim, and a mapping revoked between the two falls to the
   * transient path exactly as it does today.
   */
  async satisfiable(input: {
    readonly siteId: string;
    readonly user: string;
    readonly purpose: string | undefined;
    readonly kind: string;
  }): Promise<{ verdict: "ok" | "not-declared" | "unmapped" }> {
    const snapshot = await this.#store.read({
      siteId: input.siteId,
      user: input.user,
      // No device is involved yet, so the reader is the person themselves.
      // `member` is a claim-time question about somebody else's machine.
      owner: input.user,
    });

    const purpose = input.purpose ?? RESERVED_PURPOSE;

    // A store that cannot say what a site declares must not make every purpose
    // undeclared, and a site with no manifest declares everything — the
    // implicit-`default` reading the consent screen already uses, and the one
    // a stricter reading once broke by refusing a write with no surface.
    if (snapshot.declares !== undefined && !snapshot.declares.has(purpose)) {
      return { verdict: "not-declared" };
    }

    const mapped = snapshot.mappings.some(
      (mapping) => mapping.purpose === purpose && mapping.kind === input.kind,
    );
    return { verdict: mapped ? "ok" : "unmapped" };
  }

  async authorGrant(input: {
    readonly job: ClaimedStub;
    /** The site's id in this control plane's namespace, for the policy read. */
    readonly siteId: string;
    /**
     * The same site, as the key id the device pinned — the value that gets
     * signed.
     *
     * Two ids for one site, and both are needed: the store is keyed by the
     * control plane's own id, and the device knows sites only by what it
     * pinned. The grant carries the one the device can check without asking
     * anybody, which is the whole point of a signed document.
     */
    readonly siteKey: string;
    /** The device owner asking. */
    readonly owner: string;
    /**
     * Which of the site's declared purposes this job serves.
     *
     * Supplied by the caller rather than read off the job, because in the
     * release that built this engine the stub does not carry one yet — every
     * job is the site's {@link RESERVED_PURPOSE}. When purposes reach the
     * wire, the caller passes the job's own and nothing here changes.
     */
    readonly purpose?: string;
    /**
     * What this device advertised it can serve.
     *
     * The control plane resolves a mapping to a service **from what the
     * device said**, never from a name it invented. A mapping naming
     * something this device does not offer is not honoured here — see
     * `resolved-elsewhere`.
     */
    readonly capabilities: CapabilityMatrix;
  }): Promise<GrantOutcome> {
    const { job, owner } = input;
    const purpose = input.purpose ?? RESERVED_PURPOSE;

    let snapshot;
    try {
      snapshot = await this.#store.read({
        // The control plane's own id: the store is keyed by it, and the key
        // id below is for the device. Two ids, two readers, neither
        // substitutable for the other.
        siteId: input.siteId,
        user: job.owner,
        owner,
      });
    } catch {
      /**
       * A store that could not answer is not a refusal.
       *
       * Failing closed is right — nothing is signed — but the *shape* of the
       * failure matters more than it looks. A permanent refusal here would
       * mean a database blip permanently unpicked a job from a device, and
       * nothing would ever put it back. Transient, therefore, and the job
       * goes back in the queue.
       */
      return decline("store-unavailable");
    }

    /**
     * Refused, or asked again later — and the difference is the whole point.
     *
     * `not-consented` is permanent: never offer this job to this device
     * again. That is right for revoked and for never-authorised, because
     * somebody decided it and a queued job cannot outlive the decision.
     *
     * A **pause** is not a decision of that kind. The hosted product pauses a
     * consent the moment its author joins a team — no row changes — and the
     * remedy is theirs: read the sentence they have not read. Marking those
     * jobs permanently refused meant that by the time they re-consented,
     * every device that had claimed during the window would never offer them
     * again, and nothing anywhere said so.
     */
    if (snapshot.consented === "no") return decline("not-consented");
    if (snapshot.consented === "paused") return decline("consent-paused");

    /**
     * A device always runs its own owner's work, and no store is asked.
     *
     * Not an optimisation. Routing this through the store would put a law
     * somewhere an implementation could get wrong — including by answering
     * `member: false` for somebody's own account and silently stopping their
     * own device. There is no answer a store could give that should change
     * this, so it is not asked the question.
     */
    if (job.owner !== owner && !snapshot.member) return decline("not-a-member");

    const mapped = snapshot.mappings.find(
      (mapping) => mapping.purpose === purpose && mapping.kind === job.kind,
    );
    /**
     * An unmapped slot makes a purpose unavailable, never a site broken.
     *
     * Transient, because the remedy is the user's and they may take it: a
     * mapping authored a minute from now should let this job run, and a
     * permanent refusal would have quietly excluded the one device it was
     * about to point at.
     */
    if (!mapped) return decline("unmapped");

    /**
     * The device has to actually offer it, for this kind.
     *
     * Two different situations arrive here and this vantage cannot tell them
     * apart: the mapping resolved to a *different* device of this owner's, or
     * its referent is gone entirely — a service renamed or deleted. From one
     * device's capabilities both look identical, so the name says only what
     * is knowable here.
     *
     * Whether it is *no* device is a question for a sweep across the owner's
     * services, which is where the "your mapping needs updating" notification
     * belongs — not on the claim path, which sees one machine at a time.
     */
    /**
     * Whose machine, before which service.
     *
     * A service id means something only inside its owner's namespace, so a
     * mapping naming a teammate's `qwen` must not be satisfied by a different
     * teammate's `qwen` — or by the mapper's own. Checked before the
     * capability list, because a device that merely shares a name is not
     * "the wrong service" but the wrong machine, and the capabilities of the
     * wrong machine say nothing either way.
     */
    if ((mapped.owner ?? job.owner) !== owner) {
      return decline("resolved-elsewhere");
    }

    /**
     * Offered to *this person*, not merely present on the machine.
     *
     * byollm-review 2026-08-27. This asked only whether a capability row with
     * that kind and service existed, and every row carries an `offerScope` it
     * never looked at. So a mapping naming a service its owner has since
     * narrowed to `private` was granted: the engine signed a document
     * asserting a teammate's admission onto a service offered to nobody.
     *
     * Nothing widened — the device's private-is-absolute check is structural
     * and refuses it. But the *shape* of the failure was wrong, and that is
     * the real defect. A device's refusal releases the job as `refused`,
     * which the upstream remembers permanently; the engine declining
     * `resolved-elsewhere` is a thirty-second wait. So an owner flipping
     * `qwen` to private for a minute permanently unpicked a teammate's queued
     * job from the one device it was always meant for, with nothing anywhere
     * reporting why — precisely what the transient-decline machinery exists
     * to prevent.
     *
     * The owner's own work is exempt structurally rather than by scope: a
     * device always runs its owner's jobs, `private` is a statement about
     * other people, and consulting the scope here would let the narrowest
     * setting stop somebody's own machine from serving them.
     */
    const offered = input.capabilities.some(
      (capability) =>
        capability.kind === job.kind &&
        capability.service === mapped.service &&
        (job.owner === owner || WIDENING_SCOPES.has(capability.offerScope)),
    );
    if (!offered) return decline("resolved-elsewhere");

    return {
      granted: await this.#signer.sign({
        grantId: this.#newId(),
        jobId: job.id,
        site: input.siteKey,
        user: job.owner,
        owner,
        purpose,
        kind: job.kind,
        service: mapped.service,
        issuedAt: this.#now(),
      }),
    };
  }
}

/**
 * Why no grant was authored — and, load-bearing, whether that is forever.
 *
 * The distinction exists because a relay releases a declined job, and a
 * release can carry `refused`, which means *never offer this job to this
 * device again*. Getting that wrong in the permissive direction is a
 * claim-refuse loop; getting it wrong in the strict direction is a job that
 * can never reach the machine it was always meant for, and no error anywhere.
 */
export type DeclineReason =
  /** This person may not use this owner's devices. */
  | "not-a-member"
  /** This person has not authorised this site. */
  | "not-consented"
  /**
   * Authorised, and temporarily not routing — byollm-review 2026-08-27.
   *
   * Transient by the same test every reason here is judged by: the person can
   * lift it themselves, so the job must still be waiting when they do.
   */
  | "consent-paused"
  /** They authorised it and left this slot empty. */
  | "unmapped"
  /** Their mapping names a service this device does not offer. */
  | "resolved-elsewhere"
  /** The policy store could not answer. Says nothing about the job. */
  | "store-unavailable";

export interface Decline {
  readonly reason: DeclineReason;
  /**
   * Never offer this job to this device again.
   *
   * True only for the two facts that a queued job cannot outlive: a person
   * removed from a team, and consent withdrawn. Hole 1 ruled that removal
   * stops future claims *including queued ones*, and this is where that is
   * enforced.
   *
   * Everything else is a state the user can change, or a fault of ours. A
   * permanent mark on those would outlive the condition that caused it.
   */
  readonly permanent: boolean;
}

export type GrantOutcome =
  | { readonly granted: SignedGrant; readonly declined?: undefined }
  | { readonly granted?: undefined; readonly declined: Decline };

const PERMANENT: ReadonlySet<DeclineReason> = new Set([
  "not-a-member",
  "not-consented",
]);

function decline(reason: DeclineReason): GrantOutcome {
  return { declined: { reason, permanent: PERMANENT.has(reason) } };
}
