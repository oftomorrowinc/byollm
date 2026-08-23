import { createHandler } from "@byollm/server/next";
import { siteKeysFromEnv } from "@byollm/server";
import { getStore } from "@/lib/byollm";

/**
 * The README's step 1, verbatim — byollm_014.
 *
 * **Pass a function, not an object.** `next build` imports every route module
 * to collect page data, in an environment that has no secrets. A config object
 * is constructed during that import, so the build fails on credentials it
 * cannot have. A function is not called until the first request.
 *
 * That sentence is the entire reason this file exists in CI rather than in
 * prose alone: it was true, documented, and unverified, and the pattern was
 * broken for three days before an integrator hit it.
 */
export const { POST } = createHandler(() => ({
  store: getStore(),
  siteKeys: siteKeysFromEnv("BYOLLM_SITE_KEYS"),
  verificationUrl: "https://your-app.com/settings/runners",
  // Next serves this route under /api, so say where it is mounted. The
  // handler matches the full path and will 404 without this.
  basePath: "/api/byollm",
}));
