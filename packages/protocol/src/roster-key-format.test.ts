import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateKeys } from "./keys.js";
import { signRoster, verifyRoster } from "./roster.js";

/**
 * The encoding `mint-roster-keypair.mjs` produces, pinned here.
 *
 * That script mints the control plane's roster-signing key. It cannot import
 * this package — it is a root-level script in another repository and Node
 * resolves from the script's own location, which is how its first real run
 * failed in Todd's hands rather than in a test.
 *
 * So it reproduces the encoding with `node:crypto` instead, and this is the
 * contract that keeps the two from drifting: a key made the way that script
 * makes one must be a key this package can sign with. If `exportPrivate` ever
 * changes its base — base64 and not base64url, which is easy to "tidy" — this
 * fails here rather than an hour after a deploy, at every device at once.
 */
const NOW = 1_800_000_000_000;

/** Exactly what the mint script does, and nothing this package exports. */
function mintTheWayTheScriptDoes(): {
  identityPublic: string;
  identityPrivate: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string") throw new Error("no raw public half");
  return {
    identityPublic: jwk.x,
    identityPrivate: privateKey
      .export({ type: "pkcs8", format: "der" })
      .toString("base64"),
  };
}

describe("a key minted outside this package", () => {
  it("can sign a roster this package verifies", () => {
    const keys = mintTheWayTheScriptDoes();
    const roster = signRoster(keys, {
      owner: "alice",
      members: ["bob"],
      issuedAt: NOW,
    });
    expect(
      verifyRoster({
        roster,
        owner: "alice",
        controlPlanePublic: keys.identityPublic,
        now: NOW,
      }),
    ).toBeNull();
  });

  it("uses the same shape generateKeys does", () => {
    // Lengths, not alphabets. The private half is PKCS8 DER and the public is
    // the raw point — a change from one to the other is what breaks, and it
    // shows up here as a length.
    const mine = mintTheWayTheScriptDoes();
    const theirs = generateKeys(NOW);
    expect(mine.identityPublic).toHaveLength(theirs.identityPublic.length);
    expect(mine.identityPrivate).toHaveLength(theirs.identityPrivate.length);
  });

  it("rejects the raw private key in place of PKCS8", () => {
    /**
     * The real failure mode, checked against Node before it was written down.
     *
     * This test first asserted that a private half re-encoded base64url would
     * be rejected, on the theory that base64-not-base64url was a fragile
     * detail somebody might tidy. It is not fragile: Node's base64 decoder
     * accepts the url alphabet, and so does its JWK reader for the public
     * half — both halves round-trip through either. The claim was wrong and
     * the test caught it, which is the only reason it is not a comment
     * somebody would have trusted.
     *
     * What does break is the *shape*: the 32-byte raw key where a PKCS8
     * wrapper belongs. That is the mistake available to somebody reading
     * "private key" and reaching for the JWK `d` component.
     */
    const { privateKey } = generateKeyPairSync("ed25519");
    const jwk = privateKey.export({ format: "jwk" });
    expect(typeof jwk.d).toBe("string");
    expect(() =>
      signRoster(
        {
          identityPrivate: Buffer.from(jwk.d!, "base64url").toString("base64"),
        },
        { owner: "a", members: [], issuedAt: NOW },
      ),
    ).toThrow();
  });
});
