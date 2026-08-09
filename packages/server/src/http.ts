import { ENDPOINTS, PROTOCOL_PREFIX, type Endpoint } from "@byollm/protocol";
import { ByollmHandlers, type HandlerConfig } from "./handlers.js";

/**
 * Largest protocol request body accepted, before schema validation.
 *
 * A payload is capped at 4 MB of text by the protocol; this leaves room for
 * JSON overhead and a batch of results, and refuses anything wilder at the
 * door rather than after parsing it.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Pull the endpoint name out of a URL path, or null if it isn't ours. */
export function routeEndpoint(pathname: string): Endpoint | null {
  const index = pathname.lastIndexOf("/");
  const last = index === -1 ? pathname : pathname.slice(index + 1);
  return (ENDPOINTS as readonly string[]).includes(last)
    ? (last as Endpoint)
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
  config: HandlerConfig,
): (request: Request) => Promise<Response> {
  const handlers = new ByollmHandlers(config);

  return async function handle(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return json(405, {
        error: "bad-request",
        message: "protocol endpoints accept POST only",
      });
    }

    const endpoint = routeEndpoint(new URL(request.url).pathname);
    if (endpoint === null) {
      return json(404, {
        error: "not-found",
        message: `not a ${PROTOCOL_PREFIX} endpoint`,
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
