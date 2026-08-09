import { createFetchHandler } from "./http.js";
import type { HandlerConfig } from "./handlers.js";

/**
 * `@byollm/server/next` — the one-file Next.js mount.
 *
 * Drop this in `app/api/byollm/[...route]/route.ts`:
 *
 * ```ts
 * import { createHandler } from "@byollm/server/next";
 * import { store } from "@/lib/byollm";
 *
 * export const { POST } = createHandler({
 *   store,
 *   verificationUrl: "https://your-app.com/settings/runners",
 * });
 * ```
 *
 * That is the whole protocol surface. The app-facing half — enqueue, approve
 * a pairing, read a result — is {@link ByollmApp} from `@byollm/server`.
 *
 * @packageDocumentation
 */
export function createHandler(config: HandlerConfig): {
  POST: (request: Request) => Promise<Response>;
  /** Present so a stray GET gets a clear 405 rather than a framework 404. */
  GET: (request: Request) => Promise<Response>;
  /** Route handlers must not be cached — every call mutates lease state. */
  dynamic: "force-dynamic";
} {
  const handler = createFetchHandler(config);
  return {
    POST: handler,
    GET: handler,
    dynamic: "force-dynamic",
  };
}

export type { HandlerConfig };
