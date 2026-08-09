import { describe, expect, it } from "vitest";
import { bearerFrom, createFetchHandler, routeEndpoint } from "./http.js";
import { MemoryStore } from "./memory.js";

const url = (endpoint: string) => `https://app.test/api/byollm/${endpoint}`;

function handler() {
  return createFetchHandler({
    store: new MemoryStore(),
    verificationUrl: "https://app.test/settings/runners",
  });
}

describe("routeEndpoint", () => {
  it.each([
    ["/api/byollm/pair", "pair"],
    ["/byollm/claim", "claim"],
    ["/deeply/nested/mount/heartbeat", "heartbeat"],
  ])("routes %s", (path, expected) => {
    expect(routeEndpoint(path)).toBe(expected);
  });

  it.each(["/api/byollm", "/api/byollm/unknown", "/", ""])(
    "declines %s",
    (path) => {
      expect(routeEndpoint(path)).toBeNull();
    },
  );
});

describe("bearerFrom", () => {
  it("reads a bearer token, case-insensitively", () => {
    expect(bearerFrom("Bearer abc123")).toBe("abc123");
    expect(bearerFrom("bearer abc123")).toBe("abc123");
    expect(bearerFrom("  Bearer   abc123  ")).toBe("abc123");
  });

  it("ignores anything that is not a bearer scheme", () => {
    expect(bearerFrom(null)).toBeUndefined();
    expect(bearerFrom("Basic abc123")).toBeUndefined();
    expect(bearerFrom("")).toBeUndefined();
  });
});

describe("fetch handler", () => {
  it("serves a pair start", async () => {
    const response = await handler()(
      new Request(url("pair"), {
        method: "POST",
        body: JSON.stringify({
          protocolVersion: "0",
          action: "start",
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

  it("never caches a protocol response", async () => {
    const response = await handler()(
      new Request(url("claim"), { method: "POST", body: "{}" }),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
