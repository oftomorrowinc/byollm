import { describe, expect, it } from "vitest";
import { generateKeys, keyId, publicIdentityOf } from "./keys.js";
import {
  MAX_SUCCESSION_CHAIN,
  RETIREMENT_WINDOW_MS,
  signSuccession,
  successionStatement,
  verifyLink,
  walkSuccession,
} from "./succession.js";

/**
 * Rotation's one mechanism — byollm_009 Amendment C.
 *
 * The whole design rests on a signature the relay cannot mint, so these are
 * the tests that say what that signature does and, more importantly, what it
 * does not authorise.
 */

const keysFor = (n: number) => generateKeys(1_700_000_000_000 + n);

describe("a site proves it is still itself", () => {
  it("verifies a succession the old key signed", () => {
    const k1 = keysFor(1);
    const k2 = keysFor(2);
    const link = signSuccession(k1, publicIdentityOf(k2));

    expect(verifyLink(link, keyId(k2.identityPublic))).toBe(true);
  });

  it("walks a daemon from the key it pinned to the key in front of it", () => {
    // The offline-across-two-rotations case, which is the reason the chain is
    // a list rather than one predecessor: with a single predecessor this
    // daemon would have to re-pair over housekeeping it did not ask for.
    const k1 = keysFor(1);
    const k2 = keysFor(2);
    const k3 = keysFor(3);
    const chain = [
      signSuccession(k1, publicIdentityOf(k2)),
      signSuccession(k2, publicIdentityOf(k3)),
    ];

    const walk = walkSuccession({
      current: keyId(k3.identityPublic),
      chain,
      approved: (id) => id === keyId(k1.identityPublic),
    });

    expect(walk.failure).toBeUndefined();
    expect(walk.from).toBe(keyId(k1.identityPublic));
    expect(walk.path).toEqual([
      keyId(k1.identityPublic),
      keyId(k2.identityPublic),
      keyId(k3.identityPublic),
    ]);
  });

  it("stops at the first key it already knows", () => {
    // Not merely an optimisation. A daemon that walked to the *oldest* key
    // would be verifying links that predate its own pin, and a failure back
    // there would refuse a rotation it has every reason to accept.
    const k1 = keysFor(1);
    const k2 = keysFor(2);
    const k3 = keysFor(3);
    const chain = [
      { ...signSuccession(k1, publicIdentityOf(k2)), signature: "AAAA" },
      signSuccession(k2, publicIdentityOf(k3)),
    ];

    const walk = walkSuccession({
      current: keyId(k3.identityPublic),
      chain,
      approved: (id) => id === keyId(k2.identityPublic),
    });

    expect(walk.from).toBe(keyId(k2.identityPublic));
  });
});

describe("what a succession does not authorise", () => {
  it("refuses a succession replayed against another site's key", () => {
    // C.1's load-bearing claim, as a test rather than a comment: a signature
    // over the successor alone could be lifted from one site's record and
    // dropped into another's, moving that site to a key the attacker holds.
    //
    // Here K1 legitimately signs for K2. The same link is presented as though
    // it were a succession from V1 — a different site's key — to K2.
    const k1 = keysFor(1);
    const k2 = keysFor(2);
    const victim = keysFor(9);
    const genuine = signSuccession(k1, publicIdentityOf(k2));

    const replayed = { ...genuine, identity: publicIdentityOf(victim) };

    expect(verifyLink(replayed, keyId(k2.identityPublic))).toBe(false);
    expect(
      walkSuccession({
        current: keyId(k2.identityPublic),
        chain: [replayed],
        approved: (id) => id === keyId(victim.identityPublic),
      }).failure,
    ).toBe("broken-link");
  });

  it("refuses a succession pointed at a successor it does not name", () => {
    // The other half of naming both ids. K1 signed for K2; an attacker holding
    // K3 presents that signature as authority for K3.
    const k1 = keysFor(1);
    const k2 = keysFor(2);
    const k3 = keysFor(3);
    const forK2 = signSuccession(k1, publicIdentityOf(k2));

    expect(verifyLink(forK2, keyId(k3.identityPublic))).toBe(false);
  });

  it("refuses a link whose encryption key was substituted in flight", () => {
    // A chain is a place a key arrives, so it is a place `verifyPublicIdentity`
    // has to be called. Without it an upstream could relay a genuine identity
    // with an encryption key of its own and read everything sealed to the
    // "predecessor".
    const k1 = keysFor(1);
    const k2 = keysFor(2);
    const other = keysFor(8);
    const link = signSuccession(k1, publicIdentityOf(k2));

    const tampered = {
      ...link,
      identity: { ...link.identity, encryption: other.encryptionPublic },
    };

    expect(verifyLink(tampered, keyId(k2.identityPublic))).toBe(false);
  });

  it("does not treat a chain that reaches nobody as an attack", () => {
    // A stranger with a history is still a stranger: offered for local
    // approval, not refused loudly. Telling these apart is what keeps the
    // loud refusal meaningful.
    const k1 = keysFor(1);
    const k2 = keysFor(2);

    expect(
      walkSuccession({
        current: keyId(k2.identityPublic),
        chain: [signSuccession(k1, publicIdentityOf(k2))],
        approved: () => false,
      }).failure,
    ).toBe("unknown-origin");
  });

  it("refuses a chain longer than the guard allows", () => {
    // A denial-of-service bound, not an opinion about rotation frequency. The
    // chain here is nonsense; the point is that length is checked before any
    // signature is verified.
    const k1 = keysFor(1);
    const k2 = keysFor(2);
    const link = signSuccession(k1, publicIdentityOf(k2));

    expect(
      walkSuccession({
        current: keyId(k2.identityPublic),
        chain: Array.from({ length: MAX_SUCCESSION_CHAIN + 1 }, () => link),
        approved: () => true,
      }).failure,
    ).toBe("too-long");
  });

  it("treats an empty chain as no claim rather than a failed one", () => {
    const k1 = keysFor(1);
    expect(
      walkSuccession({
        current: keyId(k1.identityPublic),
        chain: [],
        approved: () => true,
      }).failure,
    ).toBe("no-chain");
  });
});

describe("the constants", () => {
  it("signs a statement naming both ids, in order", () => {
    // Pinned as bytes, because this string is a wire format: a daemon built
    // against one spelling and a site against another would fail to rotate
    // with two correct implementations.
    expect(
      Buffer.from(successionStatement("BYOLLM-AAAA", "BYOLLM-BBBB")).toString(),
    ).toBe("byollm/v1/site-succession:BYOLLM-AAAA:BYOLLM-BBBB");
  });

  it("retires a key a week after it is succeeded", () => {
    expect(RETIREMENT_WINDOW_MS).toBe(604_800_000);
  });
});
