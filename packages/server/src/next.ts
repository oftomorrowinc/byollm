import { createFetchHandler } from "./http.js";
import type { HandlerConfig } from "./handlers.js";

/**
 * `@byollm/server/next` — the one-file Next.js mount.
 *
 * Drop this in `app/byollm/[...route]/route.ts`:
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
 * **Then pair against the origin**: `byollm connect https://your-app.com`.
 *
 * The route has to live at `/byollm`, not under `/api`. The daemon pairs with
 * an origin — it drops any path it is given, so `https://your-app.com/api`
 * pairs with `https://your-app.com` — and calls `<origin>/byollm/<endpoint>`.
 * The handler matches the full path, not a suffix (it used to match the last
 * segment alone, so nothing ever checked where it was mounted), which means a
 * route at `app/api/byollm/[...route]/route.ts` with `basePath: "/api/byollm"`
 * is one no shipped daemon can reach today. `basePath` remains for a handler
 * something other than the daemon must find; leave it out for the daemon.
 *
 * That is the whole protocol surface. The app-facing half — enqueue, approve
 * a pairing, read a result — is {@link ByollmApp} from `@byollm/server`.
 *
 * @packageDocumentation
 */
/** What this mount needs, plus where it is mounted. */
export type NextHandlerConfig = HandlerConfig & {
  /** Where this route is mounted, when it is not `/byollm`. The daemon can
   * only reach `/byollm` on an origin (it drops any path it is given), so a
   * route that daemons pair with leaves this unset; see the example above. */
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
