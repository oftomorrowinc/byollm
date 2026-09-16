/**
 * The envelope's FORMAT, with no primitives and no platform — B018c step 3.
 *
 * ## Why this file exists
 *
 * The browser is one of the two ends a console stream is encrypted between,
 * and it cannot run `envelope.ts`: the sealing is WASM and portable, but the
 * inner signature goes through `node:crypto`'s Ed25519. So the browser needs
 * its own primitives.
 *
 * What it must NOT have is its own *format*. Two implementations of "which
 * bytes get signed" is the defect class this codebase spends most of its
 * checks on, and here the two copies would diverge silently — a mismatched
 * signature is indistinguishable from an attack, so the first symptom would
 * be a console that refuses to open and a log line saying `bad-signature`.
 *
 * Everything here is therefore pure: no `node:` imports, no `Buffer`, no
 * `btoa`. `envelope-is-portable.test.ts` asserts that mechanically, because
 * "somebody will import Buffer for convenience one day" is a prediction, and
 * this project's rule is that a prediction ships with the test that catches it.
 *
 * ## Why base64url is written out by hand
 *
 * `Buffer` is Node's and `btoa` takes a binary string, so neither is both
 * portable and pleasant. Twenty lines of table lookup is: it agrees with
 * `Buffer` on every byte value, which the test proves rather than assumes.
 */

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Indexed as an array so the compiler knows every lookup lands. */
const CHARS: readonly string[] = ALPHABET.split("");

/** Reverse table, built once. 255 marks "not a base64url character". */
const VALUES = /* @__PURE__ */ (() => {
  const table = new Uint8Array(128).fill(255);
  for (let at = 0; at < ALPHABET.length; at += 1) {
    table[ALPHABET.charCodeAt(at)] = at;
  }
  return table;
})();

/** Unpadded base64url, the encoding every key and signature on this wire uses. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let at = 0; at < bytes.length; at += 3) {
    const a = bytes[at] ?? 0;
    const b = bytes[at + 1];
    const c = bytes[at + 2];
    const word = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += CHARS[(word >> 18) & 63] ?? "";
    out += CHARS[(word >> 12) & 63] ?? "";
    if (b !== undefined) out += CHARS[(word >> 6) & 63] ?? "";
    if (c !== undefined) out += CHARS[word & 63] ?? "";
  }
  return out;
}

/** The inverse. Returns undefined rather than throwing — this parses input. */
export function fromBase64Url(text: string): Uint8Array | undefined {
  const length = text.length;
  // 1 leftover character cannot encode any whole byte.
  if (length % 4 === 1) return undefined;
  const bytes = new Uint8Array(Math.floor((length * 3) / 4));
  let written = 0;
  let word = 0;
  let bits = 0;
  for (let at = 0; at < length; at += 1) {
    const code = text.charCodeAt(at);
    const value = code < 128 ? VALUES[code] : 255;
    if (value === undefined || value === 255) return undefined;
    word = (word << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[written] = (word >> bits) & 0xff;
      written += 1;
    }
  }
  return bytes.subarray(0, written);
}

/** Domain tag for the bytes an envelope's signature covers. */
export const ENVELOPE_BODY_VERSION = "byollm/v1/envelope";

/** What an envelope's signature is over — the fields, in this order. */
export interface EnvelopeBodyContext {
  readonly jobId: string;
  readonly senderKeyId: string;
  readonly recipientKeyId: string;
  readonly deadlineAt: number;
  readonly direction: string;
}

/**
 * The exact bytes an envelope's signature covers.
 *
 * **Field order is part of the format**, because `JSON.stringify` emits keys
 * in insertion order and the verifier hashes bytes, not meaning. Reordering
 * these lines is a wire change that no type would catch and every signature
 * would fail — which is why they are written out rather than spread from an
 * object somebody could reshape.
 */
export function envelopeSignedBody(
  context: EnvelopeBodyContext,
  plaintext: string,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      v: ENVELOPE_BODY_VERSION,
      jobId: context.jobId,
      senderKeyId: context.senderKeyId,
      recipientKeyId: context.recipientKeyId,
      deadlineAt: context.deadlineAt,
      direction: context.direction,
      plaintext,
    }),
  );
}

/** The signed body and its signature, as they travel inside the sealed box. */
export function encodeEnvelopeInner(
  body: Uint8Array,
  signature: string,
): string {
  return JSON.stringify({ body: toBase64Url(body), signature });
}

export interface EnvelopeInner {
  readonly body: Uint8Array;
  readonly signature: string;
}

/**
 * Read the inner object back.
 *
 * Returns undefined for anything malformed rather than throwing, because
 * every byte reaching this has come out of a decryption and is therefore
 * input — `malformed` is one of the outcomes `open()` already distinguishes.
 */
export function decodeEnvelopeInner(text: string): EnvelopeInner | undefined {
  let parsed: { body?: unknown; signature?: unknown };
  try {
    parsed = JSON.parse(text) as { body?: unknown; signature?: unknown };
  } catch {
    return undefined;
  }
  if (typeof parsed.body !== "string" || typeof parsed.signature !== "string") {
    return undefined;
  }
  const body = fromBase64Url(parsed.body);
  if (body === undefined) return undefined;
  return { body, signature: parsed.signature };
}
