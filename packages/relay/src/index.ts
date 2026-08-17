import { DaemonPlane, type PlaneResult } from "./daemon-plane.js";
import { debugPage } from "./debug.js";
import { Projection, type RelayFixture } from "./fixture.js";
import { SitePlane } from "./site-plane.js";
import { RelayState } from "./state.js";

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
  readonly siteId: string;
  /** Consent and rosters, projected from the control plane. */
  readonly fixture?: RelayFixture;
  /** How long a claim is good for. */
  readonly leaseMs?: number;
  /** Injectable clock, so tests move time instead of sleeping. */
  readonly now?: () => number;
  /** Where the daemon plane is mounted. */
  readonly basePath?: string;
}

/** A running relay: one fetch handler, two planes, one debug page. */
export class Relay {
  readonly state: RelayState;
  readonly projection: Projection;
  readonly #daemon: DaemonPlane;
  readonly #site: SitePlane;
  readonly #now: () => number;
  readonly #basePath: string;

  constructor(options: RelayOptions) {
    this.state = new RelayState();
    this.projection = new Projection(options.fixture);
    this.#now = options.now ?? Date.now;
    this.#basePath = (options.basePath ?? "/byollm").replace(/\/+$/, "");
    this.#daemon = new DaemonPlane({
      state: this.state,
      projection: this.projection,
      now: this.#now,
      leaseMs: options.leaseMs ?? 60_000,
      siteId: options.siteId,
    });
    this.#site = new SitePlane({
      state: this.state,
      projection: this.projection,
      now: this.#now,
      routesFor: options.siteId,
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
  sweep(): { requeued: string[] } {
    return { requeued: this.state.sweep(this.#now()).map((j) => j.id) };
  }

  /** The whole HTTP surface. */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/debug" || path === `${this.#basePath}/debug`) {
      return new Response(debugPage(this.state, this.#now()), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    const rawBody = request.method === "POST" ? await request.text() : "";
    const body = rawBody === "" ? undefined : safeJson(rawBody);
    const endpoint = path.slice(path.lastIndexOf("/") + 1);
    const auth = {
      endpoint,
      rawBody,
      signature: signatureFrom(request.headers, "x-byollm-runner"),
    };
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
      return json(this.#site.enqueue(siteAuth, body));
    }
    if (path === "/relay/site/payload") {
      return json(this.#site.payload(siteAuth, body));
    }
    if (path === "/relay/site/pending") {
      return json(
        this.#site.pending(siteAuth, url.searchParams.get("siteId") ?? ""),
      );
    }
    if (path === "/relay/site/results") {
      return json(
        this.#site.results(siteAuth, url.searchParams.get("siteId") ?? ""),
      );
    }

    // -- the daemon plane ---------------------------------------------------
    if (!path.startsWith(`${this.#basePath}/`)) {
      return json({ status: 404, body: { error: "not-found" } });
    }
    switch (auth.endpoint) {
      case "pair":
        return json(this.#daemon.pair(body));
      case "claim":
        return json(this.#daemon.claim(auth, body));
      case "fetch":
        return json(this.#daemon.fetch(auth, body));
      case "result":
        return json(this.#daemon.result(auth, body));
      case "heartbeat":
        return json(this.#daemon.heartbeat(auth, body));
      case "release":
        return json(this.#daemon.release(auth, body));
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
export type { RoutedJob, RoutedState, Presence } from "./state.js";
