/**
 * How long `JSON.stringify(value)` would be, without building it — B060.
 *
 * The relay refuses an envelope over {@link MAX_ENVELOPE_BYTES}, and to find
 * out how big one is it serialised the whole thing and measured the string.
 * On the shared hub that means holding the oversized thing a second time in
 * order to learn that it is oversized — a transient copy the size of the
 * payload, per enqueue and per result, exactly when the payload is at its
 * largest.
 *
 * ## Why not measure something cheaper
 *
 * Because the number is also the meter. {@link envelopeBytes}' own note is
 * explicit: the relay stores the serialised envelope and the monthly rollup
 * counts what it stored, so a cap measured on anything else — the raw request
 * body, the ciphertext alone, the decoded length — would mean the limit and
 * the bill disagreed about what a byte is, and a job could be small enough to
 * accept and larger than it was charged as. The requirement is not "a cheaper
 * number", it is "the same number, cheaply".
 *
 * ## The rule this has to keep
 *
 * `jsonLength(v) === JSON.stringify(v)?.length` for every value, or it is
 * wrong. That is a strong claim about a function with many edge cases, so the
 * ones it cannot promise are not attempted: anything outside the JSON value
 * domain — a `Date` with its `toJSON`, `undefined`, a function, a bigint, a
 * non-finite number, a cycle — returns `undefined` here and the caller falls
 * back to serialising. Envelopes arrive from `JSON.parse` and are therefore
 * always in the domain, so the fallback costs nothing in practice and removes
 * every edge case from the thing that has to be exactly right.
 */

/** What a value serialises to, counted rather than built. */
export function jsonLength(value: unknown): number | undefined {
  try {
    return count(value, new Set());
  } catch {
    /* Out of domain, or a cycle. The caller serialises instead — which is
       what it did before this existed, so the failure direction is "no
       saving", never "a wrong number". */
    return undefined;
  }
}

/** Thrown to abandon the walk; never escapes {@link jsonLength}. */
class OutOfDomain extends Error {}

function bail(): never {
  throw new OutOfDomain("not a JSON value");
}

function count(value: unknown, seen: Set<object>): number {
  if (value === null) return 4; // null
  switch (typeof value) {
    case "boolean":
      return value ? 4 : 5; // true / false
    case "number":
      /* Non-finite serialises as `null`, and that is a rule worth not
         re-deriving from memory — it is asserted in the suite. */
      return Number.isFinite(value) ? String(value).length : 4;
    case "string":
      return stringLength(value);
    case "object":
      break;
    default:
      /* undefined, function, symbol, bigint. The first three vanish or
         become `null` depending on where they sit, and bigint throws; all
         four are outside what a parsed envelope can contain. */
      return bail();
  }

  const object: object = value;
  /* A cycle would make `JSON.stringify` throw and this recurse forever. The
     set holds only the ancestors on the current path — a value repeated in
     two sibling branches is legal and must not be refused. */
  if (seen.has(object)) return bail();
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      // [] is 2; each element plus a comma between them.
      let total = 2 + Math.max(0, object.length - 1);
      for (const element of object) {
        /* A hole or an undefined element serialises as `null` — arrays do
           not drop members the way objects drop keys. */
        total +=
          element === undefined || typeof element === "function"
            ? 4
            : count(element, seen);
      }
      return total;
    }

    /* Anything with a `toJSON` is out of domain: what it returns is what
       gets serialised, and re-implementing that is how this function would
       come to disagree with the meter. `Date` is the common one. */
    if ("toJSON" in object) return bail();
    /* A plain object, and only a plain one. Map, Set, a class instance and
       a null-prototype object all serialise by rules this does not model. */
    const proto: unknown = Object.getPrototypeOf(object);
    if (proto !== Object.prototype) return bail();

    let total = 2; // {}
    let first = true;
    for (const [key, entry] of Object.entries(object)) {
      /* An undefined value drops the key entirely — the one place where a
         member costs nothing rather than four characters. */
      if (entry === undefined || typeof entry === "function") continue;
      total += (first ? 0 : 1) + stringLength(key) + 1 + count(entry, seen);
      first = false;
    }
    return total;
  } finally {
    seen.delete(object);
  }
}

/**
 * A string's serialised length, escapes included.
 *
 * Two characters for the quotes, then per code unit: two for the short
 * escapes, six for a control character without one — and six for a LONE
 * SURROGATE, which `JSON.stringify` has escaped since ES2019 so that its
 * output is always well-formed UTF-16. A base64 payload contains none of
 * these, but a site's prompt can, and a meter that is right only for the
 * common case is a meter somebody can be billed wrongly by.
 */
function stringLength(text: string): number {
  let total = 2;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      total += 2; // \" and \\
    } else if (code < 0x20) {
      // \b \t \n \f \r have two-character forms; the rest are \u00xx.
      total +=
        code === 0x08 ||
        code === 0x09 ||
        code === 0x0a ||
        code === 0x0c ||
        code === 0x0d
          ? 2
          : 6;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      const paired =
        code <= 0xdbff &&
        index + 1 < text.length &&
        text.charCodeAt(index + 1) >= 0xdc00 &&
        text.charCodeAt(index + 1) <= 0xdfff;
      if (paired) {
        total += 2; // a real pair passes through as its two code units
        index += 1;
      } else {
        total += 6; // \ud800 — a lone surrogate is escaped
      }
    } else {
      total += 1;
    }
  }
  return total;
}
