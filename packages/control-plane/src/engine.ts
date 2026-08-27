import { randomUUID } from "node:crypto";
import type {
  CapabilityMatrix,
  ClaimedStub,
  SignedGrant,
} from "@byollm/protocol";
import type { GrantSigner } from "./signer.js";
import { RESERVED_PURPOSE, type PolicyStore } from "./store.js";

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
  async authorGrant(input: {
    readonly job: ClaimedStub;
    /** The site's id in this control plane's namespace, not its key id. */
    readonly siteId: string;
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

    if (!snapshot.consented) return decline("not-consented");

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
    const offered = input.capabilities.some(
      (capability) =>
        capability.kind === job.kind && capability.service === mapped.service,
    );
    if (!offered) return decline("resolved-elsewhere");

    return {
      granted: await this.#signer.sign({
        grantId: this.#newId(),
        jobId: job.id,
        siteId: input.siteId,
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
