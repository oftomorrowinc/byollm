import { createFetchHandler } from "./http.js";
import type { HandlerConfig } from "./handlers.js";

/**
 * `@byollm/server/next` — the one-file Next.js mount.
 *
 * Drop this in `app/api/byollm/[...route]/route.ts`:
 *
 * ```ts
 * import { createHandler } from "@byollm/server/next";
 * import { siteKeysFromEnv } from "@byollm/server";
 * import { getStore } from "@/lib/byollm";
 *
 * export const { POST } = createHandler(() => ({
 *   store: getStore(),
 *   siteKeys: siteKeysFromEnv("BYOLLM_SITE_KEYS"),
 *   verificationUrl: "https://your-app.com/settings/runners",
 *   // Next serves this route under /api, so say so. The handler matches the
 *   // full path, not a suffix, and will 404 without it.
 *   basePath: "/api/byollm",
 * }));
 * ```
 *
 * **Pass a function, not an object.** `next build` imports every route module
 * to collect page data, in an environment that has no secrets — so a config
 * *object* means the store and the site keys are constructed at build time,
 * and the build fails on the credentials it cannot have. A function is not
 * called until the first request, so importing this module does nothing.
 *
 * An object still works, for a store that needs no secrets to construct. It is
 * the second form because it is the one that fails in production and not in
 * development, which is the wrong way round for a default.
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
/** What this mount needs, plus where it is mounted. */
export type NextHandlerConfig = HandlerConfig & {
  /** Where this route is mounted. Next users almost always want
   * `"/api/byollm"`; see the example above. */
  readonly basePath?: string;
};

export function createHandler(
  config: NextHandlerConfig | (() => NextHandlerConfig),
): {
  POST: (request: Request) => Promise<Response>;
  /** Present so a stray GET gets a clear 405 rather than a framework 404. */
  GET: (request: Request) => Promise<Response>;
  /** Route handlers must not be cached — every call mutates lease state. */
  dynamic: "force-dynamic";
} {
  // Built on the first request and kept, not rebuilt per call: the handlers
  // hold a store and a lease clock, and a fresh instance per request would be
  // a new connection pool per request.
  let built: ((request: Request) => Promise<Response>) | undefined;
  const handler = (request: Request): Promise<Response> => {
    built ??= createFetchHandler(
      typeof config === "function" ? config() : config,
    );
    return built(request);
  };

  return {
    POST: handler,
    GET: handler,
    dynamic: "force-dynamic",
  };
}

export type { HandlerConfig };
