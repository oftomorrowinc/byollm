import { describe, expect, it } from "vitest";
import { generateKeys } from "./keys.js";
import {
  MAX_CLOCK_SKEW_MS,
  canonicalRequest,
  signRequest,
  signSiteRequest,
  verifyRequest,
  verifySiteRequest,
} from "./signing.js";

const NOW = 1_800_000_000_000;
const keys = generateKeys(NOW);
const other = generateKeys(NOW);

const base = {
  endpoint: "claim",
  runnerId: "runner_1",
  issuedAt: NOW,
  body: JSON.stringify({ protocolVersion: "0", max: 1 }),
};

const verify = (over: Partial<Parameters<typeof verifyRequest>[0]> = {}) =>
  verifyRequest({
    identityPublic: keys.identityPublic,
    endpoint: base.endpoint,
    body: base.body,
    signature: signRequest(keys, base),
    now: NOW,
    ...over,
  });

describe("a signed request", () => {
  it("verifies against the signer's identity", () => {
    expect(verify()).toBe(null);
  });

  it("refuses another key's signature", () => {
    expect(verify({ signature: signRequest(other, base) })).toBe(
      "bad-signature",
    );
  });
});

describe("everything that decides what the request does is signed", () => {
  // Each of these is a field an intermediary could otherwise change without
  // breaking the signature — which is the entire point of a canonical string.

  it("binds the endpoint", () => {
    // Otherwise a signed `heartbeat` is a signed `release`.
    expect(verify({ endpoint: "release" })).toBe("bad-signature");
  });

  it("binds the body", () => {
    expect(
      verify({ body: JSON.stringify({ protocolVersion: "0", max: 64 }) }),
    ).toBe("bad-signature");
  });

  it("binds the runner id", () => {
    // Otherwise a signature from one runner authenticates another's calls.
    const forged = { ...signRequest(keys, base), runnerId: "runner_2" };
    expect(verify({ signature: forged })).toBe("bad-signature");
  });

  it("binds the timestamp", () => {
    const moved = { ...signRequest(keys, base), issuedAt: NOW + 1 };
    expect(verify({ signature: moved, now: NOW + 1 })).toBe("bad-signature");
  });

  it("does not collide across field boundaries", () => {
    // A separator-free canonical string lets ("ab","c") and ("a","bc") sign
    // identically. Newlines are what stop that.
    const a = canonicalRequest({ ...base, endpoint: "cla", runnerId: "im" });
    const b = canonicalRequest({ ...base, endpoint: "cl", runnerId: "aim" });
    expect(a.toString()).not.toBe(b.toString());
  });
});

describe("freshness is bounded in both directions", () => {
  it("accepts a request inside the window", () => {
    expect(verify({ now: NOW + MAX_CLOCK_SKEW_MS - 1_000 })).toBe(null);
    expect(verify({ now: NOW - MAX_CLOCK_SKEW_MS + 1_000 })).toBe(null);
  });

  it("refuses one that is too old", () => {
    expect(verify({ now: NOW + MAX_CLOCK_SKEW_MS + 1 })).toBe("stale");
  });

  it("refuses one from too far in the future", () => {
    // As important as the other direction: a timestamp far ahead would keep a
    // captured request replayable long after it was made, which is the one
    // thing the window exists to bound.
    expect(verify({ now: NOW - MAX_CLOCK_SKEW_MS - 1 })).toBe("stale");
  });

  it("checks freshness before spending time on the signature", () => {
    // Cheap check first: an unauthenticated caller should not be able to make
    // the server verify signatures by sending stale garbage.
    expect(
      verifyRequest({
        identityPublic: "not-a-key",
        endpoint: base.endpoint,
        body: base.body,
        signature: { runnerId: "r", issuedAt: 1, signature: "x" },
        now: NOW,
      }),
    ).toBe("stale");
  });
});

describe("the site plane signs in its own namespace", () => {
  const site = {
    endpoint: "enqueue",
    siteId: "site_demo",
    issuedAt: NOW,
    body: JSON.stringify({ siteId: "site_demo" }),
  };

  it("verifies against the site's registered identity", () => {
    expect(
      verifySiteRequest({
        identityPublic: keys.identityPublic,
        endpoint: site.endpoint,
        body: site.body,
        signature: signSiteRequest(keys, site),
        now: NOW,
      }),
    ).toBe(null);
  });

  it("does not verify as a daemon call of the same name", () => {
    // The property the `site/` prefix exists for, tested directly rather than
    // through a scenario. Today's two planes share no endpoint name, so a
    // staged replay could not fail — and an assertion that cannot fail is the
    // shape this project keeps catching. So: same key, same endpoint name,
    // same body, same second, and the two signatures must still differ.
    expect(
      verifyRequest({
        identityPublic: keys.identityPublic,
        endpoint: site.endpoint,
        body: site.body,
        signature: signSiteRequest(keys, site),
        now: NOW,
      }),
    ).toBe("bad-signature");

    expect(
      verifySiteRequest({
        identityPublic: keys.identityPublic,
        endpoint: site.endpoint,
        body: site.body,
        signature: signRequest(keys, {
          endpoint: site.endpoint,
          runnerId: site.siteId,
          issuedAt: site.issuedAt,
          body: site.body,
        }),
        now: NOW,
      }),
    ).toBe("bad-signature");
  });

  it("binds the site id, so one site's signature is not another's", () => {
    expect(
      verifySiteRequest({
        identityPublic: keys.identityPublic,
        endpoint: site.endpoint,
        body: site.body,
        signature: {
          ...signSiteRequest(keys, site),
          runnerId: "site_someone_else",
        },
        now: NOW,
      }),
    ).toBe("bad-signature");
  });
});
