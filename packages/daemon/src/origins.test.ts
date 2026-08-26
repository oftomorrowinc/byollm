import { describe, expect, it } from "vitest";
import { normalizeOrigin, UnusableOrigin } from "./origins.js";

/**
 * The primary-key law: two spellings of one server are one key, and two
 * servers are never one key.
 *
 * Written after the 2026-08-26 stop-ship, whose whole cause was a normalizer
 * that satisfied neither half.
 */

/** What `normalizeOrigin` did, or why it refused — so a table can hold both. */
const outcome = (input: string): string => {
  try {
    return normalizeOrigin(input);
  } catch (error) {
    if (!(error instanceof UnusableOrigin)) throw error;
    return `REFUSED: ${error.reason}`;
  }
};

describe("the stop-ship this function caused", () => {
  it("reads a scheme-less host as the server a person meant", () => {
    // The exact keystrokes. `byollm allow hub.byollm.cloud …` normalized to
    // `hub.byollm.cloud`, the pairing was stored as `https://hub.byollm.cloud`,
    // the lookup missed, and a guard that should have refused read the miss as
    // "this origin has no control plane" and ran the flow it existed to stop.
    expect(normalizeOrigin("hub.byollm.cloud")).toBe(
      normalizeOrigin("https://hub.byollm.cloud"),
    );
  });

  it("gives four unrelated inputs four different answers", () => {
    // `new URL()` accepts far more than URLs and `.origin` serializes whatever
    // it cannot place as the *string* `"null"`. These four all normalized to
    // it — one primary key standing for four things, which on the allowlist
    // this function served was one entry granting four.
    //
    // Stated over keys rather than over answers: a refusal is not a key, so
    // the two that refuse are free to refuse alike. What may never happen is
    // two of them being *accepted* as one server.
    const collided = ["localhost:8080", "example.com:8443"].map((input) =>
      normalizeOrigin(input),
    );
    expect(new Set(collided).size).toBe(collided.length);
    expect(collided).not.toContain("null");

    for (const hostile of ["javascript:alert(1)", "data:text/html,x"]) {
      expect(() => normalizeOrigin(hostile)).toThrow(UnusableOrigin);
    }
  });

  it("never returns its input when it cannot parse it", () => {
    // The fallback that caused all of it: `catch { return input }`. A
    // normalizer that hands back what it was given cannot tell anyone it
    // failed, and every caller downstream believes the result is a key.
    for (const junk of ["not a url", "", "   ", "ftp://x.test", "http://"]) {
      expect(() => normalizeOrigin(junk)).toThrow(UnusableOrigin);
    }
  });
});

/**
 * Every spelling that means one server.
 *
 * A scheme-less spelling appears only against the origin whose scheme is the
 * one this daemon infers for that host — see the http/https test below. It is
 * a spelling of *that* origin and of no other.
 */
const SPELLINGS: readonly (readonly [string, readonly string[]])[] = [
  [
    "https://hub.byollm.cloud",
    [
      "hub.byollm.cloud",
      "https://hub.byollm.cloud",
      "https://hub.byollm.cloud/",
      "https://hub.byollm.cloud///",
      "https://hub.byollm.cloud/some/path",
      "https://hub.byollm.cloud/?q=1",
      "HUB.BYOLLM.CLOUD",
      "  hub.byollm.cloud  ",
      "//hub.byollm.cloud",
      "https://user:secret@hub.byollm.cloud",
    ],
  ],
  [
    "https://app.test:8443",
    ["app.test:8443", "https://app.test:8443", "https://app.test:8443/x"],
  ],
  [
    "http://localhost:8080",
    ["localhost:8080", "http://localhost:8080", "http://LOCALHOST:8080/"],
  ],
  [
    "http://127.0.0.1:3000",
    ["127.0.0.1:3000", "http://127.0.0.1:3000", "http://127.0.0.1:3000/"],
  ],
  ["http://[::1]:8080", ["[::1]:8080", "http://[::1]:8080"]],
];

describe("two spellings of one server", () => {
  for (const [canonical, spellings] of SPELLINGS) {
    it(`all mean ${canonical}`, () => {
      for (const spelling of spellings) {
        expect(normalizeOrigin(spelling)).toBe(canonical);
      }
    });
  }

  it("is idempotent, which is what lets callers compare with ===", () => {
    // Normalizing at the door and using `===` afterwards is only sound if a
    // normalized origin normalizes to itself. `Pairings` now relies on this:
    // it normalizes each row once at load and never again.
    for (const [canonical] of SPELLINGS) {
      expect(normalizeOrigin(canonical)).toBe(canonical);
    }
  });

  it("drops credentials rather than making them part of the key", () => {
    // An origin is scheme, host and port. Were userinfo to survive, one server
    // would have as many identities as it had passwords typed at it, and a
    // pairing made with one would not be found by the other.
    expect(normalizeOrigin("https://a@hub.test")).toBe(
      normalizeOrigin("https://b@hub.test"),
    );
  });
});

describe("two servers", () => {
  it("keeps http and https apart on a public host", () => {
    // Deliberately not collapsed. Omitting the scheme on a public host means
    // https, so `hub.test` is the https one; somebody who genuinely wants
    // plaintext to a public host says so and is believed. Collapsing these
    // would be the old function's sin — guessing quietly — with a downgrade
    // attached.
    expect(normalizeOrigin("hub.test")).toBe("https://hub.test");
    expect(normalizeOrigin("http://hub.test")).toBe("http://hub.test");
  });

  it("keeps ports apart", () => {
    expect(normalizeOrigin("app.test:8443")).not.toBe(
      normalizeOrigin("app.test:9443"),
    );
  });

  it("keeps a host apart from a host that merely contains it", () => {
    expect(normalizeOrigin("evil-hub.byollm.cloud.attacker.test")).not.toBe(
      normalizeOrigin("hub.byollm.cloud"),
    );
  });
});

describe("refusals, split by remedy", () => {
  // Owner-facing refusals name what to do next, and these three want
  // different things: supply a host, supply a scheme we speak, supply
  // anything at all.
  it.each([
    ["http://", "it names a scheme but no host"],
    ["https://", "it names a scheme but no host"],
    [
      "ftp://x.test",
      "it names a scheme this daemon does not speak — use http or https",
    ],
    [
      "file:///etc/passwd",
      "it names a scheme this daemon does not speak — use http or https",
    ],
    ["", "it is empty"],
    ["   ", "it is empty"],
    ["not a url", "it does not name a host and port"],
    ["javascript:alert(1)", "it does not name a host and port"],
  ])("%s refuses with its own reason", (input, reason) => {
    expect(outcome(input)).toBe(`REFUSED: ${reason}`);
  });

  it("carries the input for a caller to quote back", () => {
    // Origins are not secrets — unlike the pairing rows they key — so the
    // refusal may name what was typed. That is the difference between "not a
    // usable origin" and a message somebody can fix.
    try {
      normalizeOrigin("ftp://x.test");
      expect.unreachable("should have refused");
    } catch (error) {
      expect(error).toBeInstanceOf(UnusableOrigin);
      expect((error as UnusableOrigin).input).toBe("ftp://x.test");
    }
  });
});

/**
 * The invariants, over generated input rather than a table.
 *
 * A table tests the cases somebody thought of. These three are the properties
 * every caller actually relies on, and they are checked against several
 * thousand strings assembled from the pieces that break URL parsers — which is
 * how the unreachable host guard this replaced was found.
 */
describe("every accepted origin", () => {
  const PIECES = [
    "",
    "a",
    "@",
    "://",
    "\\",
    "%2f",
    "\t",
    " ",
    ":",
    "0",
    ".",
    "[",
    "]",
    "::",
    "..",
    "%00",
    "。",
    "xn--",
    "-",
    "local",
    "8080",
    "hub.test",
    "//",
  ];

  const generated: string[] = [];
  for (const prefix of ["", "http://", "https://", "ftp://", "//"]) {
    for (const a of PIECES) {
      for (const b of PIECES) {
        generated.push(`${prefix}${a}${b}`);
      }
    }
  }

  /** Only the ones that normalize; refusals are not keys and prove nothing. */
  const accepted = (): string[] => {
    const keys: string[] = [];
    for (const input of generated) {
      try {
        keys.push(normalizeOrigin(input));
      } catch {
        /* refused, which is always a permitted answer */
      }
    }
    return keys;
  };

  it("names a server", () => {
    // The property the deleted `hostname === ""` guard claimed. A key with no
    // host in it — `"http:"`, or the opaque `"null"` — is a key many unrelated
    // inputs can reach, which is the collision that cost us the stop-ship.
    expect(accepted().length).toBeGreaterThan(100);
    for (const key of accepted()) {
      const url = new URL(key);
      expect(url.hostname).not.toBe("");
      expect(key).not.toBe("null");
    }
  });

  it("speaks http or https", () => {
    for (const key of accepted()) {
      expect(["http:", "https:"]).toContain(new URL(key).protocol);
    }
  });

  it("is already normalized", () => {
    // Idempotence over generated input, not just over the canonical table.
    // `Pairings` normalizes each row once at load and compares with `===`
    // forever after; if any reachable output were not a fixed point, a stored
    // pairing could stop matching itself.
    for (const key of accepted()) {
      expect(normalizeOrigin(key)).toBe(key);
    }
  });
});
