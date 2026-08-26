import { z } from "zod";
import { PublicIdentity } from "./keys.js";
import { SignedRoster } from "./roster.js";
import { MAX_SUCCESSION_CHAIN, Succession } from "./succession.js";
import { OfferScope } from "./audience.js";
import { BackendClass, BackendIdSchema } from "./backends.js";
import { ClaimedStub } from "./job.js";
import { SealedEnvelope } from "./envelope.js";
import { JobKind } from "./kinds.js";

/** Protocol version carried on every request; servers refuse what they can't speak. */
export const PROTOCOL_VERSION = "0" as const;

/**
 * Every protocol version this build can serve, **oldest first**.
 *
 * One entry today. It is a list rather than a constant because the shape of
 * the check is the point: a server supporting two versions through a
 * migration should not need a different code path from one supporting one.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  PROTOCOL_VERSION,
]) as readonly string[];

/**
 * The oldest version this build will talk to — derived, not declared.
 *
 * Stating it separately would be a second thing to keep in step with the list
 * above, and the failure would be silent: a minimum that no longer matches
 * what is supported produces a refusal naming a version the server would in
 * fact have accepted.
 */
export const MIN_PROTOCOL_VERSION: string =
  SUPPORTED_PROTOCOL_VERSIONS[0] ?? PROTOCOL_VERSION;

/** A structured refusal, so a daemon can say something useful to its owner. */
export interface VersionRefusal {
  readonly error: "unsupported-protocol-version";
  readonly message: string;
  readonly supported: readonly string[];
  readonly minimum: string;
}

/**
 * The version a request declares, wherever it carries it.
 *
 * A POST declares it in its body, which is where every request schema has
 * always put it. A GET has no body, and the relay has one — the site plane's
 * `pending` read — so it declares it in the query string instead.
 *
 * **Two carriers, one rule.** That asymmetry is HTTP's rather than ours, and
 * the alternative was worse in both directions: a header for everything would
 * change every existing daemon's request, and skipping GETs would leave an
 * endpoint outside the handshake — which is precisely the shape B.4 found,
 * where a whole plane was outside it.
 */
export function declaredVersion(input: {
  body?: unknown;
  query?: URLSearchParams;
}): unknown {
  const { body, query } = input;
  if (
    typeof body === "object" &&
    body !== null &&
    Object.hasOwn(body, "protocolVersion")
  ) {
    return (body as { protocolVersion: unknown }).protocolVersion;
  }
  return query?.get("protocolVersion") ?? undefined;
}

/**
 * Check the protocol version on an incoming request
 * ({@link MUSTS.VERSION_HANDSHAKE_REQUIRED}).
 *
 * Returns a refusal, or `null` to proceed.
 *
 * **A missing version is refused the same way a wrong one is.** That is the
 * half worth stating: before this existed, the version travelled as a
 * `z.literal` inside each endpoint's schema, so a mismatch surfaced as a
 * generic `bad-request` — a daemon and a server discovered they disagreed by
 * failing, with nothing in the response naming the disagreement. An error a
 * user cannot act on is barely better than a hang.
 *
 * The message names the fix, because the person reading it is usually the one
 * who has to apply it.
 */
export function checkProtocolVersion(body: unknown): VersionRefusal | null {
  // `hasOwn`, not `in`: `in` walks the prototype chain, and a version check
  // should read what the request actually carried rather than something an
  // object happens to inherit. Not reachable from a JSON body today, which is
  // the reason to fix it now rather than after it is.
  const declared =
    typeof body === "object" &&
    body !== null &&
    Object.hasOwn(body, "protocolVersion")
      ? (body as { protocolVersion: unknown }).protocolVersion
      : undefined;

  if (typeof declared !== "string" || declared.length === 0) {
    return {
      error: "unsupported-protocol-version",
      message:
        "this request declared no protocol version. Upgrade the daemon: " +
        `\`${UPGRADE_COMMAND}\`.`,
      supported: SUPPORTED_PROTOCOL_VERSIONS,
      minimum: MIN_PROTOCOL_VERSION,
    };
  }

  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(declared)) {
    return {
      error: "unsupported-protocol-version",
      message:
        `this server speaks protocol ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")} ` +
        `and the daemon asked for ${declared}. ` +
        (declared < MIN_PROTOCOL_VERSION
          ? `Upgrade the daemon: \`${UPGRADE_COMMAND}\`.`
          : "This daemon is newer than the server; the server needs upgrading."),
      supported: SUPPORTED_PROTOCOL_VERSIONS,
      minimum: MIN_PROTOCOL_VERSION,
    };
  }

  return null;
}

/**
 * How to upgrade a daemon, in one place.
 *
 * `@latest`, which is correct in both eras and therefore never has to be
 * revisited: during a prerelease it resolves to the current alpha, and after
 * one it resolves to the current stable.
 *
 * `@alpha` was considered and rejected. The argument for it was that `latest`
 * is moved by hand — it needs a human with 2FA, deliberately — so it can lag
 * the `alpha` tag. In practice that lag has been minutes, and the cost on the
 * other side is permanent: the day this stops being a prerelease, `@alpha`
 * starts meaning "the unstable one", and every user who followed this message
 * is pinned to prereleases with nothing to tell them.
 *
 * Note this is deliberately *not* the rule `scripts/check-site.mjs` enforces
 * on the docs, which requires `npx byollm@alpha`. That rule is about somebody
 * choosing to install a prerelease knowingly, with the warning in front of
 * them. This is an upgrade instruction handed to somebody who already has the
 * daemon and needs a newer one — a different question with a different answer.
 */
export const UPGRADE_COMMAND = "npm i -g byollm@latest" as const;

/** The path prefix all endpoints mount under. */
export const PROTOCOL_PREFIX = "/byollm" as const;

/**
 * The endpoint names, in the order byollm_001 lists them, plus `fetch`.
 *
 * `fetch` is byollm_009 §6's second phase: a claim returns a stub, and the
 * payload is collected separately by the device that took it. Two steps
 * rather than one because a payload can only be sealed once its recipient is
 * known — which is also what makes multi-device free.
 */
export const ENDPOINTS = Object.freeze([
  "pair",
  "claim",
  "fetch",
  "heartbeat",
  "result",
  "release",
] as const);
export type Endpoint = (typeof ENDPOINTS)[number];

/**
 * One entry of the capability matrix: a kind this daemon can actually serve,
 * right now, with the backend and model that would serve it.
 *
 * Derived from owner config intersected with detected reality
 * ({@link MUSTS.CAPABILITY_IS_DETECTED}) — a configured-but-unreachable
 * backend must not appear here. Carries `backendClass` so the app can tell
 * whether a result came from a sandboxed spawn or an HTTP call
 * (byollm_001 Rev 1 §A).
 */
export const Capability = z
  .object({
    kind: JobKind,
    /**
     * The owner's name for the service answering this kind — byollm_016.
     *
     * A device advertises *which* of its services serves a kind, not merely
     * that something does. Phase B lets a job select by this name; until then
     * it is what a device page shows and what a default is chosen between.
     */
    service: z.string().min(1),
    /**
     * Whether this row is the default for its kind.
     *
     * Stated rather than inferred from being the only row, which is true in
     * Phase A and stops being true the moment Phase B advertises every
     * selectable service per kind. A consumer that learned "default means
     * alone" would have to unlearn it, and the ones that did not would be
     * quietly wrong. One field now, no second shape later.
     */
    isDefault: z.boolean(),
    backendId: BackendIdSchema,
    backendClass: BackendClass,
    model: z.string().min(1),
    offerScope: OfferScope,
  })
  .strict();
export type Capability = z.infer<typeof Capability>;

/** The capability matrix a daemon advertises. */
export const CapabilityMatrix = z.array(Capability);
export type CapabilityMatrix = z.infer<typeof CapabilityMatrix>;

/**
 * A kind this device could serve and deliberately does not — byollm_016.
 *
 * Two services answer one kind and the owner has not said which wins, so the
 * kind is not advertised. That is correct and, unsaid, invisible: the owner
 * adds a second service, jobs stop matching, and no surface explains it.
 *
 * It travels because the surfaces that must say so are not all on the device.
 * The owner's card names the claimants; a teammate's card says only that the
 * owner has a choice to make. Claimant **offer scopes** ride along so the hub
 * can compute that difference without the device deciding who is asking —
 * carry for computation, filter for display, the same shape the effective
 * offer already uses.
 */
export const WithheldKind = z
  .object({
    kind: JobKind,
    claimants: z
      .array(
        z.object({ service: z.string().min(1), offer: OfferScope }).strict(),
      )
      .min(2),
  })
  .strict();
export type WithheldKind = z.infer<typeof WithheldKind>;

// ---------------------------------------------------------------------------
// 1. POST /byollm/pair — device-code flow
// ---------------------------------------------------------------------------

/**
 * Pairing is a device-code exchange, not a pasted secret
 * ({@link MUSTS.PAIR_INTERACTIVE}). The daemon starts a pairing, shows the
 * user a short code and a URL, and polls until the user approves it inside
 * the app's own authenticated session. Nothing listens on the user's machine
 * and nothing works over a copied string alone.
 */
export const PairStartRequest = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    action: z.literal("start"),
    daemon: z.object({
      version: z.string().min(1),
      /** Shown in the app's runner list so a user can tell their machines apart. */
      label: z.string().min(1).max(120),
      platform: z.enum(["darwin", "linux", "win32"]),
    }),
    /**
     * This machine's public keys (byollm_009 §5).
     *
     * Pairing is where the two parties learn each other's identities, because
     * it is the one moment a human is already deciding to trust: the approval
     * click. A key exchanged anywhere else would be a key nobody chose.
     */
    device: PublicIdentity,
    capabilities: CapabilityMatrix,
  })
  .strict();
export type PairStartRequest = z.infer<typeof PairStartRequest>;

export const PairStartResponse = z
  .object({
    /** Secret the daemon polls with. Never shown to the user. */
    deviceCode: z.string().min(20),
    /** Short code the user reads and confirms in the browser. */
    userCode: z.string().min(4).max(16),
    /** Where the user approves. Must be on the server's own origin. */
    verificationUrl: z.url(),
    /** Epoch ms after which the code is dead ({@link MUSTS.PAIR_CODE_EXPIRES}). */
    expiresAt: z.number().int().positive(),
    /** How often the daemon may poll. */
    pollIntervalMs: z.number().int().min(500).max(60_000),
  })
  .strict();
export type PairStartResponse = z.infer<typeof PairStartResponse>;

export const PairPollRequest = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    action: z.literal("poll"),
    deviceCode: z.string().min(20),
  })
  .strict();
export type PairPollRequest = z.infer<typeof PairPollRequest>;

export const PairPollResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }).strict(),
  z.object({ status: z.literal("denied") }).strict(),
  z.object({ status: z.literal("expired") }).strict(),
  z
    .object({
      status: z.literal("approved"),
      // `runnerToken` is gone — cloud_008 §2.4, finding 37.
      //
      // It was minted here, hashed into `RunnerRecord.tokenHash`, written to
      // the daemon's pairings file, and then **never sent, never looked up
      // and never compared**. `getRunnerByTokenHash` existed on both stores
      // and was called by nothing but a test asserting it returns null.
      //
      // Not merely dead wire, which is what `audienceAllow` and
      // `HeartbeatResponse.leases` were. This was a *secret*: minted,
      // transmitted, and written to two disks at rest, for nothing. A
      // credential with no purpose is a liability rather than clutter,
      // because the only thing it can ever do is leak.
      //
      // `REQUESTS_SIGNED_NOT_BEARER` was already the rule and was already
      // enforced — every authenticated call is signed by the device's pinned
      // identity key. This removes the thing the MUST is named after.
      runnerId: z.string().min(1),
      /** The app's id for the approving user — this daemon's owner forever. */
      owner: z.string().min(1),
      /** Display name for the trust UI, if the app offers one. */
      ownerLabel: z.string().optional(),
      /**
       * The sites this pairing covers, for the daemon to pin (byollm_009 §5),
       * keyed by each site's identity key id — cloud_009 §5.
       *
       * Returned only on approval: a pending or denied poll learns nothing,
       * so an unapproved code cannot be used to enumerate a site's keys.
       *
       * **One pairing per upstream, not one per site.** A user who connects a
       * site on a web dashboard has no reason to go back to a laptop and run
       * a command, so which sites a pairing covers is a projection of consent
       * — refreshed on the heartbeat — rather than something frozen at
       * pairing. A direct site answers with exactly one entry, which is the
       * same shape and not a special case.
       *
       * Keyed by the id `stub.site` carries (Amendment A §A.3), so the
       * runner's lookup is a map read rather than a join across two
       * namespaces.
       */
      sites: z.record(z.string().min(1), PublicIdentity),
      /**
       * The control plane's roster-signing key, pinned here — Amendment G.
       *
       * **Pairing is when, and that is the whole question.** Pairing is
       * already the ceremony where an owner proves out of band that this
       * device is theirs, so a key learned here rides trust that has already
       * happened. The rejected alternative is trust-on-first-roster, and it
       * is rejected because it hands the decision back to the relay: a daemon
       * that learns whose signature to trust from the first roster to arrive
       * has its membership authority chosen by whoever controls delivery.
       *
       * Optional on the wire, and only on the wire: a direct-mode server has
       * no control plane and signs no rosters, and a daemon that never
       * receives one simply serves no `team` job through it. It is not
       * optional for a hub — a hub that omitted it would be asking devices to
       * accept rosters from nobody in particular.
       *
       * Rotation is Amendment C's, with no path where a roster teaches a
       * daemon a new key.
       */
      controlPlanePublic: z.string().min(1).optional(),
    })
    .strict(),
]);
export type PairPollResponse = z.infer<typeof PairPollResponse>;

export const PairRequest = z.discriminatedUnion("action", [
  PairStartRequest,
  PairPollRequest,
]);
export type PairRequest = z.infer<typeof PairRequest>;

// ---------------------------------------------------------------------------
// 2. POST /byollm/claim
// ---------------------------------------------------------------------------

export const ClaimRequest = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    runnerId: z.string().min(1),
    /** Re-sent on every claim so a server never matches against a stale matrix. */
    capabilities: CapabilityMatrix,
    /** Upper bound on jobs to return; the server may return fewer. */
    max: z.number().int().min(1).max(64),
  })
  .strict();
export type ClaimRequest = z.infer<typeof ClaimRequest>;

export const ClaimResponse = z
  .object({
    /**
     * Stubs, not jobs. The payload arrives from `fetch`, sealed to whichever
     * device claimed — see {@link JobStub} for the exhaustive metadata list.
     */
    jobs: z.array(ClaimedStub),
    /** Lease duration granted, so the daemon knows its renewal deadline. */
    leaseMs: z.number().int().positive(),
  })
  .strict();
export type ClaimResponse = z.infer<typeof ClaimResponse>;

// ---------------------------------------------------------------------------
// 3. POST /byollm/heartbeat
// ---------------------------------------------------------------------------

export const HeartbeatRequest = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    runnerId: z.string().min(1),
    daemonVersion: z.string().min(1),
    capabilities: CapabilityMatrix,
    /**
     * Kinds this device is withholding, and why it can be said.
     *
     * Optional so a daemon that has nothing withheld sends nothing, and so an
     * older daemon against a newer hub is simply a device with no withheld
     * kinds rather than a parse failure.
     */
    withheld: z.array(WithheldKind).default([]),
    /**
     * Leases this daemon believes it holds; the server renews exactly these.
     *
     * Lease ids rather than job ids, so a replayed heartbeat cannot renew a
     * grant the runner no longer holds — see {@link Lease.id}.
     */
    activeLeases: z.array(
      z.object({ jobId: z.string().min(1), leaseId: z.string().min(1) }),
    ),
    /** True while the owner has the daemon paused; the server stops offering work. */
    paused: z.boolean(),
  })
  .strict();
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

export const HeartbeatResponse = z
  .object({
    /**
     * The sites this daemon may serve, right now — cloud_008 finding 59.
     *
     * Revocation used to be a boolean, and it was device-wide: the daemon
     * plane refused every call when the (owner, hub-site) consent was gone,
     * heartbeat answered `revoked: true` with `lost: all`, and the daemon
     * dropped its whole pairing by origin. Under a hub that is one site's
     * revocation ending a machine's relationship with every other site it
     * served — the amplification finding 48 warned about, arriving through
     * the one field nobody thought of as tenancy.
     *
     * So the answer is the set. A site that leaves it is revoked *for that
     * site*: the daemon drops that pin and keeps the rest. An empty set is
     * what "revoked" used to mean, and the daemon can see that for itself
     * rather than being told a second time — two fields for one fact is how
     * they drift.
     */
    sites: z.record(z.string().min(1), PublicIdentity),
    /**
     * How a site's current key traces back to one this daemon already holds —
     * byollm_009 Amendment C.
     *
     * Keyed by the same id as `sites`, and **additive on purpose**: `sites`
     * remains the one statement of which key is current, and this says only
     * how that key got there. Two fields for one fact is how they drift; this
     * is two facts, and the second is evidence about the first.
     *
     * Optional because a site that has never rotated has no chain, which is
     * every site today. A daemon that receives one for an id it already holds
     * ignores it: the pin it has is the pin it approved.
     *
     * §12 carries what this adds to the metadata surface — a site's rotation
     * history is public by construction, because a daemon that cannot read it
     * cannot verify it.
     */
    successions: z
      .record(
        z.string().min(1),
        z
          .object({
            /** Oldest last, as the projection carries it. */
            succeeds: z.array(Succession).max(MAX_SUCCESSION_CHAIN),
            /**
             * Until when the superseded key may still sign work — epoch ms.
             *
             * The daemon holds its own clock against this, for the reason it
             * holds its own allowlist: a projection that could extend the
             * window indefinitely would be a two-key site forever, decided by
             * the party this design does not trust.
             */
            retiringUntil: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .optional(),
    /**
     * Per-job cancel (byollm_001 Rev 1 §C). The daemon aborts these jobs'
     * in-flight backend calls and reports them `canceled`.
     *
     * **The grant, not the id** — V1-3. Job ids are chosen per site, so two
     * sites may pick the same one, and a bare id told a daemon holding both
     * to abort whichever it happened to have filed under that name. The lease
     * is the unique grant and the daemon already keys its work by it; this is
     * the same shape `activeLeases` sends in the other direction.
     */
    cancel: z.array(
      z
        .object({ jobId: z.string().min(1), leaseId: z.string().min(1) })
        .strict(),
    ),
    // `leases` is deliberately absent — cloud_008 §1.4b, finding 16.
    //
    // It carried "these leases were renewed, and here is the new expiry", and
    // **no daemon ever read it.** A mutation returning an empty list while
    // renewing correctly survived every test, which is what made it visible.
    //
    // It is neither a class nor membership, so Amendment A's rule does not
    // decide it — the older test does: nothing reads it, so it is dead wire.
    // §6's exhaustiveness is a commitment about what an upstream can see, and
    // it applies to every message rather than only to the stub.
    //
    // `lost` is the actionable signal and always was: a daemon stops work on
    // a lease it no longer holds. "Renewed" was the same question answered a
    // second time, and a second answer can only agree or contradict.
    //
    // Renewal itself is untouched — the upstream still extends the grants a
    // heartbeat names, which is what §0.6 fixed. What ended is telling the
    // daemon about it in a field it ignored. If an upstream ever needs to
    // push lease decisions, that is a new field with a reader, added on
    // purpose.
    /**
     * Jobs the daemon thinks it holds but the server has reassigned or
     * expired. The daemon must stop work on these and not report results.
     *
     * Named by grant rather than by id, for V1-3's reason: a bare id is
     * ambiguous across sites, and "the lease you no longer hold" is exactly
     * what this field means anyway.
     */
    lost: z.array(
      z
        .object({ jobId: z.string().min(1), leaseId: z.string().min(1) })
        .strict(),
    ),
    /** Server clock, so a daemon with a skewed clock still honors leases. */
    serverTime: z.number().int().positive(),
    /**
     * Sites whose disclosure the user must read again before work moves —
     * cloud_008 finding 48, named rather than counted.
     *
     * A **subset of `sites`**, deliberately: a paused site keeps its pin, so
     * re-consenting never costs a re-pair. The daemon can say which site is
     * waiting and the user can go and read it, which is the difference
     * between a machine that is quietly idle and one that says why.
     *
     * Not `revoked`, which is a human ending a relationship, and not
     * `paused`, which on the request side already means "this daemon's
     * operator stopped it" — one word with two subjects on two halves of one
     * exchange is a confusion nobody untangles from a log.
     */
    awaitingConsent: z.array(z.string().min(1)),
    /**
     * Who this owner's devices may serve `team` work for — Amendment G.
     *
     * Carried by the relay and authored by nobody it can reach. The daemon
     * verifies it against the key pinned at pairing and admits from its own
     * held copy, so this field is delivery and not instruction: withholding
     * it narrows a device, and editing it is caught.
     *
     * Optional because a roster is a cloud-mode fact — direct mode has no
     * control plane to author one — and because a daemon that has never
     * received one must narrow rather than fail. Absent is not "admit
     * nobody"; {@link ROSTER_MAX_AGE_MS} is what makes absence bite, and it
     * bites the same way for a roster withheld as for one never sent.
     */
    roster: SignedRoster.optional(),
  })
  .strict();
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

// ---------------------------------------------------------------------------
// 4. POST /byollm/result
// ---------------------------------------------------------------------------

/**
 * What an intermediary learns about how a job ended — byollm_009 §6.
 *
 * The discriminator and nothing else. A relay has to know a job reached a
 * terminal state, and whether it failed, because that decides whether the job
 * leaves the queue or the app may re-enqueue. It does not have to know what
 * the model said, or what an error said, and this is where that line is drawn.
 *
 * Kept identical to `JobOutcome`'s discriminator rather than coarsened to
 * ok/not-ok: a cancelled job and a failed one are different routing outcomes,
 * and collapsing them would make the relay guess.
 */
export const ResultDisposition = z.enum(["ok", "error", "canceled"]);
export type ResultDisposition = z.infer<typeof ResultDisposition>;

export const ResultRequest = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    runnerId: z.string().min(1),
    jobId: z.string().min(1),
    /**
     * The grant this result was produced under — cloud_008 §1.4a.
     *
     * `fetch` has always named its lease, with the reasoning written beside
     * it: a request that names only the job would be answerable for whatever
     * lease exists when it arrives. **The operation that writes the result did
     * not**, on either plane, and checked only the runner id — which survives
     * a claim-release-reclaim cycle, so a device whose grant had been swept
     * and reissued could still land a result for a job it no longer held.
     *
     * Found by tracing a mutation that survived in §0.6: the lease lapsed, the
     * sweep requeued, the daemon re-claimed under a new grant, and the
     * original run finished and posted anyway. The relay marked the job done
     * with a result the site cannot open — it verifies the envelope against
     * the *current* holder's device, so the crypto contains the substitution —
     * and then refused the real holder's result as a replay. A lost job, in
     * silence.
     *
     * `LEASE_HONORED` is a statement about a lease *instance*. That was
     * learned once already, when a replayed release yanked a later grant, and
     * it applies here for the same reason.
     */
    leaseId: z.string().min(1),
    /**
     * The outcome, sealed to the site and signed by the device.
     *
     * The return leg of the payload envelope, and sealed for the same reason:
     * a model's answer is as sensitive as the prompt that produced it, and an
     * intermediary that cannot read one must not be handed the other.
     */
    envelope: SealedEnvelope,
    /**
     * The sealed outcome's discriminator, in the clear.
     *
     * Checked against the envelope once opened. It is a routing hint, not a
     * fact: believing it unverified would let a daemon mark a job `ok` while
     * sealing an error, and only the app would ever find out.
     */
    disposition: ResultDisposition,
    // `model`, `backendClass` and `durationMs` are **inside the envelope** —
    // cloud_008 §2.5. See {@link RunMetadata}.
    //
    // They were here, in the clear, and that was two problems wearing one
    // coat. On the direct plane the site recorded unauthenticated fields
    // beside an authenticated answer: a daemon could seal one result and
    // declare a different model, and only the unsigned half would reach the
    // app. Through a relay they reached a third party that acts on none of
    // them — `model` in particular being the sort of detail Amendment A's
    // rule keeps off the wire.
    //
    // `disposition` stays, and the difference is the test: a relay *routes*
    // on it, so it is a class a routing party consumes. Nobody between the
    // two ends consumes these.
  })
  .strict();
export type ResultRequest = z.infer<typeof ResultRequest>;

export const ResultResponse = z
  .object({
    /**
     * False when this submission wrote nothing — the daemon should discard,
     * not retry ({@link MUSTS.RESULT_IDEMPOTENT}).
     */
    accepted: z.boolean(),
    /**
     * True when this device had already recorded this job's result.
     *
     * The difference between "already recorded" and "you no longer hold this"
     * — cloud_008 §3.6. A daemon whose acknowledgment was lost is in the first
     * case and needs to hear it: its answer is safely on disk. Reporting a
     * stale lease instead invents a worry about a result that is already
     * stored, and sends its owner looking for a routing problem.
     *
     * Set only for the device that finished the job. A different device gets
     * the same refusal it would get for a job that is *not* terminal, so a job
     * id cannot be used as a terminality probe.
     */
    duplicate: z.boolean().optional(),
    /** The job's state after this submission. */
    state: z.string().min(1),
  })
  .strict();
export type ResultResponse = z.infer<typeof ResultResponse>;

// ---------------------------------------------------------------------------
// 5. POST /byollm/release
// ---------------------------------------------------------------------------

export const ReleaseRequest = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    runnerId: z.string().min(1),
    /**
     * Which leases to release — the grant, not just the job.
     *
     * A release naming only a job id releases whatever lease exists at the
     * moment it arrives, which for a replayed request is not the lease the
     * daemon meant. See {@link Lease.id}.
     */
    leases: z.array(
      z.object({ jobId: z.string().min(1), leaseId: z.string().min(1) }),
    ),
    /**
     * Why, so the app's runner list can say something true.
     *
     * `refused` is load-bearing, not cosmetic: the server cannot evaluate a
     * daemon's *local* `named` allowlist (§4.2), so it may legitimately offer
     * a job this daemon then declines. The server MUST record the refusal and
     * stop offering that job to that runner, or the pair would spin between
     * claim and release forever.
     */
    reason: z.enum(["shutdown", "pause", "revoked", "backend-down", "refused"]),
  })
  .strict();
export type ReleaseRequest = z.infer<typeof ReleaseRequest>;

export const ReleaseResponse = z
  .object({
    released: z.array(z.string().min(1)),
  })
  .strict();
export type ReleaseResponse = z.infer<typeof ReleaseResponse>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Wire error codes.
 *
 * byollm_002 requires that "server unreachable", "revoked", "no matching
 * work" and "backend down" never share a message. Distinct codes here are how
 * the daemon can tell three of those apart; the fourth is a transport failure
 * with no response at all.
 */
export const WireErrorCode = z.enum([
  "bad-request",
  "unsupported-protocol-version",
  // "We do not know who you are." Exactly 401, and only that — cloud_008
  // §1.4d.
  "unauthorized",
  /**
   * "We know exactly who you are, and the answer is no." Exactly 403.
   *
   * Five refusals across both planes served 403 with `unauthorized`, whose
   * table entry is 401: a revoked device, a site claiming another site's
   * stub, a job you do not hold, a device belonging to another owner, a
   * relay that does not route for you. Every one of them is an *identified*
   * caller being refused.
   *
   * Collapsing the two loses a distinction that matters everywhere it is
   * read: a revoked daemon would look like an unsigned one in every log and
   * every client branch, and "check your keys" is the wrong advice for both
   * of them in opposite directions.
   */
  "forbidden",
  "revoked",
  "not-found",
  // Claimed, but the site has not sealed the payload yet — cloud_008 §1.4.
  //
  // A daemon must retry rather than abandon: the job is legitimately still
  // its own until the lease or the awaiting-payload clock says otherwise.
  // That is why it cannot be `not-found` or `server-error`, and why it was
  // the protocol gap that produced a bare 409 in the first place.
  "not-ready",
  /**
   * The job is over, and this call is about a job — V1-6, and the code the
   * site plane has been serving without one (V1-13).
   *
   * Distinct from `not-found`, which says "no such job", and from
   * `not-ready`, which says "not yet, keep asking". This one says "yes, and
   * it finished" — so a daemon must stop rather than retry, and a replayed
   * request must not be able to reopen it.
   */
  "too-late",
  // The caller's clock is too far from ours to judge a signature's freshness.
  //
  // Split out from `unauthorized` because the remedy is completely different
  // and only the server can tell them apart: a bad signature means the key is
  // wrong, this means the machine's time is wrong. A daemon reporting it as a
  // generic rejection sends its owner looking at their network.
  "clock-skew",
  "rate-limited",
  "server-error",
]);
export type WireErrorCode = z.infer<typeof WireErrorCode>;

export const WireError = z
  .object({
    error: WireErrorCode,
    message: z.string().min(1),
    /**
     * What this server speaks, on `unsupported-protocol-version` — §B.4.
     *
     * The refusal has carried these since the version handshake existed and
     * the enumeration did not model them, so the one error that exists to be
     * *acted on* was the one that failed to parse as a wire error. Found by
     * the relay's own suite the day the relay started sending it: a refusal
     * outside the enumerated shape is a refusal a client cannot branch on,
     * which is the whole reason §1.4 enumerates them.
     *
     * Modelled the way `clock-skew`'s two fields already are — code-specific
     * extras, refused on any other code by the refinement below.
     */
    supported: z.array(z.string().min(1)).optional(),
    minimum: z.string().min(1).optional(),
    /** Seconds; mirrors Retry-After for `rate-limited` and `server-error`. */
    retryAfter: z.number().int().nonnegative().optional(),
    /**
     * The server's clock, and the window it allows. `clock-skew` only.
     *
     * So the far side can say *how far off* rather than *that something is
     * wrong* — the difference between "adjust your clock by four minutes" and
     * "something is wrong with your connection". Not a disclosure: the
     * heartbeat response returns the same value, and so does every `Date`
     * header.
     */
    serverTime: z.number().int().positive().optional(),
    maxSkewMs: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((error, ctx) => {
    // Present exactly when they mean something. Optional fields that *may*
    // appear anywhere are a third state — the same shape `audience` is being
    // held to in §1.2 — and a daemon reading `serverTime` off an
    // `unauthorized` would be reading a number nobody promised.
    const skew = error.error === "clock-skew";
    const carried =
      error.serverTime !== undefined || error.maxSkewMs !== undefined;
    if (skew && !carried) {
      ctx.addIssue({
        code: "custom",
        message: "clock-skew must carry serverTime and maxSkewMs",
      });
    }
    if (!skew && carried) {
      ctx.addIssue({
        code: "custom",
        message: `${error.error} must not carry serverTime or maxSkewMs`,
      });
    }
    // The same rule for the version fields — §B.4. A code-specific extra on
    // the wrong code is how an enumeration stops meaning anything: every
    // reader has to guess whether the field applies.
    const version = error.error === "unsupported-protocol-version";
    const versionFields =
      error.supported !== undefined || error.minimum !== undefined;
    if (version && !versionFields) {
      ctx.addIssue({
        code: "custom",
        message:
          "unsupported-protocol-version must carry supported and minimum",
      });
    }
    if (!version && versionFields) {
      ctx.addIssue({
        code: "custom",
        message: `${error.error} must not carry supported or minimum`,
      });
    }
  });
export type WireError = z.infer<typeof WireError>;

/** HTTP status each error code is served with. */
export const ERROR_STATUS: Readonly<Record<WireErrorCode, number>> =
  Object.freeze({
    "bad-request": 400,
    "unsupported-protocol-version": 400,
    unauthorized: 401,
    forbidden: 403,
    revoked: 403,
    "not-found": 404,
    // 409, not 404: the job exists and is yours, it is simply not ready.
    "not-ready": 409,
    // The same 409 as `not-ready` and the opposite instruction: that one says
    // keep asking, this one says stop. The status is the class of the
    // problem — a request that does not fit the resource's state — and the
    // code is what a caller acts on.
    "too-late": 409,
    // 401 alongside `unauthorized`, because that is what it is — the
    // signature could not be judged. The code is what carries the remedy.
    "clock-skew": 401,
    "rate-limited": 429,
    "server-error": 500,
  });

// ---------------------------------------------------------------------------
// 3. POST /byollm/fetch — collect the payload for a lease you hold
// ---------------------------------------------------------------------------

export const FetchRequest = z
  .object({
    // `literal`, like every other request — V1-17. This one said
    // `string().min(1)`, so a daemon speaking a version this server does not
    // know got past the handshake on the one endpoint that hands over a
    // sealed payload. The version check exists so that a mismatch is a named
    // refusal rather than a schema failure three fields later; here it was
    // neither.
    protocolVersion: z.literal(PROTOCOL_VERSION),
    runnerId: z.string().min(1),
    jobId: z.string().min(1),
    /**
     * The grant this daemon holds.
     *
     * Named, not inferred: a fetch is lease-scoped, and a request that names
     * only the job would be answerable for whatever lease exists when it
     * arrives ({@link Lease.id}).
     */
    leaseId: z.string().min(1),
  })
  .strict();
export type FetchRequest = z.infer<typeof FetchRequest>;

export const FetchResponse = z
  .object({
    /**
     * The work, sealed to the device that claimed it — byollm_009 §6.
     *
     * Not plaintext. The site opens its own at-rest envelope and re-seals to
     * the claiming device's key, signed by the site's identity, so the work
     * is readable only by the machine that took it and only if it came from
     * the site that machine pinned.
     */
    envelope: SealedEnvelope,
  })
  .strict();
export type FetchResponse = z.infer<typeof FetchResponse>;
