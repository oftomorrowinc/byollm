import {
  MAX_ENVELOPE_BYTES,
  PROTOCOL_VERSION,
  generateKeys,
  publicIdentityOf,
} from "@byollm/protocol";
import { describe, expect, it } from "vitest";
import { createFetchHandler, routeEndpoint, signatureFrom } from "./http.js";
import { generateSiteKeys } from "./keys.js";
import { MemoryStore } from "./memory.js";

// A Next-style mount, stated rather than inferred — which is the point of
// `basePath`. These tests used to reach the handler at this path with no
// configuration at all, because matching was on the last segment.
const MOUNT = "/api/byollm";
const url = (endpoint: string) => `https://app.test${MOUNT}/${endpoint}`;

function handler() {
  return createFetchHandler({
    store: new MemoryStore(),
    verificationUrl: "https://app.test/settings/runners",
    siteKeys: generateSiteKeys(),
    basePath: MOUNT,
  });
}

describe("routeEndpoint", () => {
  it.each([
    ["/byollm/pair", "pair"],
    ["/byollm/claim", "claim"],
    ["/byollm/heartbeat", "heartbeat"],
    // A trailing slash is a URL detail, not a different route.
    ["/byollm/claim/", "claim"],
  ])("routes %s at the default mount", (path, expected) => {
    expect(routeEndpoint(path)).toBe(expected);
  });

  it.each(["/byollm", "/byollm/unknown", "/", ""])("declines %s", (path) => {
    expect(routeEndpoint(path)).toBeNull();
  });

  it("routes only under the mount point it was given", () => {
    expect(routeEndpoint("/api/byollm/claim", "/api/byollm")).toBe("claim");
    // ...and not under any other, including the default.
    expect(routeEndpoint("/api/byollm/claim")).toBeNull();
    expect(routeEndpoint("/byollm/claim", "/api/byollm")).toBeNull();
  });

  it("no longer dispatches on any path that merely ends in an endpoint", () => {
    // This is the behaviour change. These previously routed — matching was on
    // the last path segment alone, so `PROTOCOL_PREFIX` was decorative and a
    // handler mounted under a broad catch-all answered on unrelated paths.
    // For claim/result/heartbeat that is looser than the constant implies.
    expect(routeEndpoint("/deeply/nested/mount/heartbeat")).toBeNull();
    expect(routeEndpoint("/unrelated/app/route/claim")).toBeNull();
    expect(routeEndpoint("/byollm/nested/claim")).toBeNull();
  });

  it("refuses a malformed mount point rather than matching nothing", () => {
    // A bad mount is a deployment bug. Failing loudly beats a handler that
    // silently 404s every request and looks like a networking problem.
    expect(() => routeEndpoint("/byollm/claim", "byollm")).toThrow(
      /must start with/,
    );
    expect(() => routeEndpoint("/byollm/claim", "/api//byollm")).toThrow(
      /plain path/,
    );
  });
});

describe("a handler answers only where it is mounted", () => {
  it("404s a request to the default prefix when mounted under /api", () => {
    // The integrator failure this makes visible: mounting the Next route at
    // `app/api/byollm/...` and then pairing against the bare domain, so the
    // daemon asks for `/byollm/claim`. It used to answer anyway.
    return handler()(
      new Request("https://app.test/byollm/claim", { method: "POST" }),
    ).then((response) => {
      expect(response.status).toBe(404);
    });
  });

  it("refuses a malformed basePath at construction, not per request", () => {
    expect(() =>
      createFetchHandler({
        store: new MemoryStore(),
        verificationUrl: "https://app.test/settings/runners",
        siteKeys: generateSiteKeys(),
        basePath: "api/byollm",
      }),
    ).toThrow(/must start with/);
  });
});

describe("signatureFrom", () => {
  const headers = (values: Record<string, string>) => new Headers(values);

  it("reads a complete signature", () => {
    expect(
      signatureFrom(
        headers({
          "x-byollm-runner": "runner_1",
          "x-byollm-issued-at": "1800000000000",
          "x-byollm-signature": "sig",
        }),
      ),
    ).toEqual({
      runnerId: "runner_1",
      issuedAt: 1_800_000_000_000,
      signature: "sig",
    });
  });

  it.each([
    ["no runner", { "x-byollm-issued-at": "1", "x-byollm-signature": "s" }],
    ["no signature", { "x-byollm-runner": "r", "x-byollm-issued-at": "1" }],
    ["no timestamp", { "x-byollm-runner": "r", "x-byollm-signature": "s" }],
    [
      "a non-numeric timestamp",
      {
        "x-byollm-runner": "r",
        "x-byollm-issued-at": "soon",
        "x-byollm-signature": "s",
      },
    ],
  ])("returns nothing for %s", (_label, values) => {
    // A partial signature is not a signature. Returning something
    // half-formed would push the decision into code that assumes it is whole.
    expect(signatureFrom(headers(values))).toBeUndefined();
  });
});

describe("fetch handler", () => {
  it("serves a pair start", async () => {
    const response = await handler()(
      new Request(url("pair"), {
        method: "POST",
        body: JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          action: "start",
          device: publicIdentityOf(generateKeys(Date.now())),
          daemon: { version: "0.1.0", label: "mbp", platform: "darwin" },
          capabilities: [],
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { userCode: string };
    expect(body.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it("405s a GET", async () => {
    const response = await handler()(new Request(url("claim")));
    expect(response.status).toBe(405);
  });

  it("404s a path that is not an endpoint", async () => {
    const response = await handler()(
      new Request(url("evaluate"), { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(404);
  });

  it("400s a body that is not JSON, without echoing it back", async () => {
    const response = await handler()(
      new Request(url("pair"), {
        method: "POST",
        // Echoing a parse error would quote attacker text into a response an
        // operator later reads in a terminal.
        body: "[31mnot json[0m",
      }),
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain("");
    expect(text).not.toContain("not json");
  });

  it("400s an oversized body by its declared length", async () => {
    const response = await handler()(
      new Request(url("pair"), {
        method: "POST",
        headers: { "content-length": String(64 * 1024 * 1024) },
        body: "{}",
      }),
    );
    expect(response.status).toBe(400);
  });

  /**
   * The two lanes agree about what is too big — B016.
   *
   * This limit was a hardcoded 8 MiB beside a comment about a 4 MB payload
   * cap. The protocol's envelope cap has since moved to 10 MiB and the hub
   * derives its limit from it; the SDK did not, so a site self-hosting the
   * direct lane refused envelopes the hosted lane accepted. One rule, two
   * implementations, one of them left behind.
   *
   * The interesting case is the gap those two numbers made — bigger than the
   * old constant, smaller than the protocol's — because that is the band
   * where the lanes disagreed, and a test at 64 MiB never visits it.
   */
  it("accepts a body over the old 8 MiB constant, under the envelope cap", async () => {
    const declared = 9 * 1024 * 1024;
    expect(
      declared,
      "the gap this guards closed — if the envelope cap moves below this " +
        "the case stops being a gap and this test stops meaning anything",
    ).toBeLessThan(MAX_ENVELOPE_BYTES);

    const response = await handler()(
      new Request(url("pair"), {
        method: "POST",
        headers: { "content-length": String(declared) },
        body: "{}",
      }),
    );
    /* On the REASON, not the status. `{}` fails schema validation and that
       is also a 400, so a status assertion here cannot tell "got past the
       door and was judged on its contents" from "refused at the door" —
       which is the entire distinction under test. */
    expect(await response.text()).not.toContain("too large");
  });

  it("still refuses one past the envelope cap plus its headroom", async () => {
    /* The control on the test above. Without it, "accepts 9 MiB" passes
       equally well against a server that stopped checking size at all. */
    const response = await handler()(
      new Request(url("pair"), {
        method: "POST",
        headers: {
          "content-length": String(MAX_ENVELOPE_BYTES + 1024 * 1024),
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("too large");
  });

  it("never caches a protocol response", async () => {
    const response = await handler()(
      new Request(url("claim"), { method: "POST", body: "{}" }),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
