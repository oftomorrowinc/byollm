/**
 * The normative MUSTs of protocol v0, as data.
 *
 * byollm_001 requires that "every MUST above has a conformance test id
 * referenced inline". Keeping the MUSTs as a frozen registry rather than
 * prose is what makes that requirement *checkable*: the conformance kit
 * imports {@link MUSTS} and fails if any id has no test asserting it, so a
 * new MUST cannot be added without a test and a test cannot silently drift
 * away from the statement it claims to prove.
 *
 * Ids are stable and public — third-party servers cite them in their
 * certification output.
 */

/** Which side of the wire is obliged to enforce a given MUST. */
export type MustEnforcer = "daemon" | "server" | "both";

/**
 * How a MUST is actually verified — which is not the same question as who
 * enforces it, and is the one that decides what "byollm-compatible" means.
 *
 * The conformance kit's credibility rests on an implicit claim that every
 * MUST is checkable. Ten of them were not, and the kit reported that honestly
 * while nothing acted on it. Making the kind explicit turns "uncovered" from
 * a number needing a paragraph of explanation into a number that should be
 * zero.
 *
 * - `conformance` — the kit asserts it against *any* implementation. This is
 *   the strong kind: a third party runs the suite and learns something.
 * - `adversarial` — proved by the reference daemon's own suites in this repo
 *   (the hostile-payload corpus, or its unit tests). Real verification, and
 *   it runs in CI — but it proves things about *our* daemon, not about
 *   someone else's, so the kit cannot carry it.
 * - `construction` — true by the shape of the code, where a test could only
 *   sample. A reviewer verifies it; a suite cannot.
 * ## When a MUST binds both sides — cloud_008 Tier 3
 *
 * `AUDIENCE_BOTH_SIDES` says the server and the daemon each enforce. The kit
 * passed **entirely** with the server's half deleted: every check drove a real
 * daemon, and a daemon refuses locally, so "the job did not run" looked
 * identical whichever side refused it. A full-honest-stack test proves only
 * the conjunction.
 *
 * So a `both`-enforced MUST needs **one check per party, each with the honest
 * counterpart removed** — C032 claims over the raw protocol precisely so no
 * daemon admission logic runs. Where a check strips one side, its comment
 * says which; where a MUST is enforced by both and only one side is checked,
 * that is a gap rather than coverage.
 *
 * - `operator` — a claim about how someone runs a deployment, verifiable only
 *   by audit or by reading source. The honest category, and the one that
 *   exists so a property nobody can check from outside is *labelled* as such
 *   rather than laundered by association with the checkable ones.
 * - `pending` — adjudicated and not yet verified by anything, because what
 *   would verify it is not built. Its {@link Must.planned} record says how it
 *   will be verified and by which assigned check ids. The honest kind for a
 *   MUST registered ahead of its feature, as byollm_012 §12 and byollm_021
 *   §10's are (#6933, card 1): calling those `conformance` would fail the
 *   kit's coverage count until the checks exist, and calling them
 *   `construction` would certify a property by the absence of the code that
 *   could break it.
 *
 *   It is held to two things, so it cannot become a resting place. A check
 *   that claims a `pending` MUST is a miscovered check (the kit's
 *   `miscoveredMusts`), so the card that builds the check has to promote the
 *   MUST in the same commit; so is a daemon test that cites one. And
 *   `scripts/pending-musts-hold-the-cut.mjs` refuses to tag any release
 *   while an image MUST is `pending`, and a stable one while any MUST is.
 */
export type MustVerification =
  "conformance" | "adversarial" | "construction" | "operator" | "pending";

/**
 * How a MUST is verified — one kind, or several.
 *
 * Several is not hedging. `SITES_LOCALLY_APPROVED` is the case that forced it:
 * the fence is **construction** — a daemon cannot serve a site that is not in
 * its map, and admission refuses before a payload is fetched — while the
 * property that a *removed and re-offered* id is still refused needs a hostile
 * sequence of heartbeats no honest client would send, which is
 * **adversarial**. Recording one and dropping the other would either overstate
 * what a type check proves or understate what the suites do.
 *
 * The alternative was a second field for the second kind, which is two answers
 * to one question — the shape this project keeps deleting.
 */
export type MustVerifiedBy =
  MustVerification | readonly [MustVerification, ...MustVerification[]];

/** The kinds a MUST claims, always as a list. */
export function kindsOf(must: {
  readonly verifiedBy: MustVerifiedBy;
}): readonly MustVerification[] {
  return typeof must.verifiedBy === "string"
    ? [must.verifiedBy]
    : must.verifiedBy;
}

/** A single normative requirement of the protocol. */
export interface Must {
  /** Stable public id, cited by conformance output. */
  readonly id: string;
  /** The requirement, in MUST language. */
  readonly statement: string;
  /** Which implementation is obliged to enforce it. */
  readonly enforcedBy: MustEnforcer;
  /**
   * How this is verified. `conformance` is the only kind the kit can assert;
   * see {@link MustVerification} for why the others exist.
   */
  readonly verifiedBy: MustVerifiedBy;
  /** Spec section this was adjudicated in. */
  readonly source: string;
  /**
   * Checks assigned to this MUST and not yet built, with the kinds they will
   * verify it as — byollm_012 §12, byollm_021 §10.
   *
   * Required on a `pending` MUST, which has no other account of how it will
   * ever be verified. Allowed on any other, for a clause added to a verified
   * MUST ahead of its check (`INGRESS_LOGGED_BEFORE_EXECUTION`'s tool-call
   * clause). An id here is one the kit does not have yet; the kit's suite
   * fails once it does, so the record is removed with the check that
   * replaces it.
   */
  readonly planned?: {
    readonly verifiedBy: MustVerifiedBy;
    readonly checks: readonly string[];
  };
}

const must = (m: Must): Must => Object.freeze(m);

/**
 * Every normative MUST in protocol v0.
 *
 * @remarks
 * Grouped by concern for readability; the conformance kit treats this as a
 * flat set. Adding an entry here without a corresponding conformance test is
 * a CI failure, by design.
 */
export const MUSTS = Object.freeze({
  // ---- Pairing and identity -------------------------------------------
  PAIR_ONE_USER: must({
    id: "PAIR_ONE_USER",
    statement:
      "A runner token MUST be bound to exactly one user; a daemon MUST refuse " +
      "work not attributable to its paired user.",
    enforcedBy: "both",
    verifiedBy: "conformance",
    source: "byollm_001 §MUSTs",
  }),
  PAIR_INTERACTIVE: must({
    id: "PAIR_INTERACTIVE",
    statement:
      "Pairing MUST be interactive (device-code approval in the app's own " +
      "session); a long-lived pasted secret MUST NOT be accepted as pairing.",
    enforcedBy: "server",
    verifiedBy: "conformance",
    source: "byollm_001 §Endpoints.1",
  }),
  PAIR_CODE_EXPIRES: must({
    id: "PAIR_CODE_EXPIRES",
    statement:
      "An unapproved device code MUST expire and MUST NOT be redeemable after " +
      "expiry.",
    enforcedBy: "server",
    verifiedBy: "conformance",
    source: "byollm_001 §Endpoints.1",
  }),

  // ---- Typed job kinds --------------------------------------------------
  VERSION_HANDSHAKE_REQUIRED: must({
    id: "VERSION_HANDSHAKE_REQUIRED",
    statement:
      "Every protocol request MUST declare a protocol version, and a server " +
      "MUST refuse an absent or unsupported one with a structured error " +
      "naming what it supports — never a generic parse failure.",
    enforcedBy: "both",
    verifiedBy: "conformance",
    source: "byollm_009 §4",
  }),
  SITE_KEY_BY_STUB: must({
    id: "SITE_KEY_BY_STUB",
    statement:
      "A daemon MUST verify a job's payload against the pinned key of the " +
      "site the stub names, and MUST refuse a job naming a site it has not " +
      "pinned. It MUST NOT fall back to another pinned key, and MUST refuse " +
      "an envelope whose declared sender disagrees with the stub's site.",
    enforcedBy: "daemon",
    // Adversarial, and the reason is the finding that produced it: the
    // honest paths pass with every site check deleted, because `open`
    // refuses a signature from the wrong key anyway. What distinguishes an
    // enforced rule from a coincidence here is a hostile pairing of stub and
    // envelope, which no conformance client would ever send.
    verifiedBy: "adversarial",
    source: "byollm_009 §A.3",
  }),
  SITES_LOCALLY_APPROVED: must({
    id: "SITES_LOCALLY_APPROVED",
    statement:
      "A daemon MUST NOT run work for a site on an upstream's word alone. " +
      "An upstream may propose a site set; work for any site in it MUST " +
      "additionally carry a grant signed by the control-plane key this " +
      "daemon pinned at pairing. A key that has changed for an id this " +
      "daemon already pinned MUST be refused for the life of the pairing, " +
      "including after that id has left the set and returned. A **verified " +
      "succession** is not a changed key: a new key id carrying a signature, " +
      "by a key this daemon has already pinned, over a statement naming both " +
      "key ids MUST be accepted — provided the control plane projects the " +
      "same successor — and MUST be announced rather than applied silently. " +
      "The first job from a site this daemon has never served MUST be " +
      "announced at the machine.",
    enforcedBy: "daemon",
    // Two kinds, and the second is the one that matters — V1-1.
    //
    // `construction`: the daemon cannot serve a site that is not in its
    // pinned map, and admission refuses before a payload is fetched — and
    // since byollm_016 Amendment K, being in the map is no longer sufficient
    // either: a signed grant is, and the relay proposing the set cannot
    // produce one.
    //
    // `adversarial`: the property that survives is about a *sequence* —
    // remove the id, re-offer it under a different key — which no honest
    // upstream sends and which the fence above does not see. That was the
    // bypass: the pin was deleted with the id, so the comparison had nothing
    // to compare against and the substitution arrived as a stranger.
    // **Not `conformance`, and that is a live gap rather than a judgement.**
    // Amendment C's succession clause is a rule about two implementations
    // agreeing, which is what a conformance check is for — but rotating a
    // site's key is not something `ConformanceTarget` can express, and adding
    // an optional hook that most targets omit would produce a check reporting
    // success for a reason unrelated to the property it claims. That is this
    // project's most-repeated bug, and it is not worth reintroducing for a
    // stronger-sounding word in a table. The rotation path is verified by
    // `site-rotation.test.ts` (both directions, against the shipped runner)
    // and `relay/test/rotation.test.ts` (both planes, against the reference
    // relay); the missing piece is a second *independent* implementation to
    // check them against, and there is not one yet.
    verifiedBy: ["construction", "adversarial"],
    source: "byollm_009 §B.2, Amendment C",
  }),
  KEYS_EXCHANGED_AT_CONSENT: must({
    id: "KEYS_EXCHANGED_AT_CONSENT",
    statement:
      "Pairing MUST exchange both parties' public identities; each side MUST " +
      "verify that the encryption key is signed by the identity presenting " +
      "it, and MUST pin the identity. Keys MUST NOT be delivered before " +
      "approval.",
    enforcedBy: "both",
    verifiedBy: "conformance",
    source: "byollm_009 §5",
  }),
  REQUESTS_SIGNED_NOT_BEARER: must({
    id: "REQUESTS_SIGNED_NOT_BEARER",
    statement:
      "Every authenticated request MUST be signed by the calling device's " +
      "pinned identity key, over the endpoint, the runner id, a timestamp " +
      "and the exact request body. A server MUST NOT accept a bearer " +
      "credential in place of a signature.",
    enforcedBy: "both",
    verifiedBy: "conformance",
    source: "byollm_009 §4.2",
  }),
  LEASE_SCOPED_BY_GRANT: must({
    id: "LEASE_SCOPED_BY_GRANT",
    statement:
      "A lease-scoped request MUST name the lease it acts on, and a server " +
      "MUST apply it only to that lease. Naming the job and the runner is " +
      "not sufficient: both survive a claim-release-reclaim cycle.",
    enforcedBy: "both",
    verifiedBy: "conformance",
    source: "byollm_009 §4.2",
  }),
  STUB_METADATA_EXHAUSTIVE: must({
    id: "STUB_METADATA_EXHAUSTIVE",
    statement:
      "A claim MUST answer with stubs carrying exactly the enumerated " +
      "fields and no payload. An endpoint MUST NOT emit a stub carrying " +
      "others, and an upstream MUST NOT require any.",
    enforcedBy: "both",
    verifiedBy: "conformance",
    source: "byollm_009 §6",
  }),
  ENVELOPE_SEALED_AND_SIGNED: must({
    id: "ENVELOPE_SEALED_AND_SIGNED",
    statement:
      "A stored payload MUST be sealed, and MUST be signed by the sender's " +
      "identity key. An endpoint MUST refuse an envelope whose signature " +
      "does not verify against the identity it pinned.",
    enforcedBy: "server",
    verifiedBy: "conformance",
    source: "byollm_009 §6",
  }),
  KIND_TYPED_ONLY: must({
    id: "KIND_TYPED_ONLY",
    statement:
      "Job kinds MUST resolve against handlers baked into the daemon. A daemon " +
      "MUST refuse an unknown kind rather than guess.",
    enforcedBy: "daemon",
    verifiedBy: "conformance",
    source: "byollm_001 §Jobs are typed data",
  }),
  KIND_NO_CODE: must({
    id: "KIND_NO_CODE",
    statement:
      "A server MUST NOT be able to convey code, a shell string, or a path to " +
      "execute; payloads are data handed to a model only.",
    enforcedBy: "daemon",
    verifiedBy: "conformance",
    source: "byollm_001 §Jobs are typed data; byollm_004 §1",
  }),

  // ---- Capability and claiming -----------------------------------------
  CLAIM_REQUIRES_CAPABILITY: must({
    id: "CLAIM_REQUIRES_CAPABILITY",
    statement:
      "A daemon MUST NOT be given a job whose kind is absent from its " +
      "advertised capability matrix.",
    enforcedBy: "both",
    verifiedBy: "conformance",
    source: "byollm_001 §MUSTs",
  }),
  CAPABILITY_IS_DETECTED: must({
    id: "CAPABILITY_IS_DETECTED",
    statement:
      "An advertised capability matrix MUST be the intersection of owner " +
      "config and detected, healthy reality — never config alone.",
    enforcedBy: "daemon",
    verifiedBy: "conformance",
    source: "byollm_002 §Routing",
  }),
  CLAIM_ATOMIC: must({
    id: "CLAIM_ATOMIC",
    statement:
      "Claiming MUST be atomic: a job MUST NOT be handed to two runners " +
      "concurrently.",
    enforcedBy: "server",
    verifiedBy: "conformance",
    source: "byollm_001 §Endpoints.2",
  }),

  // ---- Leases -----------------------------------------------------------
  LEASE_HONORED: must({
    id: "LEASE_HONORED",
    statement:
      "A daemon MUST stop work on a job whose lease it has failed to renew, " +
      "and MUST NOT report a result for an expired lease it no longer holds.",
    enforcedBy: "daemon",
    verifiedBy: "conformance",
    source: "byollm_001 §MUSTs",
  }),
  LEASE_RECLAIMABLE: must({
    id: "LEASE_RECLAIMABLE",
    statement:
      "A lease that expires un-renewed MUST make its job claimable again with " +
      "no loss of the job.",
    enforcedBy: "server",
    verifiedBy: "conformance",
    source: "byollm_001 §Endpoints.2",
  }),

  // ---- Audience and offer scope ----------------------------------------
  AUDIENCE_BOTH_SIDES: must({
    id: "AUDIENCE_BOTH_SIDES",
    statement:
      "A job MUST run on a daemon only if the daemon's offer scope admits the " +
      "job's owner AND the job's audience admits the daemon's owner.",
    enforcedBy: "both",
    verifiedBy: "conformance",
    source: "byollm_001 §The audience model",
  }),
  SUBSCRIPTION_SELF_LOCK: must({
    id: "SUBSCRIPTION_SELF_LOCK",
    statement:
      "A subscription-class backend's offer scope MUST be 'private' and MUST NOT " +
      "be widened by configuration.",
    enforcedBy: "daemon",
    verifiedBy: "conformance",
    source: "byollm_001 §The audience model",
  }),
  METERED_DEFAULTS_SELF: must({
    id: "METERED_DEFAULTS_SELF",
    statement:
      "A metered backend's effective offer scope MUST be 'private' unless the " +
      "owner has explicitly acknowledged spending money on others' work.",
    enforcedBy: "daemon",
    verifiedBy: "conformance",
    source: "byollm_007 §4",
  }),
  METERED_REQUIRES_CEILING: must({
    id: "METERED_REQUIRES_CEILING",
    statement:
      "A widened metered backend MUST carry a spend ceiling, and the daemon " +
      "MUST refuse community work once it is reached.",
    enforcedBy: "daemon",
    verifiedBy: "conformance",
    source: "byollm_007 §4",
  }),
  COST_NOT_CONFIGURABLE: must({
    id: "COST_NOT_CONFIGURABLE",
    statement:
      "A built-in provider's cost class MUST NOT be overridable by " +
      "configuration.",
    enforcedBy: "daemon",
    verifiedBy: "conformance",
    source: "byollm_007 §2",
  }),
  REMOTE_IS_NEVER_FREE: must({
    id: "REMOTE_IS_NEVER_FREE",
    statement:
      "A generic HTTP backend whose base URL is not loopback or private MUST " +
      "be treated as metered.",
    enforcedBy: "daemon",
    verifiedBy: "conformance",
    source: "byollm_007 §2",
  }),

  NAMED_LOCAL_ALLOWLIST: must({
    id: "NAMED_LOCAL_ALLOWLIST",
    statement:
      "A 'team' job MUST be admitted only by something the device itself " +
      "verified, keyed by (server origin, user id) — never on the routing " +
      "party's assertion alone.",
    enforcedBy: "daemon",
    verifiedBy: "conformance",
    source: "byollm_001 Rev 1 §B",
  }),

  REFUSAL_NOT_REOFFERED: must({
    id: "REFUSAL_NOT_REOFFERED",
    statement:
      "A server MUST NOT re-offer a job to a runner that released it with " +
      "reason 'refused'.",
    enforcedBy: "server",
    verifiedBy: "conformance",
    source: "byollm_001 Rev 1 §B (loop resolved in build review)",
  }),

  // ---- Revocation and cancel -------------------------------------------
  REVOCATION_HONORED: must({
    id: "REVOCATION_HONORED",
    statement:
      "A revoked daemon MUST stop claiming and MUST abandon in-flight work by " +
      "the next heartbeat at the latest.",
    enforcedBy: "daemon",
    verifiedBy: "conformance",
    source: "byollm_001 §MUSTs",
  }),
  CANCEL_HONORED: must({
    id: "CANCEL_HONORED",
    statement:
      "A job id in a heartbeat response's cancel list MUST abort that job's " +
      "in-flight backend call and be reported as 'canceled'.",
    enforcedBy: "daemon",
    verifiedBy: "conformance",
    source: "byollm_001 Rev 1 §C",
  }),

  // ---- Lifecycle, dependencies, delivery -------------------------------
  DEPENDS_ON_GATING: must({
    id: "DEPENDS_ON_GATING",
    statement:
      "A job MUST NOT be claimable until every job in its dependsOn set has " +
      "reached the 'ok' state.",
    enforcedBy: "server",
    verifiedBy: "conformance",
    source: "byollm_001 Rev 1 §E",
  }),
  TTL_EXPIRY: must({
    id: "TTL_EXPIRY",
    statement:
      "An unclaimed job MUST become 'expired' once its TTL elapses, and the " +
      "TTL clock MUST start when the job becomes claimable, not at enqueue.",
    enforcedBy: "server",
    verifiedBy: "conformance",
    source: "byollm_001 Rev 1 §D (TTL clock resolved in build review)",
  }),
  NO_RUNNER_SIGNAL: must({
    id: "NO_RUNNER_SIGNAL",
    statement:
      "A server MUST surface noRunnerAvailable when no runner with matching " +
      "capability has heartbeated within the liveness window, and MUST NOT " +
      "raise it for a job still blocked on dependencies.",
    enforcedBy: "server",
    verifiedBy: "conformance",
    source: "byollm_001 Rev 1 §D",
  }),
  RESULT_IDEMPOTENT: must({
    id: "RESULT_IDEMPOTENT",
    statement:
      "Result submission MUST be idempotent by job id; the first terminal " +
      "outcome wins and later submissions MUST NOT change it.",
    enforcedBy: "server",
    verifiedBy: "conformance",
    source: "byollm_001 §Endpoints.4",
  }),
  PROVENANCE_NAMES_DEVICE: must({
    id: "PROVENANCE_NAMES_DEVICE",
    statement:
      "A result MUST carry the claiming device's key id and its relationship " +
      "to the requester, to the delivery seam, so an app never treats " +
      "volunteer output as first-party. The key id MUST be the device the " +
      "upstream granted the lease to, and a result whose signature does not " +
      "verify against that device MUST be refused rather than recorded.",
    enforcedBy: "server",
    verifiedBy: "conformance",
    source: "byollm_009 §11",
  }),

  // ---- The trust surface -------------------------------------------------
  INGRESS_LOGGED_BEFORE_EXECUTION: must({
    id: "INGRESS_LOGGED_BEFORE_EXECUTION",
    statement:
      "Every executed prompt MUST be appended to the local ingress log before " +
      "execution begins, and every tool call MUST be appended to it before " +
      "it is sealed and sent.",
    enforcedBy: "daemon",
    // The prompt clause is what the kit checks (C015). The tool-call clause is
    // byollm_012 §9's amendment, held by C042 in the daemon's own suites
    // (`tools-at-the-site.test.ts`, #7055) — the kit cannot yet play the site
    // a call goes to, so that half is the daemon's suite's, and says so.
    verifiedBy: ["conformance", "adversarial"],
    source: "byollm_001 §MUSTs; byollm_012 §9",
  }),

  // ---- Execution isolation (byollm_004) ---------------------------------
  NO_SHELL_INTERPOLATION: must({
    id: "NO_SHELL_INTERPOLATION",
    statement:
      "Process-class backends MUST be invoked with a fixed argv array and the " +
      "payload delivered on stdin; payload text MUST NOT reach a command line.",
    enforcedBy: "daemon",
    verifiedBy: "adversarial",
    source: "byollm_004 §2",
  }),
  /**
   * Amended for byollm_016 Phase B, and the amendment is deliberately narrow.
   *
   * A site may now name a **service** on the stub. The temptation is to read
   * that as a crack in this law, so the statement below says exactly where the
   * line is: a name selects from a menu the owner published, and resolves to a
   * model, backend, base URL and flags **only** through that owner's own
   * config. The site supplies a key; the owner supplies every value it maps
   * to. A name the owner does not advertise is refused rather than
   * substituted, because substitution is how "you may pick from my list" turns
   * into "you may ask for anything and get something".
   *
   * Two properties keep it from drifting into "sites demand models":
   *
   *   1. **Nothing the site sends is ever a value.** No model string, no URL,
   *      no flag crosses the wire — only a key that means nothing off this
   *      owner's machine.
   *   2. **It is a stub field, never a payload field.** The prompt cannot
   *      reach it. That is unchanged and is the sentence the second clause
   *      below still enforces verbatim.
   */
  NO_PAYLOAD_ROUTING: must({
    id: "NO_PAYLOAD_ROUTING",
    statement:
      "Model, backend, base URL, and flags MUST come from owner config only; " +
      "a payload MUST NOT influence any of them. A stub MAY name a service " +
      "the owner advertises, which selects among that owner's own config " +
      "entries and MUST NOT introduce any value the owner did not write; an " +
      "unadvertised name MUST be refused, never substituted.",
    enforcedBy: "daemon",
    verifiedBy: "adversarial",
    source: "byollm_004 §2, amended byollm_016 §Phase B",
  }),
  STRIPPED_CHILD_ENV: must({
    id: "STRIPPED_CHILD_ENV",
    statement:
      "Process-class children MUST spawn with an allowlisted environment, a " +
      "scratch cwd, no inherited descriptors beyond std streams, and hard " +
      "timeout and output-size caps.",
    enforcedBy: "daemon",
    verifiedBy: "adversarial",
    source: "byollm_004 §2",
  }),
  HTTP_BASE_URL_SAFE: must({
    id: "HTTP_BASE_URL_SAFE",
    statement:
      "HTTP-class backends MUST send requests only to the owner-configured " +
      "base URL and MUST refuse base URLs resolving to cloud-metadata or " +
      "link-local addresses.",
    enforcedBy: "daemon",
    verifiedBy: "adversarial",
    source: "byollm_004 Rev 1 §Backend taxonomy",
  }),
  OUTPUT_INERT: must({
    id: "OUTPUT_INERT",
    statement:
      "Returned text MUST be treated as inert bytes: never evaluated, never " +
      "written to a payload-named path, never interpolated into a shell or " +
      "into terminal control sequences when logged.",
    enforcedBy: "daemon",
    verifiedBy: "adversarial",
    source: "byollm_004 §2",
  }),
  COMMUNITY_BUDGETS: must({
    id: "COMMUNITY_BUDGETS",
    statement:
      "Jobs whose owner is not the daemon's owner MUST be subject to the " +
      "owner's rate limits, daily cap, and resource budget.",
    enforcedBy: "daemon",
    verifiedBy: "adversarial",
    source: "byollm_004 §4",
  }),
  REVOCATION_IMMEDIATE: must({
    id: "REVOCATION_IMMEDIATE",
    statement:
      "Revocation MUST take effect at the upstream at once — a revoked " +
      "runner MUST NOT be granted further work from the moment the record " +
      "changes — and MUST reach the daemon by its next heartbeat.",
    // Both, and stated as one sentence with two obligations rather than
    // folded into REVOCATION_HONORED. That one binds the *daemon*: a revoked
    // daemon stops claiming and abandons in-flight work. This binds the
    // *upstream*. byollm_009 §5 is explicit that the pair is the point — "a
    // revocation enforced at one end survives a compromise of that end" — and
    // one entry covering both would make a compromised daemon look compliant.
    enforcedBy: "both",
    verifiedBy: "conformance",
    source: "byollm_009 §11",
  }),
  CONSENT_BEFORE_ROUTE: must({
    id: "CONSENT_BEFORE_ROUTE",
    statement:
      "An upstream MUST NOT route a job to a device without a record binding " +
      "that user, that site and that scope. There MUST be no discovery path " +
      "by which a device receives work it was never granted.",
    enforcedBy: "server",
    verifiedBy: "conformance",
    source: "byollm_009 §11",
  }),
  ROSTER_NOT_DISCLOSED: must({
    id: "ROSTER_NOT_DISCLOSED",
    statement:
      "A site MUST NOT learn the membership of a group whose compute it " +
      "uses, and MUST NOT publish membership to a routing party. No wire " +
      "message may carry a list of who may run a job.",
    // Checkable since cloud_008 §0.2 took `audienceAllow` off the stub: the
    // property now holds by *absence*, and absence is exactly what a strict
    // schema and a serialised stub can be asked about. Before that it was a
    // sentence — and one this project cited in code comments, tests and two
    // specs as though it were enforced data, which is why it is worth
    // stating precisely rather than generously.
    enforcedBy: "both",
    verifiedBy: "conformance",
    source: "byollm_009 §11",
  }),
  EFFECTIVE_OFFER_ONLY: must({
    id: "EFFECTIVE_OFFER_ONLY",
    statement:
      "A daemon MUST declare effective offers only. An upstream MUST NOT " +
      "receive raw config, allowlists, or capacity the owner has not shared, " +
      "and MUST act on the declared offer rather than on what was asked for.",
    enforcedBy: "both",
    verifiedBy: "conformance",
    source: "byollm_009 §11",
  }),
  FALLBACK_LABELED: must({
    id: "FALLBACK_LABELED",
    statement:
      "Work served by anything other than the user's own compute MUST be " +
      "labelled as such wherever it is reported, and MUST NOT be silently " +
      "substituted.",
    // `construction` today, and deliberately not `conformance`. Nothing on
    // the wire yet distinguishes a fallback from any other community job —
    // the ledger that would give it a surface is unbuilt — so a check would
    // have to assert something it cannot observe. Promoted the day that
    // surface exists. Marking it `conformance` now would put "verified"
    // beside a property no third party can see, which is the one thing the
    // kinds exist to prevent.
    enforcedBy: "both",
    verifiedBy: "construction",
    source: "byollm_009 §11",
  }),
  RELAY_BLIND: must({
    id: "RELAY_BLIND",
    statement:
      "A relay MUST NOT hold any key capable of decrypting a payload, a " +
      "result, or a delta frame.",
    // Operator: a third party can read the relay's types and see there is
    // nowhere to put such a key, but the kit certifies a *server* and cannot
    // reach inside somebody's deployment to prove what it holds.
    enforcedBy: "server",
    verifiedBy: "operator",
    source: "byollm_009 §11",
  }),
  SHARED_COMPUTE_DISCLOSED: must({
    id: "SHARED_COMPUTE_DISCLOSED",
    statement:
      "Before a user's work first runs on compute they do not own, they MUST " +
      "be told in plain language that the machine's owner can see it.",
    // Operator, and cloud_008 §0.3 is why the classification now comes with a
    // standing answer rather than a standing question. The screen is not
    // wire-observable, but the *string the server composes* is, and it is
    // now unit-tested with the two false sentences forbidden by name. The
    // kind stays `operator` because a third-party site can still render
    // whatever it likes; what changed is that the part inside our own
    // boundary stopped depending on somebody remembering to audit it.
    enforcedBy: "server",
    verifiedBy: "operator",
    source: "byollm_009 §11",
  }),

  // ---- Site-executed tools (byollm_012, #6933) --------------------------
  //
  // Registered `pending` by card 1 so cards 2-4 build against ids that exist,
  // and promoted by the card that builds each check. See
  // {@link MustVerification} for what holds `pending` to that.
  //
  // Card 3 (#7055) built the daemon's checks — C033–C038, C041, C042, C046 —
  // as the daemon's own suites, `adversarial`: the kit's target cannot yet
  // open a call sealed to its site or post a result as it (card 2, #7054,
  // serves the endpoints). What the other parties' checks still owe is
  // `planned`, and `pending-musts-hold-the-cut.mjs` refuses a stable cut
  // while a tool MUST has any.
  TOOLS_RUN_AT_SITE: must({
    id: "TOOLS_RUN_AT_SITE",
    statement:
      "A daemon MUST NOT execute a tool. A tool call MUST leave the device " +
      "only as an envelope signed by the device and sealed to the job's site.",
    enforcedBy: "daemon",
    verifiedBy: "adversarial",
    source: "byollm_012 §12",
  }),
  TOOLS_MATCH_CONSENT: must({
    id: "TOOLS_MATCH_CONSENT",
    statement:
      "On the cloud lane, an llm.tools payload whose declarations or limits " +
      "do not match the grant's toolsDigest, or whose maxToolCalls is above " +
      "the purpose's, MUST be refused before any backend sees it. An enqueue " +
      "whose toolsDigest does not match the manifest of record MUST be " +
      "refused at the hub with nothing queued. A call to an undeclared tool, " +
      "or with arguments that fail its schema, MUST be a tool error to the " +
      "model, and nothing MUST be sent.",
    enforcedBy: "both",
    // The device's half: C035 (the digest at admission) and C036 (undeclared
    // or ill-typed calls). The hub's half is C047, at enqueue.
    verifiedBy: "adversarial",
    source: "byollm_012 §12",
    planned: { verifiedBy: "conformance", checks: ["C047"] },
  }),
  TOOL_ENVELOPES_BOUND: must({
    id: "TOOL_ENVELOPES_BOUND",
    statement:
      "tool-call and tool-result MUST be directions inside the envelope " +
      "signature, and a tool result MUST be accepted only for an outstanding " +
      "call of the same job.",
    enforcedBy: "daemon",
    verifiedBy: "adversarial",
    source: "byollm_012 §12",
  }),
  TOOLS_BUDGETED: must({
    id: "TOOLS_BUDGETED",
    statement:
      "A job's tool-call ceiling MUST be enforced before the call that would " +
      "exceed it, by the daemon, the relay and the site SDK; and the context " +
      "cap MUST be counted in the job's size class before it runs and " +
      "enforced by the daemon before each result reaches the model.",
    enforcedBy: "both",
    // The daemon's counter and the context cap: C038, C041, C046. The relay's
    // counter is C039 and the site SDK's C040 — "three counters, on purpose"
    // (§8), and one checked is a gap, not coverage, until all three are.
    verifiedBy: "adversarial",
    source: "byollm_012 §12",
    planned: { verifiedBy: "conformance", checks: ["C039", "C040"] },
  }),

  // ---- Images by reference (byollm_021, #6933) --------------------------
  BLOBS_SEALED: must({
    id: "BLOBS_SEALED",
    statement:
      "Blob bytes MUST leave an endpoint only encrypted under a key that " +
      "travels only inside a sealed, signed envelope; a blob store and a " +
      "relay MUST NOT hold any key that opens one.",
    enforcedBy: "both",
    verifiedBy: "pending",
    source: "byollm_021 §10",
    planned: { verifiedBy: ["operator", "conformance"], checks: ["C048"] },
  }),
  BLOB_BOUND_TO_JOB: must({
    id: "BLOB_BOUND_TO_JOB",
    statement:
      "A blob that fails to decrypt under its job's associated data, or whose " +
      "plaintext hash does not match its reference, MUST be refused at both " +
      "endpoints.",
    enforcedBy: "both",
    verifiedBy: "pending",
    source: "byollm_021 §10",
    planned: { verifiedBy: "conformance", checks: ["C049"] },
  }),
  MEDIA_VERIFIED: must({
    id: "MEDIA_VERIFIED",
    statement:
      "An image's declared type MUST match its magic bytes and its " +
      "dimensions MUST be within the caps, checked at both endpoints before " +
      "a backend or an app sees the bytes.",
    enforcedBy: "both",
    verifiedBy: "pending",
    source: "byollm_021 §10",
    planned: { verifiedBy: ["conformance", "adversarial"], checks: ["C050"] },
  }),
  BLOB_BUDGET_BEFORE_DOWNLOAD: must({
    id: "BLOB_BUDGET_BEFORE_DOWNLOAD",
    statement:
      "A non-owner's images MUST be charged against community.maxImageBytes " +
      "from the declared sizes before any blob is fetched, and a download " +
      "MUST stop at its declared size. An upstream MUST NOT offer a job whose " +
      "stored blobs differ from the sizes their slots were issued for.",
    enforcedBy: "both",
    verifiedBy: "pending",
    source: "byollm_021 §10",
    planned: {
      verifiedBy: ["conformance", "operator"],
      checks: ["C051", "C052", "C057"],
    },
  }),
  BLOBS_GO_WITH_THE_JOB: must({
    id: "BLOBS_GO_WITH_THE_JOB",
    statement:
      "Input blobs MUST be deleted when the result is accepted; output blobs " +
      "when the site says it holds them, or one hour after collection; an " +
      "uncollected job's blobs 24 hours after its deadline.",
    enforcedBy: "server",
    verifiedBy: "pending",
    source: "byollm_021 §10",
    planned: {
      verifiedBy: ["conformance", "operator"],
      checks: ["C054", "C059"],
    },
  }),
  IMAGE_BYTES_NOT_URLS: must({
    id: "IMAGE_BYTES_NOT_URLS",
    statement:
      "A daemon MUST NOT fetch a URL a backend returned in place of image " +
      "bytes.",
    enforcedBy: "daemon",
    verifiedBy: "pending",
    source: "byollm_021 §10",
    planned: { verifiedBy: "adversarial", checks: ["C056"] },
  }),
} as const satisfies Record<string, Must>);

/**
 * Ids that were retired, and what took over.
 *
 * Ids are public — third-party certification output cites them — so one
 * cannot simply disappear. `RESULT_PROVENANCE` was not renamed: since
 * Amendment A a result's attribution is by *proof of possession* rather than
 * by a carried label, and `PROVENANCE_NAMES_DEVICE` says so. The old
 * statement is true of the new one and weaker, which is what "subsumed"
 * means here.
 */
export const RETIRED_MUSTS = Object.freeze({
  RESULT_PROVENANCE: {
    supersededBy: "PROVENANCE_NAMES_DEVICE",
    note:
      "Strengthened, not renamed: attribution is now by proof of possession " +
      "— the result's signature must verify against the device the upstream " +
      "granted the lease to — rather than by a provenance label travelling " +
      "beside it. byollm_009 §11 states the stronger form.",
  },
} as const satisfies Record<string, { supersededBy: string; note: string }>);

/** The id of any normative MUST. */
export type MustId = keyof typeof MUSTS;

/** All MUST ids, for coverage checks. */
export const MUST_IDS = Object.freeze(Object.keys(MUSTS) as MustId[]);

/** Every MUST verified a particular way. */
export function mustsVerifiedBy(kind: MustVerification): MustId[] {
  return MUST_IDS.filter((id) => kindsOf(MUSTS[id]).includes(kind));
}
