import { Buffer } from "node:buffer";
import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import sodium from "libsodium-wrappers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  decodeEnvelopeInner,
  encodeEnvelopeInner,
  envelopeSignedBody,
  fromBase64Url,
  toBase64Url,
} from "./envelope-format.js";

/**
 * The format, proved twice over — B018c step 3, CW's two conditions.
 *
 * 1. It is **byte-identical** to what the wire already carries. A refactor
 *    that changed one byte of the signed body would invalidate every
 *    signature in the fleet, and the symptom would be `bad-signature`, which
 *    is indistinguishable from an attack.
 * 2. Two different sets of **primitives agree over it**. The browser will
 *    sign with libsodium and the daemon signs with `node:crypto`, and each
 *    must verify the other or a console cannot open.
 */

beforeAll(async () => {
  await sodium.ready;
});

const context = {
  jobId: "job_1",
  senderKeyId: "sender",
  recipientKeyId: "recipient",
  deadlineAt: 1_700_000_000_000,
  direction: "payload",
};

describe("base64url, written by hand because Buffer is Node's", () => {
  it("agrees with Buffer on every single byte value", () => {
    /** Not a sample: all 256, each alone, so no value is encoded by luck. */
    for (let byte = 0; byte < 256; byte += 1) {
      const one = new Uint8Array([byte]);
      expect(toBase64Url(one)).toBe(Buffer.from(one).toString("base64url"));
    }
  });

  it("agrees with Buffer across every length remainder", () => {
    // 0, 1 and 2 leftover bytes are the three padding cases, and the one a
    // hand-written encoder gets wrong.
    for (let length = 0; length < 40; length += 1) {
      const bytes = randomBytes(length);
      expect(toBase64Url(bytes)).toBe(bytes.toString("base64url"));
    }
  });

  it("round-trips whatever it encodes", () => {
    for (let length = 0; length < 40; length += 1) {
      const bytes = new Uint8Array(randomBytes(length));
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    }
  });

  it("decodes what Buffer encoded, not only what it encoded itself", () => {
    /** A codec that only reads its own output is half a codec. */
    for (let length = 1; length < 40; length += 1) {
      const bytes = randomBytes(length);
      expect(fromBase64Url(bytes.toString("base64url"))).toEqual(
        new Uint8Array(bytes),
      );
    }
  });

  it("refuses rubbish rather than inventing bytes", () => {
    expect(fromBase64Url("not base64!")).toBeUndefined();
    expect(fromBase64Url("A")).toBeUndefined();
    expect(fromBase64Url("AB=")).toBeUndefined();
    // Standard base64's + and / are NOT base64url's alphabet.
    expect(fromBase64Url("ab+d")).toBeUndefined();
    expect(fromBase64Url("ab/d")).toBeUndefined();
  });
});

describe("the signed body is what the wire already carries", () => {
  it("is byte-identical to the original construction", () => {
    /**
     * The original, spelled out here on purpose rather than imported: this is
     * the thing being frozen, so it has to be written down somewhere a change
     * to the implementation cannot follow it.
     */
    const original = Buffer.from(
      JSON.stringify({
        v: "byollm/v1/envelope",
        jobId: context.jobId,
        senderKeyId: context.senderKeyId,
        recipientKeyId: context.recipientKeyId,
        deadlineAt: context.deadlineAt,
        direction: context.direction,
        plaintext: "hello",
      }),
      "utf8",
    );
    expect(Buffer.from(envelopeSignedBody(context, "hello"))).toEqual(original);
  });

  it("carries utf8 through unchanged", () => {
    const body = envelopeSignedBody(context, "café — naïve 🔐");
    expect(JSON.parse(new TextDecoder().decode(body))).toMatchObject({
      plaintext: "café — naïve 🔐",
    });
  });

  it("changes when ANY field changes", () => {
    /** Each field is covered, so none can be swapped without the signature
     *  failing — which is the property the whole envelope rests on. */
    const base = toBase64Url(envelopeSignedBody(context, "x"));
    const variants = [
      { ...context, jobId: "other" },
      { ...context, senderKeyId: "other" },
      { ...context, recipientKeyId: "other" },
      { ...context, deadlineAt: context.deadlineAt + 1 },
      { ...context, direction: "result" },
    ];
    for (const variant of variants) {
      expect(toBase64Url(envelopeSignedBody(variant, "x"))).not.toBe(base);
    }
    expect(toBase64Url(envelopeSignedBody(context, "y"))).not.toBe(base);
  });

  it("round-trips the inner object", () => {
    const body = envelopeSignedBody(context, "hello");
    const inner = decodeEnvelopeInner(encodeEnvelopeInner(body, "sig"));
    expect(inner?.signature).toBe("sig");
    expect(inner?.body).toEqual(body);
  });

  it("refuses a malformed inner rather than throwing", () => {
    expect(decodeEnvelopeInner("{not json")).toBeUndefined();
    expect(decodeEnvelopeInner(JSON.stringify({ body: 7 }))).toBeUndefined();
    expect(
      decodeEnvelopeInner(JSON.stringify({ body: "!!", signature: "s" })),
    ).toBeUndefined();
  });
});

describe("two sets of primitives, one format — the browser's seam", () => {
  it("node signs and libsodium verifies, over the shared body", () => {
    const pair = generateKeyPairSync("ed25519");
    const spki = pair.publicKey.export({ type: "spki", format: "der" });
    const raw = new Uint8Array(spki.subarray(spki.length - 32));

    const body = envelopeSignedBody(context, "from the daemon");
    const signature = sign(null, body, pair.privateKey);

    expect(
      sodium.crypto_sign_verify_detached(new Uint8Array(signature), body, raw),
      "a browser must be able to verify what a daemon signed",
    ).toBe(true);
  });

  it("libsodium signs and node verifies, over the shared body", () => {
    const pair = generateKeyPairSync("ed25519");
    const pkcs8 = pair.privateKey.export({ type: "pkcs8", format: "der" });
    const seed = new Uint8Array(pkcs8.subarray(pkcs8.length - 32));
    const sodiumPair = sodium.crypto_sign_seed_keypair(seed);

    const body = envelopeSignedBody(context, "from the browser");
    const signature = sodium.crypto_sign_detached(body, sodiumPair.privateKey);

    expect(
      verify(null, body, pair.publicKey, Buffer.from(signature)),
      "a daemon must be able to verify what a browser signed",
    ).toBe(true);
  });

  it("derives the SAME public key from both sides of a keypair", () => {
    /** If these ever disagreed, every cross-primitive signature would fail
     *  while both implementations looked individually correct. */
    const pair = generateKeyPairSync("ed25519");
    const spki = pair.publicKey.export({ type: "spki", format: "der" });
    const pkcs8 = pair.privateKey.export({ type: "pkcs8", format: "der" });
    const fromNode = new Uint8Array(spki.subarray(spki.length - 32));
    const fromSodium = sodium.crypto_sign_seed_keypair(
      new Uint8Array(pkcs8.subarray(pkcs8.length - 32)),
    ).publicKey;
    expect(fromSodium).toEqual(fromNode);
  });

  it("rebuilds a node public key from the RAW form the wire carries", () => {
    /**
     * `PublicIdentity` carries raw keys, which is what lets a browser work
     * with no DER at all. This is the other direction — a raw key coming back
     * to Node — and it is what `verifyWith` does with a pinned identity.
     */
    const pair = generateKeyPairSync("ed25519");
    const spki = pair.publicKey.export({ type: "spki", format: "der" });
    const raw = spki.subarray(spki.length - 32);

    const body = envelopeSignedBody(context, "x");
    const signature = sign(null, body, pair.privateKey);

    const rebuilt = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: toBase64Url(new Uint8Array(raw)) },
      format: "jwk",
    });
    expect(verify(null, body, rebuilt, signature)).toBe(true);
  });

  it("seals and opens a box with libsodium alone, on raw keys", () => {
    /** The browser's other half: it seals to the box's raw encryption key,
     *  and nothing in that path needs Node. */
    const pair = sodium.crypto_box_keypair();
    const sealed = sodium.crypto_box_seal(
      new TextEncoder().encode("hello"),
      pair.publicKey,
    );
    const opened = sodium.crypto_box_seal_open(
      sealed,
      pair.publicKey,
      pair.privateKey,
    );
    expect(new TextDecoder().decode(opened)).toBe("hello");
  });
});
