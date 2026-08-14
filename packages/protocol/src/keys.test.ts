import { describe, expect, it } from "vitest";
import {
  PublicIdentity,
  StoredKeys,
  fingerprint,
  generateKeys,
  publicIdentityOf,
  signWith,
  verifyPublicIdentity,
  verifyWith,
} from "./keys.js";

const NOW = 1_800_000_000_000;

describe("key generation", () => {
  it("produces two bound keypairs", () => {
    const keys = generateKeys(NOW);
    expect(StoredKeys.safeParse(keys).success).toBe(true);
    expect(verifyPublicIdentity(publicIdentityOf(keys))).toBe(true);
  });

  it("never repeats a key", () => {
    const a = generateKeys(NOW);
    const b = generateKeys(NOW);
    expect(a.identityPublic).not.toBe(b.identityPublic);
    expect(a.encryptionPublic).not.toBe(b.encryptionPublic);
  });

  it("keeps the private halves out of the public form", () => {
    // The whole file is serialised to disk and the public half to the wire.
    // Confusing the two is the sort of thing that ships.
    const keys = generateKeys(NOW);
    const published = JSON.stringify(publicIdentityOf(keys));
    expect(published).not.toContain(keys.identityPrivate);
    expect(published).not.toContain(keys.encryptionPrivate);
    expect(PublicIdentity.safeParse(publicIdentityOf(keys)).success).toBe(true);
  });
});

describe("the identity binds the encryption key [byollm_009 §3]", () => {
  it("accepts a genuine pairing", () => {
    expect(verifyPublicIdentity(publicIdentityOf(generateKeys(NOW)))).toBe(
      true,
    );
  });

  it("refuses an encryption key swapped in from another party", () => {
    // The attack this exists for: an upstream relays a real identity but
    // substitutes an encryption key it holds the secret for, and reads
    // everything sealed to it. Pinning the identity only helps if the
    // binding is checked.
    const site = publicIdentityOf(generateKeys(NOW));
    const attacker = publicIdentityOf(generateKeys(NOW));

    expect(
      verifyPublicIdentity({ ...site, encryption: attacker.encryption }),
    ).toBe(false);
  });

  it("refuses a signature lifted from another key", () => {
    const a = publicIdentityOf(generateKeys(NOW));
    const b = publicIdentityOf(generateKeys(NOW));
    expect(verifyPublicIdentity({ ...a, encryptionSig: b.encryptionSig })).toBe(
      false,
    );
  });

  it("returns false rather than throwing on malformed input", () => {
    // This runs on data from the network. A crash here is a denial of
    // service on the pairing path.
    const good = publicIdentityOf(generateKeys(NOW));
    for (const bad of [
      { ...good, identity: "not-a-key" },
      { ...good, encryption: "" },
      { ...good, encryptionSig: "!!!!" },
      { ...good, identity: "" },
    ]) {
      expect(() => verifyPublicIdentity(bad)).not.toThrow();
      expect(verifyPublicIdentity(bad)).toBe(false);
    }
  });
});

describe("signing", () => {
  it("round-trips a signature", () => {
    const keys = generateKeys(NOW);
    const nonce = Buffer.from("a challenge nonce");
    const sig = signWith(keys, nonce);
    expect(verifyWith(keys.identityPublic, nonce, sig)).toBe(true);
  });

  it("refuses a signature over different bytes", () => {
    const keys = generateKeys(NOW);
    const sig = signWith(keys, Buffer.from("nonce-one"));
    expect(verifyWith(keys.identityPublic, Buffer.from("nonce-two"), sig)).toBe(
      false,
    );
  });

  it("refuses another key's signature", () => {
    const mine = generateKeys(NOW);
    const theirs = generateKeys(NOW);
    const nonce = Buffer.from("nonce");
    expect(
      verifyWith(mine.identityPublic, nonce, signWith(theirs, nonce)),
    ).toBe(false);
  });

  it("returns false rather than throwing on a malformed signature", () => {
    const keys = generateKeys(NOW);
    expect(verifyWith(keys.identityPublic, Buffer.from("x"), "garbage")).toBe(
      false,
    );
    expect(verifyWith("garbage", Buffer.from("x"), "garbage")).toBe(false);
  });
});

describe("fingerprints are for humans", () => {
  it("is stable for a key and different across keys", () => {
    const a = generateKeys(NOW);
    const b = generateKeys(NOW);
    expect(fingerprint(a.identityPublic)).toBe(fingerprint(a.identityPublic));
    expect(fingerprint(a.identityPublic)).not.toBe(
      fingerprint(b.identityPublic),
    );
  });

  it("reads aloud without ambiguity", () => {
    const fp = fingerprint(generateKeys(NOW).identityPublic);
    expect(fp).toMatch(/^BYOLLM(-[0-9A-HJKMNP-TV-Z]{4}){6}$/);
    // I, L, O and U are excluded from the *digits*: a fingerprint compared
    // over the phone must not turn on whether someone said "oh" or "zero". A
    // fingerprint nobody bothers to compare is worth nothing, so legibility
    // is the security property here.
    //
    // The literal "BYOLLM-" prefix is exempt, and this test caught its own
    // first version asserting otherwise. The prefix is a constant nobody
    // reads out character by character; the digits are what get compared.
    const digits = fp.replace(/^BYOLLM-/, "");
    expect(digits).not.toMatch(/[ILOU]/);
  });

  it("carries 120 bits, in six readable groups", () => {
    const fp = fingerprint(generateKeys(NOW).identityPublic);
    expect(fp.split("-").slice(1)).toHaveLength(6);
    expect(fp.replace(/^BYOLLM-/, "").replace(/-/g, "")).toHaveLength(24);
  });

  it("changes completely when one bit of the key changes", () => {
    // Not a property of SHA-256 worth doubting, but this is the assumption a
    // human comparison rests on: two keys must not share a prefix.
    const a = generateKeys(NOW);
    const raw = Buffer.from(a.identityPublic, "base64url");
    raw[0] = (raw[0] ?? 0) ^ 1;
    const flipped = fingerprint(raw.toString("base64url"));
    const original = fingerprint(a.identityPublic);
    expect(flipped).not.toBe(original);
    expect(flipped.slice(0, 12)).not.toBe(original.slice(0, 12));
  });
});
