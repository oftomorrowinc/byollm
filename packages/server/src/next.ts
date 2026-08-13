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
 *   // Next serves this route under /api, so say so. The handler matches the
 *   // full path, not a suffix, and will 404 without it.
 *   basePath: "/api/byollm",
 * });
 * ```
 *
 * **Then pair against that same path**: `byollm connect https://your-app.com/api`.
 * The daemon appends `/byollm/<endpoint>` to whatever origin it is given, so
 * connecting to the bare domain reaches `/byollm/claim` and finds nothing.
 * This is the first thing an integrator gets wrong, and it used to fail as a
 * silent 404 — the handler matched on the last path segment alone, so nothing
 * ever checked where it was mounted.
 *
 * To serve at `/byollm` instead, move the route to
 * `app/byollm/[...route]/route.ts`, drop `basePath`, and pair against the bare
 * domain.
 *
 * That is the whole protocol surface. The app-facing half — enqueue, approve
 * a pairing, read a result — is {@link ByollmApp} from `@byollm/server`.
 *
 * @packageDocumentation
 */
export function createHandler(
  config: HandlerConfig & {
    /** Where this route is mounted. Next users almost always want
     * `"/api/byollm"`; see the example above. */
    readonly basePath?: string;
  },
): {
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
