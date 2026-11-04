/**
 * RFC 8785 — the JSON Canonicalization Scheme — for the values this protocol
 * digests.
 *
 * byollm_012 §4 names it: `toolsDigest` is SHA-256 over the JCS form of the
 * tools a person consented to. The site SDK, the hub and the daemon each
 * compute it independently, so "the same JSON" has to mean the same bytes on
 * all three, whatever order an object's keys were written in.
 *
 * ## Why this is short
 *
 * RFC 8785 is defined in terms of ECMAScript itself. Numbers serialise as
 * `Number.prototype.toString` does (§3.2.2.3), which is what `JSON.stringify`
 * emits for a finite number; strings are escaped as `JSON.stringify` escapes
 * them (§3.2.2.2); and object keys sort by UTF-16 code unit (§3.2.3), which is
 * what `Array.prototype.sort` does with no comparator. So the scheme is the
 * recursion below and three refusals.
 *
 * ## The refusals
 *
 * - **A non-finite number.** JSON has no spelling for it, and
 *   `JSON.stringify` would quietly write `null`.
 * - **A lone surrogate.** RFC 8785 requires I-JSON (RFC 7493), which forbids
 *   them; `JSON.stringify` would escape one rather than refuse it, and two
 *   parties that disagreed about refusing would disagree about the digest.
 * - **Anything that is not JSON** — `undefined` as a value, a function, a
 *   bigint, a symbol. An object key whose value is `undefined` is skipped, as
 *   `JSON.stringify` skips it, because that is what it means for a zod object
 *   with an absent optional field.
 *
 * Portable: no `node:` import, so it can join `portable.ts` the day a browser
 * needs to compute a digest.
 */

function string(value: string): string {
  if (hasLoneSurrogate(value)) {
    throw new TypeError("JCS refuses a string with a lone surrogate");
  }
  return JSON.stringify(value);
}

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

/** The RFC 8785 canonical form of a JSON value. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("JCS refuses a number JSON cannot spell");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return string(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${string(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(",")}}`;
  }
  throw new TypeError(`JCS refuses a ${typeof value}`);
}
