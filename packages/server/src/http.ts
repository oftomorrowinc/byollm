import {
  ENDPOINTS,
  ERROR_STATUS,
  PROTOCOL_PREFIX,
  checkProtocolVersion,
  type Endpoint,
} from "@byollm/protocol";
import { ByollmHandlers, type HandlerConfig } from "./handlers.js";

/**
 * Largest protocol request body accepted, before schema validation.
 *
 * A payload is capped at 4 MB of text by the protocol; this leaves room for
 * JSON overhead and a batch of results, and refuses anything wilder at the
 * door rather than after parsing it.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Where the protocol endpoints are mounted.
 *
 * Defaults to {@link PROTOCOL_PREFIX}. Pass the real mount point when it is
 * anything else — a Next.js route at `app/api/byollm/[...route]/route.ts`
 * serves `/api/byollm/...`, so it needs `basePath: "/api/byollm"`.
 *
 * @throws if the path is not an absolute, single-segment-per-slash path. A
 * mount point is configuration, and a malformed one should fail at startup
 * rather than silently match nothing.
 */
function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  if (!trimmed.startsWith("/")) {
    throw new Error(`basePath must start with "/": got ${basePath}`);
  }
  if (trimmed.includes("//") || /[?#*]/.test(trimmed)) {
    throw new Error(`basePath must be a plain path: got ${basePath}`);
  }
  return trimmed;
}

/**
 * Pull the endpoint name out of a URL path, or null if it isn't ours.
 *
 * The full path must match `<basePath>/<endpoint>` exactly. This used to
 * compare only the *last* segment, which meant `/anything/at/all/claim`
 * dispatched to `claim` and {@link PROTOCOL_PREFIX} was decorative — it
 * appeared in a 404 message and was never matched against. For the handler
 * that serves claim, result and heartbeat, dispatching on a suffix is a
 * looser rule than anyone reading the constant would assume, and loose
 * matching in a security surface should at least be a decision.
 *
 * The cost is that the mount point is now something a deployment has to state
 * rather than something that works by accident. That is the intended trade:
 * a 404 at startup naming the mount point beats a handler answering on paths
 * nobody meant to expose.
 */
export function routeEndpoint(
  pathname: string,
  basePath: string = PROTOCOL_PREFIX,
): Endpoint | null {
  const base = normalizeBasePath(basePath);
  const path = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (!path.startsWith(`${base}/`)) return null;
  const rest = path.slice(base.length + 1);
  return (ENDPOINTS as readonly string[]).includes(rest)
    ? (rest as Endpoint)
    : null;
}

/** Read the bearer token from an `Authorization` header. */
export function bearerFrom(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * A `Request` → `Response` handler for the whole protocol.
 *
 * Web-standard types, so this works unchanged in Next.js route handlers, Hono,
 * Bun, Deno, Cloudflare Workers, and anything else that speaks fetch.
 */
export function createFetchHandler(
  config: HandlerConfig & {
    /**
     * Where these endpoints are mounted. Defaults to
     * {@link PROTOCOL_PREFIX}; set it when the app serves them elsewhere.
     */
    readonly basePath?: string;
  },
): (request: Request) => Promise<Response> {
  const handlers = new ByollmHandlers(config);
  // Validate once, at construction: a bad mount point is a deployment bug and
  // should surface when the server starts, not as a silent 404 per request.
  const basePath = normalizeBasePath(config.basePath ?? PROTOCOL_PREFIX);

  return async function handle(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return json(405, {
        error: "bad-request",
        message: "protocol endpoints accept POST only",
      });
    }

    const endpoint = routeEndpoint(new URL(request.url).pathname, basePath);
    if (endpoint === null) {
      return json(404, {
        error: "not-found",
        message: `not a ${basePath} endpoint`,
      });
    }

    const declared = request.headers.get("content-length");
    if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
      return json(400, {
        error: "bad-request",
        message: "request body too large",
      });
    }

    let body: unknown;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY_BYTES) {
        return json(400, {
          error: "bad-request",
          message: "request body too large",
        });
      }
      body = JSON.parse(text);
    } catch {
      // Deliberately not echoing the parse error: it would quote attacker
      // input back into a response an operator later reads in a terminal.
      return json(400, {
        error: "bad-request",
        message: "request body is not valid JSON",
      });
    }

    // byollm_009 §4: version before anything else. A mismatch must name the
    // disagreement and the fix, not surface as a generic bad-request from a
    // schema literal buried in an endpoint — which is what happened before,
    // and is why "the connection is versionless" was listed as a defect.
    const refusal = checkProtocolVersion(body);
    if (refusal) {
      return json(ERROR_STATUS[refusal.error], refusal);
    }

    const result = await handlers.handle(
      endpoint,
      body,
      bearerFrom(request.headers.get("authorization")),
    );

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "cache-control": "no-store",
    };
    if (result.retryAfterSeconds !== undefined) {
      headers["retry-after"] = String(result.retryAfterSeconds);
    }
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers,
    });
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
