import { z } from "zod";
import { type BackendCost } from "./backends.js";

/**
 * Who may run a job, declared by the app that enqueued it.
 *
 * - `private` — only the job owner's own devices.
 * - `team` — a device whose owner admits this person.
 *
 * **One vocabulary, ruled 2026-08-24.** These were `self | named | public`
 * while {@link OfferScope} used different words for the same idea, which would
 * have left every seam where the two meet speaking two languages, and every
 * doc explaining "self versus private" for ever. They are still independent
 * axes — a job says who may run it, a service says who it will run for — and a
 * job runs only where both agree ({@link MUSTS.AUDIENCE_BOTH_SIDES}).
 *
 * **`public` is gone, ruled 2026-08-26 (byollm_016).** Not deprecated,
 * removed, and removed from the OSS daemon too rather than parked as a
 * community posture. The argument was a measurement rather than a preference:
 * device-side admission had never once been exercised end to end, because
 * every cross-user test ran against a publicly offered service and
 * {@link matchAudience} returned ALLOWED for those *without consulting the
 * device at all*. `public` was the off switch for admission, and an enum with
 * a value that skips verification is a fail-open waiting for the wiring bug
 * that reaches it. There is now no such value.
 */
export const Audience = z.enum(["private", "team"]);
export type Audience = z.infer<typeof Audience>;

/**
 * What a device's owner is willing to run for other people, per service.
 *
 * - `private` — the owner's own work only.
 * - `team` — whoever the owner's authority admits. Membership is **central**,
 *   not per-person: the device follows what it is told by a signature it can
 *   check, rather than holding its own copy of who is in it (byollm_016).
 *
 * Two values, and no third that means "everyone". See {@link Audience} for
 * why `public` was removed rather than parked, and note the shape of the
 * remaining enum: **every value left requires the device to verify
 * something.** `private` checks the owner; `team` checks admission. That is
 * the property, not an accident of there being two.
 */
export const OfferScope = z.enum(["private", "team"]);
export type OfferScope = z.infer<typeof OfferScope>;

/** All audience values, in widening order. */
export const AUDIENCES = Object.freeze(Audience.options);
/** All offer scopes, in widening order. */
export const OFFER_SCOPES = Object.freeze(OfferScope.options);

/**
 * Why a job was refused. Distinct codes because byollm_002 requires that
 * different truths never share a message — "no matching work" and "refused on
 * principle" are not the same event, and a volunteer debugging their setup
 * needs to know which one happened.
 */
export const MatchRefusal = z.enum([
  /** The daemon advertises no capability for this kind. */
  "no-capability",
  /** Job is `private` but this daemon belongs to a different user. */
  "audience-self-other-owner",
  /** Job is `team` but this device does not admit the job's owner. */
  "not-locally-allowed",
  /** Job is `team` but the server's own allowlist excludes this runner. */
  "not-in-server-allowlist",
  /** The service offers only `private` and the job belongs to someone else. */
  "offer-scope-too-narrow",
  /** The matched backend is subscription-class, which is locked to `private`. */
  "subscription-self-lock",
  /** The backend spends the owner's money and they have not agreed to share it. */
  "metered-no-spend-consent",
  /** The backend is shared but has spent its ceiling for now. */
  "metered-ceiling-reached",
]);
export type MatchRefusal = z.infer<typeof MatchRefusal>;

/** The outcome of an audience match. */
export type MatchResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: MatchRefusal };

const ALLOWED: MatchResult = Object.freeze({ ok: true as const });
const refuse = (refusal: MatchRefusal): MatchResult =>
  Object.freeze({ ok: false as const, refusal });

/** What the owner has agreed to spend on other people's work, if anything. */
export interface SpendConsent {
  /** The owner explicitly acknowledged that sharing this backend costs money. */
  readonly acknowledged: boolean;
  /** Their ceiling. Absent means no ceiling was set, which is not consent. */
  readonly ceilingReached?: boolean;
}

/**
 * The effective offer scope of a backend.
 *
 * Three rules, applied at the one place both the daemon's config loader and
 * its matcher call, so no code path can observe a scope wider than the cost
 * class allows:
 *
 * - `subscription` is locked to `private` regardless of config
 *   ({@link MUSTS.SUBSCRIPTION_SELF_LOCK}) — someone else's terms.
 * - `metered` narrows to `private` unless the owner has explicitly acknowledged
 *   the spend ({@link MUSTS.METERED_DEFAULTS_SELF}) — their money.
 * - `free` passes through — their electricity.
 *
 * Note the asymmetry: subscription can never be widened, metered can be
 * widened deliberately. Conflating those was byollm_007's bug.
 */
export function effectiveOfferScope(
  configured: OfferScope,
  cost: BackendCost,
  spend?: SpendConsent,
): OfferScope {
  if (cost === "subscription") return "private";
  if (cost === "metered" && spend?.acknowledged !== true) return "private";
  return configured;
}

/** The job-side facts a match needs. */
export interface MatchJob {
  /** The app's id for the user who enqueued the job. */
  readonly owner: string;
  /** Who the app says may run it. */
  readonly audience: Audience;
  /**
   * Optional server-side restriction on which runner owners may take a
   * `team` job. Defence in depth only, and direct-mode only — it never
   * reaches a daemon (cloud_008 §0.2), so the device's own admission is the
   * enforcing side ({@link MUSTS.NAMED_LOCAL_ALLOWLIST}).
   */
  readonly audienceAllow?: readonly string[] | undefined;
}

/** The daemon-side facts a match needs. */
export interface MatchDaemon {
  /** The app's id for the user this daemon is paired to. */
  readonly owner: string;
  /** Effective scope of the backend that would run the job. */
  readonly offerScope: OfferScope;
  /** Who pays for that backend's tokens. */
  readonly cost: BackendCost;
  /** What the owner agreed to spend on others, for a `metered` backend. */
  readonly spend?: SpendConsent | undefined;
  /**
   * Does this daemon's *local* allowlist admit the given owner for the server
   * origin the job came from? Supplied as a predicate so the protocol package
   * stays free of file I/O; the daemon passes its allowlist, the server
   * passes a conservative `() => true` because it cannot know a remote
   * daemon's local list and must not pretend to.
   */
  readonly locallyAllows: (owner: string) => boolean;
}

/**
 * Decide whether a job may run on a daemon.
 *
 * Both sides must agree ({@link MUSTS.AUDIENCE_BOTH_SIDES}):
 * 1. the job's audience must admit the daemon's owner, and
 * 2. the backend's offer scope must admit the job's owner.
 *
 * The full four-way matrix (two audiences × two offer scopes) is asserted by
 * the conformance kit. The function is pure and total so both the daemon
 * and the server can run the identical rule — the daemon refuses, and the
 * server refuses too (byollm_003 §Server-side MUSTs).
 *
 * @example
 * ```ts
 * const result = matchAudience(
 *   { owner: "alice", audience: "team" },
 *   {
 *     owner: "bob",
 *     offerScope: "team",
 *     cost: "free",
 *     locallyAllows: (o) => o === "alice",
 *   },
 * );
 * // result.ok === true
 * ```
 */
export function matchAudience(job: MatchJob, daemon: MatchDaemon): MatchResult {
  const sameOwner = job.owner === daemon.owner;

  // --- Side 1: does the job's audience admit this daemon's owner? --------
  if (job.audience === "private" && !sameOwner) {
    return refuse("audience-self-other-owner");
  }
  if (
    job.audience === "team" &&
    !sameOwner &&
    job.audienceAllow !== undefined &&
    !job.audienceAllow.includes(daemon.owner)
  ) {
    return refuse("not-in-server-allowlist");
  }

  // --- Side 2: does the backend's offer scope admit the job's owner? -----
  // The lock is re-applied rather than trusted: a caller that passed a
  // widened scope for a subscription backend gets a refusal, not obedience.
  const scope = effectiveOfferScope(
    daemon.offerScope,
    daemon.cost,
    daemon.spend,
  );

  if (sameOwner) {
    // A daemon always runs its own owner's work, at any scope.
    return ALLOWED;
  }

  // Order matters for the message, not the outcome: all three refuse, and a
  // volunteer debugging their setup needs to know which truth applies.
  if (daemon.cost === "subscription") {
    return refuse("subscription-self-lock");
  }
  if (daemon.cost === "metered") {
    if (daemon.spend?.acknowledged !== true) {
      return refuse("metered-no-spend-consent");
    }
    if (daemon.spend.ceilingReached === true) {
      return refuse("metered-ceiling-reached");
    }
  }

  switch (scope) {
    case "private":
      return refuse("offer-scope-too-narrow");
    case "team":
      // The device decides, always. There is deliberately no branch here that
      // returns ALLOWED without asking it — `public` was that branch, and its
      // removal is what makes this switch a verification rather than a
      // lookup. Whatever supplies `locallyAllows` may change (byollm_016
      // Amendment J replaces a local list with a signed claim-time grant);
      // that it is *consulted* may not.
      return daemon.locallyAllows(job.owner)
        ? ALLOWED
        : refuse("not-locally-allowed");
  }
}

/**
 * Human-readable refusal text for the daemon's log and the trust UI.
 * Each refusal reads as a distinct truth — byollm_002's "four different
 * truths that must never share a message" applied to the audience axis.
 */
export const REFUSAL_MESSAGES: Readonly<Record<MatchRefusal, string>> =
  Object.freeze({
    "no-capability":
      "no backend on this device is configured and healthy for that job kind",
    "audience-self-other-owner":
      "the job is private to its owner and this device is paired to someone else",
    "not-locally-allowed":
      "the job's owner is not on this device's allowlist (byollm allow <server> <user>)",
    "not-in-server-allowlist":
      "the app restricted this job to named runners and this device is not one of them",
    "offer-scope-too-narrow":
      "this backend is offered to its owner only (byollm offer <backend> named|public to widen)",
    "subscription-self-lock":
      "subscription-backed models run their owner's work only — this is a protocol rule, not a setting",
    "metered-no-spend-consent":
      "this backend bills its owner per token, and they have not agreed to spend it on other people's work",
    "metered-ceiling-reached":
      "this backend is shared but has reached the spend ceiling its owner set",
  });
