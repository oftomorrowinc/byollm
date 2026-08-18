import {
  type ResultDisposition,
  type SealedEnvelope,
  ClaimResponse,
  FetchResponse,
  type PublicIdentity,
  HeartbeatResponse,
  PROTOCOL_VERSION,
  PairPollResponse,
  PairStartResponse,
  ReleaseResponse,
  ResultResponse,
  WireError,
  type Capability,
  type Endpoint,
} from "@byollm/protocol";
import { type z } from "zod";

/**
 * Why a protocol call failed, from the daemon's seat.
 *
 * byollm_002 requires that "server unreachable", "revoked", "no matching
 * work" and "backend down" never share a message. Three of those are
 * distinguishable here; the fourth is a local condition the loop reports
 * itself. "No matching work" is deliberately *not* an error — it is a `200`
 * with an empty list.
 */
export type ClientErrorKind =
  | "unreachable"
  | "revoked"
  | "unauthorized"
  | "rejected"
  /**
   * The server does not speak our protocol version. Its own kind because it
   * is the one refusal a retry can never fix and an upgrade always can — and
   * because a daemon that reports it as a generic rejection sends its owner
   * looking at their network.
   */
  | "version-unsupported"
  /**
   * This machine's clock is too far from the upstream's.
   *
   * Its own kind for the same reason `version-unsupported` has one: a retry
   * can never fix it and one command always can. Reported as a generic
   * `unauthorized` it sends its owner looking at their keys or their pairing,
   * neither of which is wrong — the signature was probably fine, and the
   * timestamp inside it was not.
   */
  | "clock-skew"
  /**
   * The upstream holds this job for us but has no payload to give yet.
   *
   * Only reachable off the direct plane. A direct site seals when asked,
   * because it holds the keys; a relay must wait for the site to seal to the
   * device that claimed — so "not yet" is a normal answer there, and treating
   * it as a refusal drops work the daemon legitimately still holds.
   */
  | "not-ready"
  /**
   * The upstream knows exactly who this daemon is, and is refusing anyway.
   *
   * Distinct from `unauthorized` (it does not know us) and from `revoked`
   * (this pairing is over). A device asking about a job it does not hold, or
   * an upstream that does not route for the site named, is neither of those —
   * and this client used to report all three as `revoked`, because it
   * dispatched on the 403 rather than on the code beside it. A daemon told it
   * was revoked stops for good; that is the wrong response to a refusal that
   * is about one request.
   */
  | "forbidden"
  | "rate-limited"
  | "server-error"
  | "malformed-response";

export class ClientError extends Error {
  override readonly name = "ClientError";
  constructor(
    readonly kind: ClientErrorKind,
    message: string,
    /** Seconds the server asked us to wait, when it said. */
    readonly retryAfter?: number,
  ) {
    super(message);
  }

  /** Is retrying this same call plausibly useful? */
  get retryable(): boolean {
    return (
      this.kind === "unreachable" ||
      this.kind === "not-ready" ||
      this.kind === "rate-limited" ||
      this.kind === "server-error"
    );
  }
}

export interface ClientOptions {
  /** The app's origin, e.g. `https://app.example.com`. */
  readonly origin: string;
  /** Bearer token from pairing. Absent while pairing. */
  /**
   * How this daemon proves who it is (byollm_009 §4.2).
   *
   * A signer rather than a key, so the client never holds private material
   * and the daemon decides where keys live. Absent while pairing, which is
   * the one exchange that establishes an identity rather than using one.
   */
  readonly identity?: {
    readonly runnerId: string;
    sign(input: {
      endpoint: string;
      runnerId: string;
      issuedAt: number;
      body: string;
    }): Promise<string> | string;
  };
  /** Per-request timeout. */
  readonly timeoutMs?: number;
  /** Injectable fetch, for tests. */
  readonly fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The daemon's outbound protocol client.
 *
 * Every call is outbound; nothing here ever listens. That is the whole
 * network posture of the product, and it lives in this one class.
 */
export class ProtocolClient {
  readonly #origin: string;
  readonly #identity: ClientOptions["identity"];
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions) {
    this.#origin = options.origin.replace(/\/+$/, "");
    this.#identity = options.identity;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** A client for the same origin that signs as a given runner. */
  withIdentity(
    identity: NonNullable<ClientOptions["identity"]>,
  ): ProtocolClient {
    return new ProtocolClient({
      origin: this.#origin,
      identity,
      timeoutMs: this.#timeoutMs,
      fetch: this.#fetch,
    });
  }

  get origin(): string {
    return this.#origin;
  }

  async pairStart(input: {
    version: string;
    label: string;
    platform: "darwin" | "linux" | "win32";
    /** This machine's public keys (byollm_009 §5). */
    device: PublicIdentity;
    capabilities: readonly Capability[];
  }): Promise<PairStartResponse> {
    return this.#post("pair", PairStartResponse, {
      protocolVersion: PROTOCOL_VERSION,
      action: "start",
      device: input.device,
      daemon: {
        version: input.version,
        label: input.label,
        platform: input.platform,
      },
      capabilities: input.capabilities,
    });
  }

  async pairPoll(deviceCode: string): Promise<PairPollResponse> {
    return this.#post("pair", PairPollResponse, {
      protocolVersion: PROTOCOL_VERSION,
      action: "poll",
      deviceCode,
    });
  }

  /**
   * Collect the payload for a lease this daemon holds (byollm_009 §6).
   *
   * The second half of claim-then-fetch: a claim answers with a stub, and the
   * work is collected by the device that took it.
   */
  async fetch(input: {
    runnerId: string;
    jobId: string;
    leaseId: string;
  }): Promise<FetchResponse> {
    return this.#post("fetch", FetchResponse, {
      protocolVersion: PROTOCOL_VERSION,
      runnerId: input.runnerId,
      jobId: input.jobId,
      leaseId: input.leaseId,
    });
  }

  async claim(input: {
    runnerId: string;
    capabilities: readonly Capability[];
    max: number;
  }): Promise<ClaimResponse> {
    return this.#post("claim", ClaimResponse, {
      protocolVersion: PROTOCOL_VERSION,
      runnerId: input.runnerId,
      capabilities: input.capabilities,
      max: input.max,
    });
  }

  async heartbeat(input: {
    runnerId: string;
    daemonVersion: string;
    capabilities: readonly Capability[];
    activeLeases: readonly { jobId: string; leaseId: string }[];
    paused: boolean;
  }): Promise<HeartbeatResponse> {
    return this.#post("heartbeat", HeartbeatResponse, {
      protocolVersion: PROTOCOL_VERSION,
      runnerId: input.runnerId,
      daemonVersion: input.daemonVersion,
      capabilities: input.capabilities,
      activeLeases: input.activeLeases,
      paused: input.paused,
    });
  }

  async result(input: {
    runnerId: string;
    jobId: string;
    /** The grant the work was done under — cloud_008 §1.4a. */
    leaseId: string;
    envelope: SealedEnvelope;
    disposition: ResultDisposition;
    model: string;
    backendClass: "http" | "process";
    durationMs: number;
  }): Promise<ResultResponse> {
    return this.#post("result", ResultResponse, {
      protocolVersion: PROTOCOL_VERSION,
      ...input,
    });
  }

  async release(input: {
    runnerId: string;
    leases: readonly { jobId: string; leaseId: string }[];
    reason: "shutdown" | "pause" | "revoked" | "backend-down" | "refused";
  }): Promise<ReleaseResponse> {
    return this.#post("release", ReleaseResponse, {
      protocolVersion: PROTOCOL_VERSION,
      runnerId: input.runnerId,
      leases: input.leases,
      reason: input.reason,
    });
  }

  async #post<T>(
    endpoint: Endpoint,
    schema: z.ZodType<T>,
    body: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };

    // Serialise once and sign exactly those bytes. Signing a re-serialised
    // copy would sign something the server never receives.
    const rawBody = JSON.stringify(body);
    if (this.#identity !== undefined) {
      const issuedAt = Date.now();
      headers["x-byollm-runner"] = this.#identity.runnerId;
      headers["x-byollm-issued-at"] = String(issuedAt);
      headers["x-byollm-signature"] = await this.#identity.sign({
        endpoint,
        runnerId: this.#identity.runnerId,
        issuedAt,
        body: rawBody,
      });
    }

    let response: Response;
    try {
      response = await this.#fetch(`${this.#origin}/byollm/${endpoint}`, {
        method: "POST",
        headers,
        body: rawBody,
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      // No response at all: the server is unreachable. Distinct from every
      // answer it could have given us, including a refusal.
      throw new ClientError(
        "unreachable",
        `could not reach ${this.#origin} (${error instanceof Error ? error.message : "unknown error"})`,
      );
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? {} : JSON.parse(text);
    } catch {
      throw new ClientError(
        "malformed-response",
        `${this.#origin} returned HTTP ${String(response.status)} with a body that is not JSON`,
      );
    }

    if (!response.ok) {
      throw this.#toError(response, parsed);
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      // A server whose response does not match the protocol is not one we can
      // safely guess about.
      throw new ClientError(
        "malformed-response",
        `${this.#origin} returned a ${endpoint} response that does not match protocol v${PROTOCOL_VERSION}`,
      );
    }
    return result.data;
  }

  #toError(response: Response, body: unknown): ClientError {
    const wire = WireError.safeParse(body);
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfter =
      wire.success && wire.data.retryAfter !== undefined
        ? wire.data.retryAfter
        : retryAfterHeader !== null && /^\d+$/.test(retryAfterHeader)
          ? Number(retryAfterHeader)
          : undefined;

    const message = wire.success
      ? wire.data.message
      : `${this.#origin} returned HTTP ${String(response.status)}`;

    if (wire.success && wire.data.error === "revoked") {
      return new ClientError("revoked", message, retryAfter);
    }
    if (
      typeof body === "object" &&
      body !== null &&
      (body as { error?: unknown }).error === "unsupported-protocol-version"
    ) {
      // The server already composed a message naming the fix; pass it through
      // rather than paraphrasing it into something vaguer.
      return new ClientError("version-unsupported", message, retryAfter);
    }
    if (
      typeof body === "object" &&
      body !== null &&
      (body as { error?: unknown }).error === "clock-skew"
    ) {
      // The upstream sends its own time, so the message can name the drift
      // rather than the symptom. A number a person can act on beats a
      // sentence they have to interpret.
      const serverTime = (body as { serverTime?: unknown }).serverTime;
      const drift =
        typeof serverTime === "number"
          ? ` This machine is ${describeDrift(Date.now() - serverTime)}.`
          : "";
      return new ClientError(
        "clock-skew",
        `${message}.${drift} ${syncTimeCommand()}`,
        retryAfter,
      );
    }
    switch (response.status) {
      case 401:
        return new ClientError("unauthorized", message, retryAfter);
      case 403:
        // `revoked` is decided by the code above, never by the status —
        // cloud_008 §1.4d. Every 403 used to land here and be reported as a
        // revocation, so a site-plane refusal about a single request looked
        // to a daemon exactly like its pairing being torn up.
        return new ClientError("forbidden", message, retryAfter);
      case 409:
        return new ClientError("not-ready", message, retryAfter);
      case 429:
        return new ClientError("rate-limited", message, retryAfter);
      case 400:
      case 404:
        // Never retried: the request is wrong, and repeating it stays wrong.
        return new ClientError("rejected", message, retryAfter);
      default:
        return response.status >= 500
          ? new ClientError("server-error", message, retryAfter)
          : new ClientError("rejected", message, retryAfter);
    }
  }
}

/**
 * How far off, in words somebody can act on.
 *
 * "7 minutes ahead" tells a person to look at their clock. "clock skew
 * detected" tells them to search for the phrase.
 */
/**
 * How to fix it, for the machine this is running on.
 *
 * The upstream can say *how far off* — it knows its own time. It cannot say
 * *what to run*, because it has no idea what this machine is. So the sentence
 * is composed here, which is byollm_013's rule about which side names the fix.
 *
 * Turning on time sync rather than setting the clock once: a clock that
 * drifted far enough to be refused will drift again, and `date -s` fixes today
 * only. These are the commands that make it stop happening.
 */
function syncTimeCommand(): string {
  switch (process.platform) {
    case "darwin":
      return "Turn on network time: `sudo sntp -sS time.apple.com`, or System Settings → General → Date & Time → Set automatically.";
    case "win32":
      return "Turn on network time: `w32tm /resync`, or Settings → Time & language → Set time automatically.";
    default:
      return "Turn on network time: `sudo timedatectl set-ntp true` (or install chrony/ntpd).";
  }
}

function describeDrift(ms: number): string {
  const seconds = Math.round(Math.abs(ms) / 1000);
  const amount =
    seconds < 120
      ? `${String(seconds)} seconds`
      : `${String(Math.round(seconds / 60))} minutes`;
  return `${amount} ${ms > 0 ? "ahead of" : "behind"} the server`;
}
