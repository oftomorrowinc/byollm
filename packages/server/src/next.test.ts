import {
  PROTOCOL_VERSION,
  generateKeys,
  publicIdentityOf,
} from "@byollm/protocol";
import { describe, expect, it } from "vitest";
import { generateSiteKeys } from "./keys.js";
import { MemoryStore } from "./memory.js";
import { createHandler } from "./next.js";

/**
 * The Next.js mount is the one file a developer copies, so its shape is part
 * of the contract: what they destructure has to exist and behave.
 */
describe("createHandler — the one-file Next mount", () => {
  const handler = () =>
    createHandler({
      store: new MemoryStore(),
      verificationUrl: "https://app.test/settings/runners",
      siteKeys: generateSiteKeys(),
      // What the docstring tells a Next user to write: this route lives at
      // `app/api/byollm/[...route]`, so it is served under /api.
      basePath: "/api/byollm",
    });

  it("exports POST, GET and a dynamic marker", () => {
    const mounted = handler();
    expect(typeof mounted.POST).toBe("function");
    expect(typeof mounted.GET).toBe("function");
    // Route handlers must not be cached — every call mutates lease state.
    expect(mounted.dynamic).toBe("force-dynamic");
  });

  it("serves the protocol through POST", async () => {
    const response = await handler().POST(
      new Request("https://app.test/api/byollm/pair", {
        method: "POST",
        body: JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          action: "start",
          daemon: { version: "0.1.0", label: "mbp", platform: "darwin" },
          device: publicIdentityOf(generateKeys(Date.now())),
          capabilities: [],
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { verificationUrl: string };
    expect(body.verificationUrl).toBe("https://app.test/settings/runners");
  });

  it("gives a stray GET a clear 405 rather than a framework 404", async () => {
    const response = await handler().GET(
      new Request("https://app.test/api/byollm/claim"),
    );
    expect(response.status).toBe(405);
  });
});

/**
 * Issue #4, reproduced against a real `next build` before it was fixed:
 * "Failed to collect page data for /api/byollm/[...route]".
 *
 * `next build` imports every route module to collect page data, in an
 * environment with no secrets. A config *object* is therefore constructed at
 * build time, and anything it needs — a service-role key, a site identity —
 * has to exist during the build, which it does not.
 *
 * Passing a function moves construction to the first request. These tests
 * assert the property that failure depended on, so it cannot come back
 * without a real Next install in CI to notice.
 */
describe("a config function is not called until a request arrives", () => {
  const lazyMount = () => {
    let calls = 0;
    const mounted = createHandler(() => {
      calls += 1;
      return {
        store: new MemoryStore(),
        verificationUrl: "https://app.test/settings/runners",
        siteKeys: generateSiteKeys(),
        basePath: "/api/byollm",
      };
    });
    return { mounted, calls: () => calls };
  };

  const pair = () =>
    new Request("https://app.test/api/byollm/pair", {
      method: "POST",
      body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        action: "start",
        daemon: { version: "0.1.0", label: "mbp", platform: "darwin" },
        device: publicIdentityOf(generateKeys(Date.now())),
        capabilities: [],
      }),
    });

  it("does not build anything at import time", () => {
    const { calls } = lazyMount();
    // This is the whole bug: at this point `next build` has imported the
    // module and expects to be finished with it.
    expect(calls()).toBe(0);
  });

  it("builds once, on the first request, and keeps it", async () => {
    const { mounted, calls } = lazyMount();

    expect((await mounted.POST(pair())).status).toBe(200);
    expect(calls()).toBe(1);

    // Rebuilding per request would mean a new store — and for a real adapter,
    // a new connection pool — on every protocol call.
    expect((await mounted.POST(pair())).status).toBe(200);
    expect(calls()).toBe(1);
  });

  it("still accepts a plain object, for a store that needs no secrets", async () => {
    const mounted = createHandler({
      store: new MemoryStore(),
      verificationUrl: "https://app.test/settings/runners",
      siteKeys: generateSiteKeys(),
      basePath: "/api/byollm",
    });
    expect((await mounted.POST(pair())).status).toBe(200);
  });
});
