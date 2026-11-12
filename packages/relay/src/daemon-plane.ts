import {
  BlobSlotRequest,
  BlobSlotResponse,
  BlobUrlRequest,
  BlobUrlResponse,
  PairPollRequest,
  PairStartRequest,
  ClaimRequest,
  FetchRequest,
  HeartbeatRequest,
  MAX_ENVELOPE_BYTES,
  PROTOCOL_VERSION,
  TOOLS_SPENT_MESSAGE,
  ReleaseRequest,
  ResultRequest,
  RequestSignature,
  ToolCallRequest,
  ToolCallResponse,
  ToolResultsRequest,
  ToolResultsResponse,
  envelopeBytes,
  keyId,
  verifyRequest,
  verifyPublicIdentity,
  updateOfferFor,
  checkDaemonFloor,
  UPGRADE_COMMAND,
  PublicIdentity,
  ERROR_STATUS,
  isBlobObjectSize,
  type CapabilityMatrix,
  type ClaimedStub,
} from "@byollm/protocol";
import { z } from "zod";
import type { RelayBlobs } from "./blobs.js";
import type { Projection } from "./fixture.js";
import type { GrantDecision } from "./index.js";
import {
  PAIRING_BUSY_MESSAGE,
  PAIRING_CODE_TTL_MS,
  newDeviceCode,
  newUserCode,
  type PairingCodes,
  type PendingPairing,
} from "./pairing-codes.js";
import { tooLargeRefusal } from "./refusals.js";
import {
  RETRY_AFTER_MS,
  type HolderRefusal,
  type RoutedJob,
  type ToolCallRefusal,
} from "./state.js";
import { clockSkewRefusal } from "./refusals.js";
import type { RoutingStore } from "./store.js";

/**
 * The plane a daemon talks to — cloud_004 §2.
 *
 * To a daemon this is an upstream like any other: it claims, fetches, reports
 * and heartbeats exactly as it does against a direct site. That sameness is
 * the point of §9's "the hub is a deployment of the open parts" — hub mode is
 * not a second daemon code path, it is a second upstream.
 *
 * What differs is invisible from the daemon's side and total from ours: **this
 * upstream cannot seal.** A direct site answers `fetch` by opening its own
 * envelope and re-sealing to the claiming device. The relay has nothing to
 * open and nothing to seal with, so it answers `fetch` with whatever the site
 * left for that device, or with nothing yet.
 */

export interface PlaneResult {
  readonly status: number;
  readonly body: unknown;
}

const ok = (body: unknown): PlaneResult => ({ status: 200, body });

/**
 * A store refusal, in HTTP.
 *
 * The store says *why* in its own vocabulary and this decides what a daemon is
 * told, which keeps the two independent: a store that grows a reason does not
 * get to invent a status code, and a status code that changes does not reach
 * into the store.
 *
 * `not-ready` is the one that matters. It means claimed-but-not-yet-sealed, and
 * a daemon must retry rather than abandon — the job is legitimately still
 * theirs until the lease or the awaiting-payload clock says otherwise. It was
 * the protocol gap that produced the 409 in the first place.
 */
const REFUSALS: Record<HolderRefusal, PlaneResult> = {
  "not-found": {
    status: 404,
    body: { error: "not-found", message: "unknown job" },
  },
  // `forbidden`, not `unauthorized` — V1-13. Both of these are an
  // *identified* caller being refused, which is what 403 means and what the
  // table says `forbidden` is for; `unauthorized` is 401 and means "we do not
  // know who you are". Served as 403 with a 401's code, a revoked daemon and
  // an unsigned one looked alike in every log and every client branch, and
  // "check your keys" is the wrong advice for both in opposite directions.
  "not-holder": {
    status: 403,
    body: {
      error: "forbidden",
      message: "this runner does not hold the job",
    },
  },
  "stale-lease": {
    status: 403,
    body: { error: "forbidden", message: "that lease is no longer current" },
  },
  "not-ready": {
    status: 409,
    body: {
      error: "not-ready",
      message: "the site has not sealed this job yet",
    },
  },
  // Also a 409, and deliberately a different code: `not-ready` means keep
  // asking and this means stop. A daemon that read them as one would poll a
  // finished job until its lease ran out.
  terminal: {
    status: 409,
    body: { error: "too-late", message: "this job has already finished" },
  },
};
const fail = (status: number, error: string, message: string): PlaneResult => ({
  status,
  body: { error, message },
});

/** What a slot's size must be, in the words the reference server uses. */
export const SLOT_SIZE_MESSAGE =
  "a slot is whole 256 KiB buckets plus 40 bytes, up to one image at the cap";

/**
 * A tool call's refusals: the holder's, and three only a tool call can earn.
 *
 * `budget` is read by honest daemons too. The count is the job's and
 * survives a requeue, so a second device that claims a lapsed job starts its
 * own count at 0 and meets this on its first call (Owl, #56042 point 3). It
 * is `forbidden` with {@link TOOLS_SPENT_MESSAGE}, and the daemon recognises
 * that pair: the model is told the job's tools are spent and the job closes
 * `ok` with `stop: "tool-budget"` (byollm_012 §8). Not a code of its own,
 * because a new `WireErrorCode` member breaks every 0.1.4 parser; the
 * constant's note says why the sentence is safe to be the signal.
 */
const TOOL_CALL_REFUSALS: Record<ToolCallRefusal, PlaneResult> = {
  ...REFUSALS,
  "not-tools": fail(400, "bad-request", "this job does not carry tools"),
  budget: fail(403, "forbidden", TOOLS_SPENT_MESSAGE),
  "call-conflict": fail(
    400,
    "bad-request",
    "that call id already names a different call",
  ),
};

/**
 * What the relay asks a control plane, as one named shape.
 *
 * Spelled out twice — here and on `RelayOptions` — until adding `siteKey`
 * made one of them wrong and the build caught it. That was luck: the two are
 * structurally compared, so a field added to the *caller's* copy alone would
 * have been accepted silently and the grant would have carried nothing.
 */
export type GrantAuthor = (input: {
  readonly job: ClaimedStub;
  /** The site's id in the control plane's namespace, for its policy read. */
  readonly siteId: string;
  /**
   * The same site as the stub names it — the key id the device pinned.
   *
   * Carried, never derived. This is the value that gets signed, and the one a
   * device can compare against `stub.site` without a lookup and without
   * trusting the party that routed it.
   */
  readonly siteKey: string;
  readonly purpose?: string;
  readonly owner: string;
  readonly runnerId: string;
  readonly capabilities: CapabilityMatrix;
}) => Promise<GrantDecision> | GrantDecision;

export interface DaemonPlaneDeps {
  readonly state: RoutingStore;
  readonly projection: Projection;
  readonly now: () => number;
  readonly leaseMs: number;
  /**
   * A version this deployment wants daemons to move to — B053, D1.
   *
   * ABSENT BY DEFAULT, and that is the deploy condition rather than a
   * preference: a hub that has not been told a version says nothing to
   * anybody, so shipping this code changes no byte on the wire until
   * somebody sets it deliberately.
   *
   * Never read directly at a return site. {@link updateOfferFor} is the only
   * thing that turns it into a field, because it is the only thing that
   * applies the version fence.
   */
  readonly updateOffer?: string | undefined;
  /**
   * The oldest daemon this deployment will serve — B052, D1.
   *
   * ABSENT BY DEFAULT, and that is the second deploy condition rather than a
   * preference: a floor set optimistically on deploy day takes working
   * machines down, which is B052's opposite-boolean hazard arriving as an
   * ops mistake instead of a coding one. Shipping the code refuses nobody;
   * raising it is a separate, deliberate act.
   */
  readonly daemonFloor?: string | undefined;
  /**
   * Where pending pairing codes live — cloud_009.
   *
   * Optional so a relay that only serves pre-approved devices keeps working
   * unchanged; when absent, the device-code flow answers "not supported"
   * rather than pretending.
   */
  readonly pairingCodes?: PairingCodes | undefined;
  /**
   * The control plane's grant-signing public key — Amendment J.
   *
   * Handed to a daemon at pairing so it can check every grant this relay
   * later delivers. This is the one moment the relay tells a device whom to
   * believe, and it happens inside the ceremony where a human is already
   * comparing fingerprints — the alternative, trust-on-first-grant, would
   * hand the choice of authority to whoever controls delivery.
   *
   * Optional so a relay with no control plane behind it keeps working
   * unchanged: a daemon that receives none serves its owner alone through
   * this pairing.
   */
  readonly controlPlanePublic?: string | undefined;
  /**
   * Author a grant for one claimed job — Amendment J. See
   * {@link RelayOptions.authorGrant}; this plane only calls it.
   */
  readonly authorGrant?: GrantAuthor;
  /**
   * The blob decisions, when this relay's host gave it a blob store —
   * byollm_021 §2, for the output check at `result`. The two blob endpoints
   * are handed it by the router, which has neither route without one.
   */
  readonly blobs?: RelayBlobs | undefined;
  /**
   * Where a human goes to approve a code — the control plane, always.
   *
   * The relay cannot approve anything: approving is looking at a fingerprint
   * while signed in, and the session that makes that meaningful lives in the
   * dashboard. So this is a URL the relay is *given*, not one it derives.
   */
  readonly verificationUrl?: string | undefined;
  /**
   * Which site this relay routes for.
   *
   * The skeleton relays for one site because that is all the freeze gate
   * needs. The production hub's multi-tenant router is the closed piece that
   * replaces this field (cloud_004 §9) — recorded here so the seam is visible
   * rather than assumed away.
   */
}

export class DaemonPlane {
  readonly #deps: DaemonPlaneDeps;

  constructor(deps: DaemonPlaneDeps) {
    this.#deps = deps;
  }

  /**
   * Pair a device — cloud_004 §3, the key-exchange moment.
   *
   * The relay hands back **the site's** public identity, taken from the
   * consent projection, not its own. This is the sentence that makes hub mode
   * safe: the daemon pins the party that will actually seal its work, so an
   * envelope is verified against the site even though it arrived via us. A
   * relay that substituted its own identity here could inject work — and would
   * need a private key to do it, which is why it has none.
   */
  async pair(body: unknown): Promise<PlaneResult> {
    // The device-code flow — cloud_009, and the reason cloud pairing did not
    // work at all. `byollm connect` has always sent this shape; nothing on
    // this side accepted it, so every cloud user's first command failed
    // schema validation. Direct mode implemented it, the conformance kit
    // drove direct mode, and the seam between them was what nothing checked.
    const start = PairStartRequest.safeParse(body);
    if (start.success) return this.#pairStart(start.data);

    const poll = PairPollRequest.safeParse(body);
    if (poll.success) return this.#pairPoll(poll.data);

    const parsed = PairFixtureRequest.safeParse(body);
    if (!parsed.success) {
      return fail(400, "bad-request", "pair request failed schema validation");
    }
    if (!verifyPublicIdentity(parsed.data.device)) {
      return fail(400, "bad-request", "the device identity is not consistent");
    }

    // Every site this owner has consented to — cloud_009 §3. The relay is no
    // longer configured with one: it routes for whatever the projection
    // holds, which is the honest shape, and `RelayOptions.siteId` was always
    // a stand-in for the projection being single-site.
    //
    // The keys come from the site registry, which is their one home. They
    // used to be inlined on each consent record, which gave a site's key one
    // copy per consenting user and nothing to reconcile them against.
    const sites = this.#deps.projection.sitesFor(parsed.data.owner);
    if (sites.length === 0) {
      // CONSENT_BEFORE_ROUTE. There is no discovery path that creates one:
      // consent is a click somewhere else, and the relay only reads it.
      return fail(403, "forbidden", "no consent record for this user");
    }

    // The device must already be approved, by a human, in the control plane.
    //
    // It presented keys; that is an assertion, not an identity. Somebody had
    // to look at a fingerprint and say yes, and this is where that decision is
    // enforced. byollm_009's seventh finding stopped a daemon from *naming*
    // itself and this stops it from *keying* itself — otherwise the relay
    // would be the authority on who a machine is, which is precisely the role
    // a blind relay must not hold.
    //
    // Matched on the identity key rather than a claimed id: the key is what
    // the human approved and what every later signature is checked against.
    const approved = this.#deps.projection.deviceByFingerprint(
      parsed.data.device.identity,
    );
    if (!approved) {
      return fail(
        403,
        "forbidden",
        "this device has not been approved by its owner",
      );
    }
    if (approved.owner !== parsed.data.owner) {
      // The device was approved by somebody else. Refused rather than
      // re-owned: an approval is for a person, not a key in general.
      return fail(403, "forbidden", "this device belongs to another owner");
    }

    // The id comes from the control plane, not from the device and not from
    // here — one authority for identity, and it is the one with the human in
    // it. The relay's own uuid minting was a stopgap for a fixture with no
    // devices in it.
    const runnerId = approved.runnerId;

    // No timestamp: the store stamps `lastSeenAt` from its own clock, so
    // presence and the deadlines that reason about it agree (cloud_006 §3.4).
    await this.#deps.state.seen({
      runnerId,
      owner: parsed.data.owner,
      device: parsed.data.device,
      // The fixture exchange carries no matrix — it models a consent that
      // arrived from a file, not a daemon describing itself. Empty until the
      // first heartbeat, which is seconds away and is the authority anyway.
      capabilities: [],
      withheld: [],
    });

    return ok({
      protocolVersion: PROTOCOL_VERSION,
      runnerId,
      /**
       * The *sites'* keys. See the note above — this is load-bearing.
       *
       * The set this owner has consented to, keyed by each site's identity
       * key id (cloud_009 §5). Paused sites are here: a paused consent keeps
       * its pin so re-consenting never costs a re-pair, and what it does not
       * do is route.
       */
      sites: Object.fromEntries(
        sites.map((record) => [keyId(record.site.identity), record.site]),
      ),
      // The key every later grant is checked against — Amendment J. Sent
      // here and nowhere else: pairing is the ceremony where a human is
      // already deciding whether to trust this upstream, so a key learned
      // here rides a decision that has been made rather than inventing one.
      ...(this.#deps.controlPlanePublic === undefined
        ? {}
        : { controlPlanePublic: this.#deps.controlPlanePublic }),
    });
  }

  /**
   * Mint a code, remember the keys it stands for, and send the human away.
   *
   * Nothing is decided here. The relay holds an assertion — "this keypair
   * would like to be a machine" — for ten minutes, and the decision happens
   * where the person is signed in.
   */
  async #pairStart(request: PairStartRequest): Promise<PlaneResult> {
    const codes = this.#deps.pairingCodes;
    const verificationUrl = this.#deps.verificationUrl;
    if (!codes || verificationUrl === undefined) {
      // Said plainly rather than answered with a schema error: a relay
      // without a code store cannot do this, and the daemon's user deserves
      // to know that rather than to read "bad request".
      return fail(
        501,
        "bad-request",
        "this relay does not offer device-code pairing",
      );
    }
    if (!verifyPublicIdentity(request.device)) {
      return fail(400, "bad-request", "the device identity is not consistent");
    }

    const pending: PendingPairing = {
      deviceCode: newDeviceCode(),
      userCode: newUserCode(),
      device: request.device,
      label: request.daemon.label,
      platform: request.daemon.platform,
      capabilities: request.capabilities,
      expiresAt: this.#deps.now() + PAIRING_CODE_TTL_MS,
    };
    if ((await codes.put(pending)) === "at-capacity") {
      // The protocol already has one word for "too much traffic, back off",
      // and this is that. Nothing this caller did was wrong — the relay is
      // full of other people's pending pairings — but the instruction is the
      // same one `rate-limited` always carries, and a second vocabulary for
      // the same idea would be a worse answer than a slightly generous code.
      return fail(
        ERROR_STATUS["rate-limited"],
        "rate-limited",
        PAIRING_BUSY_MESSAGE,
      );
    }

    return ok({
      deviceCode: pending.deviceCode,
      userCode: pending.userCode,
      verificationUrl,
      expiresAt: pending.expiresAt,
      // Two seconds: fast enough that approving feels immediate, slow enough
      // that a forgotten terminal is not a load generator.
      pollIntervalMs: 2_000,
    });
  }

  /**
   * Has anybody approved this keypair yet?
   *
   * The answer comes from the **projection** — the control plane's own record
   * of devices a human approved — and never from a flag set here. That is the
   * whole shape of the fence: the dashboard writes the approval to its own
   * database, the hub's projection catches up within a poll, and this notices.
   * No write crosses in either direction.
   */
  async #pairPoll(request: PairPollRequest): Promise<PlaneResult> {
    const codes = this.#deps.pairingCodes;
    if (!codes) {
      return fail(
        501,
        "bad-request",
        "this relay does not offer device-code pairing",
      );
    }

    const pending = await codes.byDeviceCode(request.deviceCode);
    // Expired and never-existed answer the same way, deliberately: a poll
    // loop cannot tell them apart and does not need to, and distinguishing
    // them would let somebody test codes for existence.
    if (!pending) return ok({ status: "expired" });

    const approved = this.#deps.projection.deviceByFingerprint(
      pending.device.identity,
    );
    if (!approved) return ok({ status: "pending" });

    const sites = this.#deps.projection.sitesFor(approved.owner);
    // Approved with nothing consented is still approved: the machine exists,
    // it belongs to somebody, and the site set is a projection of consent
    // that changes on every heartbeat anyway. Refusing here would make a
    // brand-new account's first pairing fail for a reason it cannot act on
    // from a terminal.
    await this.#deps.state.seen({
      runnerId: approved.runnerId,
      owner: approved.owner,
      device: pending.device,
      // What this machine said it could run when it asked to pair, so the
      // approval screen and the machines page have an answer in the same
      // moment the device appears. The next heartbeat replaces it.
      capabilities: pending.capabilities,
      // A pairing request describes what a machine *can* run, not what it is
      // holding back — the daemon resolves defaults locally, and the first
      // heartbeat is where that answer arrives.
      withheld: [],
    });
    // Single use. The keypair is approved from here on and the code has no
    // further job; leaving it would be a second way to ask the same question.
    await codes.drop(pending.deviceCode);

    return ok({
      status: "approved",
      runnerId: approved.runnerId,
      owner: approved.owner,
      sites: Object.fromEntries(
        sites.map((record) => [keyId(record.site.identity), record.site]),
      ),
      // The key every later grant is checked against — Amendment J. Sent
      // here and nowhere else: pairing is the ceremony where a human is
      // already deciding whether to trust this upstream, so a key learned
      // here rides a decision that has been made rather than inventing one.
      ...(this.#deps.controlPlanePublic === undefined
        ? {}
        : { controlPlanePublic: this.#deps.controlPlanePublic }),
    });
  }

  /** Every authenticated call: signature first, then consent, then work. */
  async #authed<T>(
    input: { endpoint: string; rawBody: string; signature: unknown },
    body: unknown,
    schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
    run: (
      request: T,
      device: { runnerId: string; owner: string; device: PublicIdentity },
    ) => Promise<PlaneResult>,
    options: { allowRevoked?: boolean } = {},
  ): Promise<PlaneResult> {
    const signature = RequestSignature.safeParse(input.signature);
    if (!signature.success) {
      return fail(401, "unauthorized", "this request is not signed");
    }
    // **Presence is a cache, and a cache miss is not an answer about identity.**
    //
    // This used to refuse outright, which made a store blip into a fleet-wide
    // outage: the hub keeps presence in Valkey with no persistence and no
    // volume, so a reschedule — bin-packing on Autopilot, a node upgrade,
    // anything — dropped every record at once and every daemon alive was told
    // `this runner is not recognised` until a human re-paired it, one machine
    // at a time. The one-hour TTL was the same failure arriving more slowly.
    //
    // Who a runner is has never lived here. It lives in the projection, put
    // there by a person comparing a fingerprint, and this file already says so
    // three times over — revocation is asked of the projection rather than a
    // cached flag, for exactly this reason. So a miss is repaired from the
    // authority instead of being reported as a verdict.
    let known = await this.#deps.state.presence(signature.data.runnerId);
    let rebuilt = false;
    if (!known) {
      const approved = this.#deps.projection.deviceFor(signature.data.runnerId);
      // Still the honest refusal when the *projection* does not know it: no
      // human ever approved this machine, and no amount of signing changes
      // that.
      if (!approved) {
        return fail(401, "unauthorized", "this runner is not recognised");
      }
      known = {
        ...approved,
        lastSeenAt: this.#deps.now(),
        // Not invented. The heartbeat is the authority on what a machine can
        // run, and it is seconds away; claiming a matrix here would be this
        // file guessing about a backend it cannot see.
        capabilities: [],
        withheld: [],
      };
      rebuilt = true;
    }

    const failure = verifyRequest({
      identityPublic: known.device.identity,
      endpoint: input.endpoint,
      body: input.rawBody,
      signature: signature.data,
      now: this.#deps.now(),
    });
    if (failure === "stale") return this.#clockSkew();
    if (failure) return fail(401, "unauthorized", "signature check failed");

    // Written only now, and the order is the whole safety argument: a record
    // restored *before* the signature was checked would let anybody who knows
    // a runner id repopulate presence for a machine they do not hold the keys
    // to. A verified signature over this request is proof the caller holds the
    // key a human approved, which is the same proof pairing produced.
    if (rebuilt) {
      await this.#deps.state.seen({
        runnerId: known.runnerId,
        owner: known.owner,
        device: known.device,
        capabilities: [],
        // Nothing has described itself yet, so nothing is withheld — the
        // first heartbeat is the authority on both.
        withheld: [],
      });
    }

    // Asked of the projection, not of the cached flag.
    //
    // `known.revoked` is set by `heartbeat`, and enforcing on it made
    // revocation depend on the client calling an endpoint: a daemon that
    // simply never heartbeats would go on claiming after its consent was
    // withdrawn, forever. A well-behaved daemon beats every few seconds, which
    // is why the freeze gate's "within one heartbeat" demo passed and why this
    // was invisible — the guarantee held for every client that wanted it to.
    //
    // The cached flag survives as what heartbeat *reports* to the daemon. It
    // is a message, not an authority, and the authority is the projection.
    // Two copies of one value where one is a stale mirror of the other is this
    // project's most-repeated bug; here it was also an enforcement hole.
    // The whole relationship ending — cloud_008 finding 59, corrected by
    // V1-2. Per-site revocation is the *set* changing, which heartbeat
    // reports; this guard is the end of everything, and it is the only thing
    // that should refuse a call outright.
    //
    // It used to read "nothing to serve" as "revoked", which made an empty or
    // half-written projection indistinguishable from a human's decision — and
    // the daemon's answer to revocation is to delete its pairings file. One
    // bad push, every pin gone. `revokedOutright` asks for the evidence
    // instead: a revocation on record, and nothing left standing.
    const revoked = this.#deps.projection.revokedDevice(known.runnerId);
    if (revoked && options.allowRevoked !== true) {
      // Every endpoint, heartbeat included — V1-2. Heartbeat used to be
      // answerable by a revoked runner so it could be told through an empty
      // set; that inference is gone, because an empty set is also what a
      // half-written projection looks like. The refusal is the message now,
      // and it reaches even a daemon that never claims because no backend of
      // its own is running.
      return fail(403, "revoked", "routing for this runner has been revoked");
    }

    known.lastSeenAt = this.#deps.now();

    const parsed = schema.safeParse(body);
    if (!parsed.success || parsed.data === undefined) {
      return fail(400, "bad-request", "request failed schema validation");
    }
    return run(parsed.data, known);
  }

  /**
   * A clock too far from ours, said plainly and with the number to fix it by.
   *
   * Its own error code rather than a generic `unauthorized`, because it is the
   * one refusal a retry can never fix and an `ntpdate` always can — the same
   * reasoning `version-unsupported` already carries on the daemon side. A
   * daemon that reports this as a generic rejection sends its owner looking at
   * their network.
   *
   * `serverTime` is included so the far side can say *how far off* rather than
   * *that something is wrong*. It is not a disclosure: the heartbeat response
   * returns the same value, and so does every `Date` header.
   */
  #clockSkew(): PlaneResult {
    return clockSkewRefusal(this.#deps.now());
  }

  claim(
    auth: { endpoint: string; rawBody: string; signature: unknown },
    body: unknown,
  ): Promise<PlaneResult> {
    return this.#authed(auth, body, ClaimRequest, async (request, device) => {
      if (request.runnerId !== device.runnerId) {
        // The signature verified, so we know exactly who this is; the body
        // names somebody else. 403 with `forbidden` — V1-13. The site plane
        // has always answered its own version of this 403, and one wire
        // answering two ways is a difference a daemon cannot see the reason
        // for.
        return fail(403, "forbidden", "runner id does not match the key");
      }
      // One store call. The decision and its write are the store's, because a
      // caller that reads, filters and writes back cannot be made atomic once
      // the store is on a network (cloud_006 §3.2).
      const granted = await this.#deps.state.claim({
        runnerId: device.runnerId,
        owner: device.owner,
        device: device.device,
        // Every kind this device can run, from any of its services.
        //
        // This used to send only the *defaults* — the rows an unselected job
        // should reach — beside the whole menu as (kind, service) pairs. A
        // job names no service now, so there is no menu to match against and
        // no unselected case for a default to catch: a device answering a
        // kind at all is a candidate, and which of its services runs the work
        // is resolved from the person's mapping when the grant is signed.
        kinds: new Set(request.capabilities.map((c) => c.kind)),
        // The projection, collapsed to data the store can match on — a
        // predicate does not travel, and a set of (site, owner) pairs is
        // what a route is (cloud_009 §3).
        //
        // A paused consent (cloud_008 finding 48) drops its routes and
        // leaves the rest, which is the whole difference between "we are
        // waiting for you to read something about one site" and "a human cut
        // you off from everything".
        routes: this.#deps.projection.routesFor(device.owner),
        max: request.max,
        leaseMs: this.#deps.leaseMs,
      });

      /**
       * The grant, attached at claim and nowhere else — Amendment J.
       *
       * After the store's atomic claim, deliberately. A grant authored for a
       * job this device did not actually win would be a signed statement
       * about work somebody else is running, and the window between deciding
       * and writing is exactly where that goes wrong.
       *
       * A declined job is released here rather than sent bare. Sending it
       * would cost three round trips to reach an answer this side already
       * has, and a device refusing a job with no grant cannot tell "the
       * control plane said no" from "the relay lost it" — so it would report
       * the wrong thing.
       *
       * **Two release shapes, and the difference is not cosmetic.** A
       * permanent decline is released as `refused`, which means this job is
       * never offered to this device again — right for a person removed from
       * a team, because removal stops queued claims (hole 1).
       *
       * A transient one goes back in the queue **with a not-before**. Not
       * plainly: a plain release stays claimable by the same device, so it
       * would re-claim at once, be declined again, and spin — one control
       * plane read per turn, for a job that is not going to run there. A
       * mapping that resolved to another of the owner's machines, an
       * unfilled slot, or a store that was briefly unreachable are all
       * states the world can change, and "ask again later" needs a later.
       *
       * The relay does not read the reason. Branching on it here would be a
       * second implementation of a policy this process does not own.
       */
      const author = this.#deps.authorGrant;
      if (author === undefined) {
        return ok({ jobs: granted, leaseMs: this.#deps.leaseMs });
      }
      const withGrants: ClaimedStub[] = [];
      const refused: { jobId: string; leaseId: string }[] = [];
      const returned: { jobId: string; leaseId: string }[] = [];
      for (const job of granted) {
        const siteId = this.#deps.projection.siteIdForKey(job.site);
        const decision =
          siteId === null
            ? // A stub naming a site this projection cannot place. Transient
              // rather than permanent: the projection is what is behind, not
              // the job.
              { declined: { permanent: false, reason: "unknown-site" } }
            : await author({
                job,
                siteId,
                // Straight off the stub. A relay that computed this would be
                // choosing which site a grant says it is for, which is the
                // one thing the signature exists to take out of its hands.
                siteKey: job.site,
                // The site's own purpose, straight off the stub. A relay does
                // not interpret it — it does not hold the manifest and does
                // not hold the mapping; it carries the site's word to the one
                // party that can join them.
                ...(job.purpose === undefined ? {} : { purpose: job.purpose }),
                owner: device.owner,
                runnerId: device.runnerId,
                capabilities: request.capabilities,
              });
        if (decision.granted === undefined) {
          const lease = { jobId: job.id, leaseId: job.lease.id };
          (decision.declined.permanent ? refused : returned).push(lease);
          continue;
        }
        withGrants.push({ ...job, grant: decision.granted });
      }
      // Released rather than left leased. A job nobody may run should be back
      // in the queue for a device whose owner still may, not held by a lease
      // that has to time out first.
      if (refused.length > 0) {
        await this.#deps.state.releaseLeases({
          runnerId: device.runnerId,
          leases: refused,
          reason: "refused",
        });
      }
      if (returned.length > 0) {
        await this.#deps.state.releaseLeases({
          runnerId: device.runnerId,
          leases: returned,
          retryAfter: this.#deps.now() + RETRY_AFTER_MS,
        });
      }

      return ok({ jobs: withGrants, leaseMs: this.#deps.leaseMs });
    });
  }

  /**
   * Hand over the sealed payload, if the site has left one.
   *
   * The one endpoint whose behaviour differs from a direct site's, and the
   * difference is the whole design: a direct site seals here, on demand,
   * because it holds the keys. The relay waits. A `409` means "claimed, not
   * yet sealed" — a daemon should retry, not treat it as a refusal, because
   * the job is still legitimately theirs until the lease or the
   * awaiting-payload clock says otherwise.
   */
  fetch(
    auth: { endpoint: string; rawBody: string; signature: unknown },
    body: unknown,
  ): Promise<PlaneResult> {
    return this.#authed(auth, body, FetchRequest, async (request, device) => {
      const taken = await this.#deps.state.takePayload({
        jobId: request.jobId,
        runnerId: device.runnerId,
        leaseId: request.leaseId,
      });
      if ("refused" in taken) return REFUSALS[taken.refused];
      return ok({ envelope: taken.envelope });
    });
  }

  /**
   * Take a sealed result.
   *
   * The relay stores ciphertext and records the disposition so it can stop
   * dispatching. It cannot check the two against each other — that requires
   * opening the envelope, which is the site's job and the site's key. This is
   * the asymmetry byollm_009 §6.1 describes: the hint is actionable here and
   * only verifiable there.
   */
  result(
    auth: { endpoint: string; rawBody: string; signature: unknown },
    body: unknown,
  ): Promise<PlaneResult> {
    return this.#authed(auth, body, ResultRequest, async (request, device) => {
      // The same ceiling the site plane applies, on the way back — ratified
      // 2026-08-28. Both directions count against the pool and both are
      // refused by one limit; a rail that guarded only the inbound half would
      // be a relay a device could still fill.
      const bytes = envelopeBytes(request.envelope);
      if (bytes > MAX_ENVELOPE_BYTES) return tooLargeRefusal(bytes);

      /**
       * The output check, before the result is accepted — byollm_021 §2,
       * "Output blobs get the same check before the result is accepted".
       *
       * The relay cannot read which blobs the sealed result names, so it
       * holds every output slot issued under this lease to the size it was
       * issued for. Only for an `ok` result of an `llm.image` job still in
       * flight: a replay of a result already recorded is `complete`'s to
       * answer, and by then `received` may have deleted what it named.
       */
      const blobs = this.#deps.blobs;
      const job =
        blobs === undefined
          ? undefined
          : await this.#jobUnder(request.jobId, request.leaseId, device);
      if (
        blobs !== undefined &&
        job !== undefined &&
        job.state !== "done" &&
        job.stub.kind === "llm.image" &&
        request.disposition === "ok"
      ) {
        const fault = await blobs.outputFault({
          siteId: job.siteId,
          jobId: job.id,
          leaseId: request.leaseId,
        });
        if (fault !== null) return fail(400, "bad-request", fault);
      }

      const recorded = await this.#deps.state.complete({
        jobId: request.jobId,
        runnerId: device.runnerId,
        leaseId: request.leaseId,
        envelope: request.envelope,
        disposition: request.disposition,
      });
      if ("refused" in recorded) return REFUSALS[recorded.refused];
      // Accepted, so nothing reads the inputs again: they go now (§2).
      // After the write, and only for the request that made it — a replay
      // finds them already gone. A store that cannot be reached must not
      // turn a recorded result into an error: the sweep deletes them a day
      // after the deadline instead.
      if (blobs !== undefined && job !== undefined && recorded.accepted) {
        await blobs
          .resultAccepted(
            { siteId: job.siteId, jobId: job.id },
            request.disposition,
          )
          .catch(() => undefined);
      }
      return ok(recorded);
    });
  }

  // -- blobs — byollm_021 §2 ------------------------------------------------

  /**
   * The job this device is the claimant of under `leaseId`, in any state,
   * or `undefined`.
   *
   * A blob request names a job and a lease and no site, and a job id is a
   * site's to choose, so the job is looked for under each site this
   * device's owner has consented to — the only sites whose work can be on
   * this machine at all. Matched on the lease id, which this relay minted
   * and which is unique across sites, and on the runner the signature
   * proved. Read through `RoutingStore.job`, so a store needs nothing new.
   */
  async #jobUnder(
    jobId: string,
    leaseId: string,
    device: { readonly runnerId: string; readonly owner: string },
  ): Promise<RoutedJob | undefined> {
    for (const site of this.#deps.projection.sitesFor(device.owner)) {
      const job = await this.#deps.state.job(site.siteId, jobId);
      if (
        job?.claimedBy?.runnerId === device.runnerId &&
        job.claimedBy.leaseId === leaseId
      ) {
        return job;
      }
    }
    return undefined;
  }

  /**
   * The job this device holds *right now* under `leaseId`, or `undefined` —
   * the lease scope both blob endpoints share
   * ({@link MUSTS.LEASE_SCOPED_BY_GRANT}, C053).
   *
   * Held means: claimed by this runner under exactly this grant, the grant
   * not yet expired on the store's clock, the payload collected (`running`),
   * and the job neither finished nor withdrawn. A device that has not
   * fetched its payload has no reference to ask about, and one whose grant
   * ended has no business with the job's blobs.
   */
  async #held(
    jobId: string,
    leaseId: string,
    device: { readonly runnerId: string; readonly owner: string },
  ): Promise<RoutedJob | undefined> {
    const job = await this.#jobUnder(jobId, leaseId, device);
    if (
      job?.claimedBy === undefined ||
      job.state !== "running" ||
      job.cancelled === true ||
      job.claimedBy.leaseExpiresAt <= (await this.#deps.state.now())
    ) {
      return undefined;
    }
    return job;
  }

  /**
   * A download URL for one input blob of a job this device holds.
   *
   * **No lease, no URL.** One `not-found` for a lease that is not held, a
   * blob that is not one of this job's stored inputs, and one that is not
   * the size its slot was issued for — a caller without the lease learns
   * nothing about which. The object is addressed by the site and the job
   * the lease names, never by anything in the request but the blob id, so
   * a lease on one job reaches no other job's blobs.
   */
  blobUrl(
    blobs: RelayBlobs,
    auth: { endpoint: string; rawBody: string; signature: unknown },
    body: unknown,
  ): Promise<PlaneResult> {
    return this.#authed(auth, body, BlobUrlRequest, async (request, device) => {
      if (request.runnerId !== device.runnerId) {
        return fail(403, "forbidden", "runner id does not match the key");
      }
      const job = await this.#held(request.jobId, request.leaseId, device);
      const signed =
        job === undefined
          ? null
          : await blobs.downloadUrl({
              siteId: job.siteId,
              jobId: job.id,
              direction: "in",
              blob: request.blob,
            });
      if (signed === null) {
        return fail(404, "not-found", "no such blob under a lease you hold");
      }
      return ok(BlobUrlResponse.parse(signed));
    });
  }

  /**
   * An upload slot for one output image of an `llm.image` job this device
   * holds. Lease-scoped as {@link DaemonPlane.blobUrl} is, and at most
   * `MAX_IMAGES_OUT` under one lease.
   */
  blobSlot(
    blobs: RelayBlobs,
    auth: { endpoint: string; rawBody: string; signature: unknown },
    body: unknown,
  ): Promise<PlaneResult> {
    return this.#authed(
      auth,
      body,
      BlobSlotRequest,
      async (request, device) => {
        if (request.runnerId !== device.runnerId) {
          return fail(403, "forbidden", "runner id does not match the key");
        }
        const job = await this.#held(request.jobId, request.leaseId, device);
        if (job === undefined) {
          return fail(404, "not-found", "no such lease on this job");
        }
        if (job.stub.kind !== "llm.image") {
          return fail(
            400,
            "bad-request",
            "only an llm.image job uploads images",
          );
        }
        if (!isBlobObjectSize(request.bytes)) {
          return fail(400, "bad-request", SLOT_SIZE_MESSAGE);
        }
        const slot = await blobs.outputSlot(
          {
            siteId: job.siteId,
            jobId: job.id,
            leaseId: request.leaseId,
            deadlineAt: job.stub.deadlineAt,
          },
          request.bytes,
        );
        if (slot === "full") {
          return fail(
            400,
            "bad-request",
            "this lease has been issued every output slot an llm.image job may use",
          );
        }
        return ok(BlobSlotResponse.parse(slot));
      },
    );
  }

  /**
   * One sealed tool call, from the device holding the job — byollm_012 §5.2.
   *
   * What the relay can check without opening anything, and nothing more: the
   * signature (above), the grant, the kind, the per-job count and the size.
   * The envelope goes to the site as it arrived.
   */
  toolCall(
    auth: { endpoint: string; rawBody: string; signature: unknown },
    body: unknown,
  ): Promise<PlaneResult> {
    return this.#authed(
      auth,
      body,
      ToolCallRequest,
      async (request, device) => {
        if (request.runnerId !== device.runnerId) {
          return fail(403, "forbidden", "runner id does not match the key");
        }
        const bytes = envelopeBytes(request.envelope);
        if (bytes > MAX_ENVELOPE_BYTES) return tooLargeRefusal(bytes);
        const recorded = await this.#deps.state.recordToolCall({
          jobId: request.jobId,
          runnerId: device.runnerId,
          leaseId: request.leaseId,
          callId: request.callId,
          envelope: request.envelope,
        });
        if ("refused" in recorded) return TOOL_CALL_REFUSALS[recorded.refused];
        return ok(
          ToolCallResponse.parse({
            callId: recorded.callId,
            expiresAt: recorded.expiresAt,
          }),
        );
      },
    );
  }

  /** The site's answers to the calls this device names — byollm_012 §5.2. */
  toolResults(
    auth: { endpoint: string; rawBody: string; signature: unknown },
    body: unknown,
  ): Promise<PlaneResult> {
    return this.#authed(
      auth,
      body,
      ToolResultsRequest,
      async (request, device) => {
        if (request.runnerId !== device.runnerId) {
          return fail(403, "forbidden", "runner id does not match the key");
        }
        const results = await this.#deps.state.toolResults({
          runnerId: device.runnerId,
          calls: request.calls,
        });
        return ok(ToolResultsResponse.parse({ results }));
      },
    );
  }

  heartbeat(
    auth: { endpoint: string; rawBody: string; signature: unknown },
    body: unknown,
  ): Promise<PlaneResult> {
    return this.#authed(
      auth,
      body,
      HeartbeatRequest,
      async (request, device) => {
        /**
         * Too old to serve — B052, checked here because here is where the
         * version is.
         *
         * The spec said "connect/claim". `ClaimRequest` carries no
         * `daemonVersion`, so claim cannot ask the question at all; the
         * heartbeat and the pairing are the two requests that name a
         * version, and a daemon heartbeats every few seconds, so this
         * refuses a straggler within one beat and it cannot claim without a
         * pairing anyway. Saying so rather than quietly enforcing somewhere
         * the spec did not mean.
         */
        const belowFloor =
          this.#deps.daemonFloor === undefined
            ? null
            : checkDaemonFloor({
                daemonVersion: request.daemonVersion,
                floor: this.#deps.daemonFloor,
                upgradeCommand: UPGRADE_COMMAND,
              });
        if (belowFloor !== null) {
          /* `floor` travels as a field, not only inside the sentence, so a
             surface can say "two versions under" without parsing English —
             the same rule the version handshake's `supported`/`minimum`
             follow, and the WireError refinement requires it on this code. */
          return {
            status: ERROR_STATUS["daemon-below-floor"],
            body: {
              error: belowFloor.error,
              message: belowFloor.message,
              floor: belowFloor.floor,
            },
          };
        }

        const now = this.#deps.now();
        await this.#deps.state.sweep();

        // **Presence is recorded here, and it was not before.**
        //
        // `seen()` was called from the two pairing paths and nowhere else, so
        // `lastSeenAt` was written once when a machine paired and never moved
        // again. Everything downstream read it as liveness — the debug page's
        // who-is-online, and the `/devices` endpoint about to serve a
        // machines page — and it was reporting the pairing time under the
        // name "last seen". A field that is quietly a different fact is worse
        // than a missing one.
        //
        // The matrix rides along because it is the same fact on the same
        // schedule: this is the request that re-sends it, and a machine that
        // stopped heartbeating has not stopped being capable, it has stopped
        // being reachable. Recorded before the no-sites branch below, because
        // a machine with nothing consented is still online and still has
        // something to show.
        await this.#deps.state.seen({
          runnerId: device.runnerId,
          owner: device.owner,
          device: device.device,
          capabilities: request.capabilities,
          // Arrives on the same beat as the matrix and goes stale with it.
          // A daemon that resolves a contended kind stops sending it here,
          // which is what retires the owner's prompt to choose.
          withheld: request.withheld,
        });

        // Revocation is a fixture edit, and this is where the daemon learns
        // of it — within one heartbeat, which is what the freeze gate times.
        // The set, not a boolean — cloud_008 finding 59. A site that leaves
        // it is revoked for that site; the daemon drops that pin and keeps
        // the rest. An empty set is what `revoked: true` used to mean, and
        // the daemon reads it for itself rather than being told twice.
        const pinned = this.#deps.projection.sitesFor(device.owner);
        const sites = Object.fromEntries(
          pinned.map((record) => [keyId(record.site.identity), record.site]),
        );
        // How each of those keys can be traced back to one the daemon already
        // holds — byollm_009 Amendment C. Composed here rather than folded
        // into `sites` because `sites` is the one statement of which key is
        // current and this is evidence about how it got there; the relay
        // distributes both and can mint neither.
        //
        // Only for sites that have actually rotated, so the field is absent
        // for every site today and a daemon that has never seen a rotation
        // never parses one.
        const successions = Object.fromEntries(
          pinned
            .filter((record) => (record.succeeds?.length ?? 0) > 0)
            .map((record) => [
              keyId(record.site.identity),
              {
                succeeds: record.succeeds ?? [],
                ...(record.retiringUntil === undefined
                  ? {}
                  : { retiringUntil: record.retiringUntil }),
              },
            ]),
        );
        const rotations =
          Object.keys(successions).length > 0 ? { successions } : {};
        // A subset: paused sites keep their pin and route nothing, so the
        // daemon can name what the user has to go and read.

        const awaitingConsent = pinned
          .filter(
            (record) =>
              !this.#deps.projection.mayRouteFor(device.owner, record.siteId),
          )
          .map((record) => keyId(record.site.identity));

        if (pinned.length === 0) {
          // Nothing left to serve. The daemon abandons the queue rather than
          // finishing it, exactly as the direct plane's revoked branch does:
          // a daemon cannot see which upstream it is talking to, and the rule
          // must not depend on that.
          return ok({
            sites,
            ...rotations,
            ...updateOfferFor({
              offer: this.#deps.updateOffer,
              daemonVersion: request.daemonVersion,
            }),
            awaitingConsent,
            cancel: [],
            lost: request.activeLeases.map((lease) => ({
              jobId: lease.jobId,
              leaseId: lease.leaseId,
            })),
            serverTime: now,
          });
        }

        // Renewal and loss, from one read — cloud_008 §0.6. This used to
        // return `leases: []` unconditionally, which told a working daemon
        // every few seconds that nothing it held had been renewed while the
        // sweep requeued its work at `leaseMs`. Any job slower than a lease
        // was handed to a second device mid-flight.
        //
        // The renewal is the fix; reporting it back was not. §1.4b took that
        // field off the wire — no daemon ever read it, and `lost` answers the
        // same question in the direction a daemon can act on.
        // What the site withdrew — cloud_008 §2.2. This was the literal
        // `cancel: []`, so a site could not stop a job it had already
        // cancelled: the device went on running work whose result nobody
        // would accept, on somebody's own machine and at their expense.
        const cancel = await this.#deps.state.cancelRequests(device.runnerId);

        const { lost } = await this.#deps.state.renewLeases({
          runnerId: device.runnerId,
          leases: request.activeLeases,
          leaseMs: this.#deps.leaseMs,
        });

        return ok({
          sites,
          ...rotations,
          /**
           * The update offer — B053, and the ONLY way this field is set.
           *
           * `updateOfferFor` applies `mayOfferUpdate` inside itself and
           * returns a spreadable object, so there is no `updateTo:` anywhere
           * for a later hand to copy to a third return site. There are
           * already two, which is how a remember-to-check rule fails.
           *
           * HeartbeatResponse is `.strict()`: a wrong emission is not a bad
           * offer, it is every pre-.83 daemon rejecting every heartbeat.
           */
          ...updateOfferFor({
            offer: this.#deps.updateOffer,
            daemonVersion: request.daemonVersion,
          }),
          awaitingConsent,
          cancel,
          lost,
          serverTime: now,
        });
      },
    );
  }

  release(
    auth: { endpoint: string; rawBody: string; signature: unknown },
    body: unknown,
  ): Promise<PlaneResult> {
    return this.#authed(auth, body, ReleaseRequest, async (request, device) => {
      const released = await this.#deps.state.releaseLeases({
        runnerId: device.runnerId,
        leases: request.leases,
        // Was dropped here — cloud_008 §2.1. `reason` is on the wire, the
        // schema's own docstring says an upstream MUST record `refused`, and
        // this handler read every other field.
        reason: request.reason,
      });
      return ok({ released });
    });
  }
}

/**
 * Pairing, as the skeleton does it.
 *
 * Not the public `PairRequest`: that models a device-code exchange with a
 * human at a browser, and the skeleton's consent arrives from a fixture
 * instead (cloud_004 §14). The daemon-visible *outcome* is identical — a
 * runner id and the site's pinned public identity — so nothing downstream can
 * tell the difference, which is what makes this substitution honest rather
 * than a shortcut around the consent MUST.
 */
const PairFixtureRequest = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    owner: z.string().min(1),
    device: PublicIdentity,
  })
  .strict();

/** Exported so the debug page can name a device the way a human would. */
export const fingerprintOf = (identity: PublicIdentity): string =>
  keyId(identity.identity);
