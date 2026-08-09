import {
  ClaimResponse,
  HeartbeatResponse,
  PROTOCOL_VERSION,
  PairPollResponse,
  PairStartResponse,
  ReleaseResponse,
  ResultResponse,
  WireError,
  type Capability,
  type Endpoint,
  type JobOutcome,
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
      this.kind === "rate-limited" ||
      this.kind === "server-error"
    );
  }
}

export interface ClientOptions {
  /** The app's origin, e.g. `https://app.example.com`. */
  readonly origin: string;
  /** Bearer token from pairing. Absent while pairing. */
  readonly token?: string | undefined;
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
  readonly #token: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions) {
    this.#origin = options.origin.replace(/\/+$/, "");
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** A client for the same origin carrying a token. */
  withToken(token: string): ProtocolClient {
    return new ProtocolClient({
      origin: this.#origin,
      token,
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
    capabilities: readonly Capability[];
  }): Promise<PairStartResponse> {
    return this.#post("pair", PairStartResponse, {
      protocolVersion: PROTOCOL_VERSION,
      action: "start",
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
    activeJobIds: readonly string[];
    paused: boolean;
  }): Promise<HeartbeatResponse> {
    return this.#post("heartbeat", HeartbeatResponse, {
      protocolVersion: PROTOCOL_VERSION,
      runnerId: input.runnerId,
      daemonVersion: input.daemonVersion,
      capabilities: input.capabilities,
      activeJobIds: input.activeJobIds,
      paused: input.paused,
    });
  }

  async result(input: {
    runnerId: string;
    jobId: string;
    outcome: JobOutcome;
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
    jobIds: readonly string[];
    reason: "shutdown" | "pause" | "revoked" | "backend-down" | "refused";
  }): Promise<ReleaseResponse> {
    return this.#post("release", ReleaseResponse, {
      protocolVersion: PROTOCOL_VERSION,
      runnerId: input.runnerId,
      jobIds: input.jobIds,
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
    if (this.#token !== undefined) {
      headers["authorization"] = `Bearer ${this.#token}`;
    }

    let response: Response;
    try {
      response = await this.#fetch(`${this.#origin}/byollm/${endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
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
    switch (response.status) {
      case 401:
        return new ClientError("unauthorized", message, retryAfter);
      case 403:
        return new ClientError("revoked", message, retryAfter);
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
