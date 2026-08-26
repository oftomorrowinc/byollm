import { checkProtocolVersion, declaredVersion } from "@byollm/protocol";
import { DaemonPlane, type PlaneResult } from "./daemon-plane.js";
import { debugPage } from "./debug.js";
import { Projection, type RelayFixture } from "./fixture.js";
import { MemoryPairingCodes, type PairingCodes } from "./pairing-codes.js";
import { SitePlane } from "./site-plane.js";
import { RelayState } from "./state.js";
import type { RoutingStore } from "./store.js";

/**
 * `@byollm/relay` — the reference relay (cloud_004 §14).
 *
 * A blind relay between byollm sites and daemons: it routes stubs, hands over
 * sealed envelopes it cannot open, and knows who is online. It is the first
 * consumer of byollm_009's session layer that is neither the site nor the
 * device, which makes it the thing that proves the protocol's central claim.
 *
 * ## Why this ships open
 *
 * It is the conformance kit's reference relay, and the kit is public — so it
 * starts where it ends rather than being written closed and ported. A relay
 * that claims to be blind should be readable by the people trusting it, and a
 * third-party daemon testing hub mode should test against real code rather
 * than a mock of it. The production hub — multi-tenant routing, presence at
 * scale, billing, ops — is built on these same interfaces and is not this.
 *
 * ## Blind by construction, not by policy
 *
 * {@link RelayOptions} has no field that can hold a private key, and no type
 * in this package has one either. `RELAY_BLIND` is therefore not a rule the
 * code follows; it is a shape the code has. The only way to make this relay
 * able to read a payload is to change its types, which is a review someone
 * would have to justify rather than a line someone could slip in.
 */

export interface RelayOptions {
  /**
   * Which site this relay routes for.
   *
   * One, in the skeleton. Multi-tenant routing is the closed piece
   * (cloud_004 §9), and it replaces this field rather than extending it.
   */
  /** Consent and rosters, projected from the control plane. */
  readonly fixture?: RelayFixture;
  /**
   * The control plane's roster-signing public key — Amendment G.
   *
   * Handed to daemons at pairing. Public half only: this relay cannot sign a
   * roster, which is what makes carrying one safe.
   */
  readonly controlPlanePublic?: string | undefined;
  /** How long a claim is good for. */
  readonly leaseMs?: number;
  /** Injectable clock, so tests move time instead of sleeping. */
  readonly now?: () => number;
  /**
   * Where pending pairing codes live — cloud_009's device-code flow.
   *
   * Defaults to an in-memory store, which is right for the reference relay
   * and wrong for a hub: two replicas mean a code minted on one must be
   * pollable on the other, the same reason the routing store is not a `Map`.
   */
  readonly pairingCodes?: PairingCodes;
  /**
   * Where a human approves a code. The control plane's own URL.
   *
   * Given rather than derived: the relay cannot approve anything, because
   * approving is looking at a fingerprint while signed in and that session
   * lives in the dashboard. Absent, the device-code flow is refused as
   * unsupported rather than pointed somewhere useless.
   */
  readonly verificationUrl?: string;
  /** Where the daemon plane is mounted. */
  readonly basePath?: string;
  /**
   * Serve `/debug`, which is off unless somebody asks for it.
   *
   * The page shows every routed job for a site, its state, who claimed it and
   * how long its timers have left. It shows no prompt or result text — the
   * relay does not have them — and it is genuinely useful when a route is
   * behaving strangely.
   *
   * It is also, on anything reachable from the internet, an anonymous read of
   * exactly the metadata the site plane exists to protect. That was finding
   * eleven, found by curling a deployed hub. The hub refuses the route
   * outright; this package used to serve it by default and leave `D005` to
   * warn whoever deployed it, which is a default that fails safe only if
   * somebody reads the audit.
   *
   * So: off, and per-site when on (cloud_009 §3 — the debug page is per-site
   * or it is nothing). `D005` still fails for a relay that turned it on,
   * which is the audit doing its job for an operator who made a choice rather
   * than warning everybody about a default.
   */
  readonly debug?: boolean;
  /**
   * Where routing state lives — cloud_006.
   *
   * Defaults to an in-process {@link RelayState}, which is correct for one
   * replica and is what this package ships. A hub running more than one
   * replica supplies a shared implementation of {@link RoutingStore} instead;
   * `packages/relay/test/two-replicas.test.ts` is why that is not optional.
   *
   * **The implementation is deliberately not in this package.** A Valkey
   * client is a dependency every consumer would carry to get a feature only a
   * multi-replica deployment uses, and the production hub is the closed piece
   * (cloud_001). What ships here is the interface, the reference
   * implementation, and the tests that say what an implementation must
   * guarantee.
   */
  readonly store?: RoutingStore;
}

/** A running relay: one fetch handler, two planes, one debug page. */
export class Relay {
  readonly state: RoutingStore;
  readonly projection: Projection;
  readonly #daemon: DaemonPlane;
  readonly #site: SitePlane;
  readonly #now: () => number;
  readonly #basePath: string;
  readonly #debug: boolean;

  constructor(options: RelayOptions) {
    this.state =
      options.store ?? new RelayState({ now: options.now ?? Date.now });
    this.projection = new Projection(options.fixture);
    this.#now = options.now ?? Date.now;
    this.#basePath = (options.basePath ?? "/byollm").replace(/\/+$/, "");
    this.#debug = options.debug ?? false;
    this.#daemon = new DaemonPlane({
      state: this.state,
      projection: this.projection,
      now: this.#now,
      leaseMs: options.leaseMs ?? 60_000,
      pairingCodes:
        options.pairingCodes ?? new MemoryPairingCodes(() => this.#now()),
      ...(options.verificationUrl === undefined
        ? {}
        : { verificationUrl: options.verificationUrl }),
      ...(options.controlPlanePublic === undefined
        ? {}
        : { controlPlanePublic: options.controlPlanePublic }),
    });
    this.#site = new SitePlane({
      state: this.state,
      projection: this.projection,
      now: this.#now,
    });
  }

  /** Replace the projection — a control-plane push, or a fixture edit. */
  project(fixture: RelayFixture): void {
    this.projection.replace(fixture);
  }

  /**
   * Fire due timers and report what moved.
   *
   * Exposed rather than run on an interval so a test can drive it, and so the
   * production hub can decide its own scheduling. The relay never needs a
   * timer to be *correct* — every read path sweeps first — but a job whose
   * site vanished should return to the queue without waiting for someone to
   * ask about it.
   */
  async sweep(): Promise<{ requeued: string[] }> {
    const requeued = await this.state.sweep();
    return { requeued: requeued.map((j) => j.id) };
  }

  /** The whole HTTP surface. */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/debug" || path === `${this.#basePath}/debug`) {
      // **Per-site or nothing** — cloud_009 §3, ratified. A page that reads
      // every tenant's state through one door is finding eleven wearing a
      // different hat: the anonymous read of who-is-online and
      // which-device-holds-what, rebuilt after being closed. So the site is a
      // parameter, and without one there is no page rather than a page
      // showing everything.
      const siteId = url.searchParams.get("site");
      if (!this.#debug) {
        // No such route. `not-found` rather than `forbidden`, because there
        // is no credential that would work and saying "forbidden" advertises
        // a door that does not open.
        return new Response(JSON.stringify({ error: "not-found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (siteId === null || this.projection.siteFor(siteId) === null) {
        // **A different answer, deliberately.** `D005` probes this path with
        // no site id, and a 404 here would tell it there is no debug surface
        // when there is one behind a parameter — a check passing for a reason
        // unrelated to the property, in the audit written to catch that.
        //
        // The same answer for "no site named" and "a site I do not hold", so
        // this cannot be used to ask which sites exist.
        return new Response(JSON.stringify({ error: "bad-request" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        await debugPage(this.state, this.#now(), {
          siteId,
          consents: (owner) =>
            this.projection.consentFor(owner, siteId) !== null,
        }),
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    const rawBody = request.method === "POST" ? await request.text() : "";
    const body = rawBody === "" ? undefined : safeJson(rawBody);
    const endpoint = path.slice(path.lastIndexOf("/") + 1);
    const auth = {
      endpoint,
      rawBody,
      signature: signatureFrom(request.headers, "x-byollm-runner"),
    };
    // **The handshake, before anything else** — byollm_009 §B.4.
    //
    // The direct server has done this since its own version defect was found;
    // this relay never did, so every mismatch on every endpoint arrived as a
    // bare `bad-request` from a `z.literal` buried in a schema — a daemon and
    // a relay discovering they disagreed by failing, with nothing in the
    // answer naming the disagreement or the fix.
    //
    // One helper, both planes, every endpoint. The first attempt at this
    // refused every site request in the suite, because the site plane's
    // requests carried no version at all: the check was right and the wire was
    // incomplete, which is why B.4 was written down rather than patched at
    // 4 a.m. The site plane declares a version now.
    //
    // Health and the debug page are above this line deliberately: they are not
    // protocol endpoints, and a probe that has to speak the version to ask
    // whether the process is alive is a probe that stops working on the day
    // the version moves.
    // **Protocol paths only.** An unknown path is a 404, not a lecture about
    // versions: written the other way first, and a request for `/healthz` —
    // or anything a scanner tries — came back with what this relay speaks and
    // how to upgrade. The handshake is part of the protocol, not of the HTTP
    // surface, and answering it for a path that does not exist both misleads
    // the caller and describes us to somebody who was only knocking.
    if (path.startsWith("/byollm/") || path.startsWith("/relay/")) {
      const refusal = checkProtocolVersion({
        protocolVersion: declaredVersion({ body, query: url.searchParams }),
      });
      if (refusal) return json({ status: 400, body: refusal });
    }

    // The caller header differs by plane, so a signature meant for one can
    // never be presented to the other by moving the request. The endpoint's
    // domain separator (`site/…`) already covers this; the header makes it
    // true at parse time rather than at verification time.
    const siteAuth = {
      endpoint,
      rawBody,
      signature: signatureFrom(request.headers, "x-byollm-site"),
    };

    // -- the site plane -----------------------------------------------------
    if (path === "/relay/site/enqueue") {
      return json(await this.#site.enqueue(siteAuth, body));
    }
    if (path === "/relay/site/payload") {
      return json(await this.#site.payload(siteAuth, body));
    }
    if (path === "/relay/site/cancel") {
      return json(await this.#site.cancel(siteAuth, body));
    }
    if (path === "/relay/site/pending") {
      return json(
        await this.#site.pending(
          siteAuth,
          url.searchParams.get("siteId") ?? "",
        ),
      );
    }
    if (path === "/relay/site/results") {
      return json(
        await this.#site.results(
          siteAuth,
          url.searchParams.get("siteId") ?? "",
        ),
      );
    }

    // -- the daemon plane ---------------------------------------------------
    if (!path.startsWith(`${this.#basePath}/`)) {
      return json({ status: 404, body: { error: "not-found" } });
    }
    switch (auth.endpoint) {
      case "pair":
        return json(await this.#daemon.pair(body));
      case "claim":
        return json(await this.#daemon.claim(auth, body));
      case "fetch":
        return json(await this.#daemon.fetch(auth, body));
      case "result":
        return json(await this.#daemon.result(auth, body));
      case "heartbeat":
        return json(await this.#daemon.heartbeat(auth, body));
      case "release":
        return json(await this.#daemon.release(auth, body));
      default:
        return json({ status: 404, body: { error: "not-found" } });
    }
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Rebuild the signature from headers, refusing anything partial. */
function signatureFrom(headers: Headers, callerHeader: string): unknown {
  const runnerId = headers.get(callerHeader);
  const issuedAt = headers.get("x-byollm-issued-at");
  const signature = headers.get("x-byollm-signature");
  // Checked before `Number()`, which turns a missing header into the epoch —
  // a stale-timestamp check that silently passes is worse than none.
  if (runnerId === null || issuedAt === null || signature === null) {
    return undefined;
  }
  return { runnerId, issuedAt: Number(issuedAt), signature };
}

const json = (result: PlaneResult): Response =>
  new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { "content-type": "application/json" },
  });

export { Projection, RelayState, debugPage };
export type { RoutingStore } from "./store.js";
export type { RelayFixture };
export {
  ConsentRecord,
  DeviceRecord,
  RevocationRecord,
  RosterRecord,
  SiteRecord,
  RelayFixture as RelayFixtureSchema,
  EMPTY_FIXTURE,
} from "./fixture.js";
export { AWAITING_PAYLOAD_MS } from "./state.js";
/**
 * How a (site, owner) route is written — cloud_009 §3.
 *
 * Exported because a store in another repository builds the same set and has
 * to agree on the encoding. Spelling it out on both sides is two statements
 * of one format, which is the bug the routes set exists to remove one level
 * up: the hub's Valkey store and this package's memory store must match
 * character for character or a claim silently returns nothing.
 */
export { routeKey } from "./state.js";
/**
 * Everything an implementer of {@link RoutingStore} needs.
 *
 * `ClaimInput` and `HolderRefusal` were missing from this list, which made the
 * interface unimplementable outside this package — found by writing the second
 * implementation, which is the only thing that could have found it. An
 * exported interface whose parameter types are private is a contract nobody
 * can sign.
 *
 * It happened again with `ReleaseReason` (cloud_008 §2.1), added to
 * `releaseLeases` and not to this list, and found the same way: the hub
 * failed to compile. A docstring recording a lesson is not a check, which is
 * why `store-contract.test-d.ts` implements `RoutingStore` from the package
 * entry point alone.
 *
 * **And a third time, with `Grant` (V1-3) — through the check.** Declaring a
 * `RoutingStore` only requires `RoutingStore` to be exported; a *return* type
 * is reachable structurally without being nameable, so the check caught
 * nothing and the hub caught it a release later. The restated signatures
 * below the declaration are the part that bites, and they were a list
 * somebody had to remember to extend.
 *
 * A list of signatures is the same shape as this list of exports: correct
 * until the next member. `store-contract.test-d.ts` now restates every method
 * whose parameters or results are named types, `renewLeases` and
 * `cancelRequests` included.
 */
export type {
  ClaimInput,
  HolderRefusal,
  Presence,
  ReleaseReason,
  RoutedJob,
  RoutedState,
} from "./state.js";

/** The grant a lease-scoped answer names — V1-3. */
export type { Grant } from "./store.js";

export {
  MAX_OUTSTANDING_PAIRINGS,
  MemoryPairingCodes,
  PAIRING_BUSY_MESSAGE,
  PAIRING_CODE_TTL_MS,
  newDeviceCode,
  newUserCode,
  type PairingCodes,
  type PendingPairing,
  // `put` returns it, so an implementor outside this package needs to be able
  // to name it. Four separate releases have shipped a public option whose type
  // was not exported; the type test next door is what makes the fifth fail
  // here instead of in somebody else's build.
  type PutResult,
} from "./pairing-codes.js";
