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
 * - `operator` — a claim about how someone runs a deployment, verifiable only
 *   by audit or by reading source. The honest category, and the one that
 *   exists so a property nobody can check from outside is *labelled* as such
 *   rather than laundered by association with the checkable ones.
 */
export type MustVerification =
  "conformance" | "adversarial" | "construction" | "operator";

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
  readonly verifiedBy: MustVerification;
  /** Spec section this was adjudicated in. */
  readonly source: string;
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
      "A subscription-class backend's offer scope MUST be 'self' and MUST NOT " +
      "be widened by configuration.",
    enforcedBy: "daemon",
    verifiedBy: "conformance",
    source: "byollm_001 §The audience model",
  }),
  METERED_DEFAULTS_SELF: must({
    id: "METERED_DEFAULTS_SELF",
    statement:
      "A metered backend's effective offer scope MUST be 'self' unless the " +
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
      "A 'named' job MUST be admitted only by the daemon's own local " +
      "(server origin, user id) allowlist — never on the server's assertion " +
      "alone.",
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
  RESULT_PROVENANCE: must({
    id: "RESULT_PROVENANCE",
    statement:
      "A result from a non-'self' job MUST carry its provenance (audience and " +
      "runner) to the delivery seam so an app never treats volunteer output " +
      "as first-party.",
    enforcedBy: "server",
    verifiedBy: "conformance",
    source: "byollm_003 Rev 1 §Return-trip",
  }),

  // ---- The trust surface -------------------------------------------------
  INGRESS_LOGGED_BEFORE_EXECUTION: must({
    id: "INGRESS_LOGGED_BEFORE_EXECUTION",
    statement:
      "Every executed prompt MUST be appended to the local ingress log before " +
      "execution begins.",
    enforcedBy: "daemon",
    verifiedBy: "conformance",
    source: "byollm_001 §MUSTs",
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
  NO_PAYLOAD_ROUTING: must({
    id: "NO_PAYLOAD_ROUTING",
    statement:
      "Model, backend, base URL, and flags MUST come from owner config only; " +
      "a payload MUST NOT influence any of them.",
    enforcedBy: "daemon",
    verifiedBy: "adversarial",
    source: "byollm_004 §2",
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
} as const satisfies Record<string, Must>);

/** The id of any normative MUST. */
export type MustId = keyof typeof MUSTS;

/** All MUST ids, for coverage checks. */
export const MUST_IDS = Object.freeze(Object.keys(MUSTS) as MustId[]);

/** Every MUST verified a particular way. */
export function mustsVerifiedBy(kind: MustVerification): MustId[] {
  return MUST_IDS.filter((id) => MUSTS[id].verifiedBy === kind);
}
