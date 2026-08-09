import { z } from "zod";
import { type BackendAccount } from "./backends.js";

/**
 * Who may run a job, declared by the app that enqueued it.
 *
 * - `self` — only the job owner's own daemon.
 * - `named` — a daemon whose owner has explicitly allowed this (server, user)
 *   pair in their *local* allowlist (byollm_001 Rev 1 §B).
 * - `public` — any daemon offering `public` compute.
 */
export const Audience = z.enum(["self", "named", "public"]);
export type Audience = z.infer<typeof Audience>;

/**
 * What a daemon backend is willing to run, declared by the machine's owner.
 * Same three values as {@link Audience}, but the two are independent axes —
 * a job runs only where both agree ({@link MUSTS.AUDIENCE_BOTH_SIDES}).
 */
export const OfferScope = z.enum(["self", "named", "public"]);
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
  /** Job is `self` but this daemon belongs to a different user. */
  "audience-self-other-owner",
  /** Job is `named` but this daemon's local allowlist does not admit the owner. */
  "not-locally-allowed",
  /** Job is `named`/`public` but the server's own allowlist excludes this runner. */
  "not-in-server-allowlist",
  /** The backend offers only `self` and the job belongs to someone else. */
  "offer-scope-too-narrow",
  /** The matched backend is subscription-class, which is locked to `self`. */
  "subscription-self-lock",
]);
export type MatchRefusal = z.infer<typeof MatchRefusal>;

/** The outcome of an audience match. */
export type MatchResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: MatchRefusal };

const ALLOWED: MatchResult = Object.freeze({ ok: true as const });
const refuse = (refusal: MatchRefusal): MatchResult =>
  Object.freeze({ ok: false as const, refusal });

/**
 * The effective offer scope of a backend.
 *
 * A subscription-class backend is locked to `self` regardless of what config
 * requests ({@link MUSTS.SUBSCRIPTION_SELF_LOCK}). This is a protocol MUST,
 * not a setting: the lock is applied here, at the one place both the daemon's
 * config loader and its matcher call, so there is no code path that observes
 * a widened subscription scope.
 */
export function effectiveOfferScope(
  configured: OfferScope,
  account: BackendAccount,
): OfferScope {
  return account === "subscription" ? "self" : configured;
}

/** The job-side facts a match needs. */
export interface MatchJob {
  /** The app's id for the user who enqueued the job. */
  readonly owner: string;
  /** Who the app says may run it. */
  readonly audience: Audience;
  /**
   * Optional server-side restriction on which runner owners may take a
   * `named` job. Defence in depth only — the daemon's local allowlist is the
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
  /** Account class of that backend. */
  readonly account: BackendAccount;
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
 * The full nine-way matrix (three audiences × three offer scopes) is asserted
 * by the conformance kit. The function is pure and total so both the daemon
 * and the server can run the identical rule — the daemon refuses, and the
 * server refuses too (byollm_003 §Server-side MUSTs).
 *
 * @example
 * ```ts
 * const result = matchAudience(
 *   { owner: "alice", audience: "named" },
 *   {
 *     owner: "bob",
 *     offerScope: "named",
 *     account: "open",
 *     locallyAllows: (o) => o === "alice",
 *   },
 * );
 * // result.ok === true
 * ```
 */
export function matchAudience(job: MatchJob, daemon: MatchDaemon): MatchResult {
  const sameOwner = job.owner === daemon.owner;

  // --- Side 1: does the job's audience admit this daemon's owner? --------
  if (job.audience === "self" && !sameOwner) {
    return refuse("audience-self-other-owner");
  }
  if (
    job.audience === "named" &&
    !sameOwner &&
    job.audienceAllow !== undefined &&
    !job.audienceAllow.includes(daemon.owner)
  ) {
    return refuse("not-in-server-allowlist");
  }

  // --- Side 2: does the backend's offer scope admit the job's owner? -----
  // The lock is re-applied rather than trusted: a caller that passed a
  // widened scope for a subscription backend gets a refusal, not obedience.
  const scope = effectiveOfferScope(daemon.offerScope, daemon.account);

  if (sameOwner) {
    // A daemon always runs its own owner's work, at any scope.
    return ALLOWED;
  }

  if (daemon.account === "subscription") {
    return refuse("subscription-self-lock");
  }

  switch (scope) {
    case "self":
      return refuse("offer-scope-too-narrow");
    case "named":
      // byollm_001 Rev 1 §B: the daemon's own list decides, not the server's.
      return daemon.locallyAllows(job.owner)
        ? ALLOWED
        : refuse("not-locally-allowed");
    case "public":
      return ALLOWED;
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
      "no backend on this machine is configured and healthy for that job kind",
    "audience-self-other-owner":
      "the job is private to its owner and this machine is paired to someone else",
    "not-locally-allowed":
      "the job's owner is not on this machine's allowlist (byollm allow <server> <user>)",
    "not-in-server-allowlist":
      "the app restricted this job to named runners and this machine is not one of them",
    "offer-scope-too-narrow":
      "this backend is offered to its owner only (byollm offer <backend> named|public to widen)",
    "subscription-self-lock":
      "subscription-backed models run their owner's work only — this is a protocol rule, not a setting",
  });
