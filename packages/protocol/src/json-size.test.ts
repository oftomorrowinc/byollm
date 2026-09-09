import { describe, expect, it } from "vitest";
import { jsonLength } from "./json-size.js";

/**
 * The whole test is one sentence: it agrees with `JSON.stringify`, or it is
 * wrong — B060.
 *
 * This number is the billing meter as well as the cap, so "close enough" is a
 * job accepted at one size and charged at another. Everything below compares
 * against the real thing rather than against a number worked out by hand.
 */
const agrees = (value: unknown) => {
  const serialised = JSON.stringify(value) as string | undefined;
  const counted = jsonLength(value);
  return {
    counted,
    expected: serialised === undefined ? undefined : serialised.length,
  };
};

const ch = (code: number) => String.fromCharCode(code);
const CONTROLS = `${ch(0x08)}${ch(0x09)}${ch(0x0a)}${ch(0x0c)}${ch(0x0d)}`;
/** A control character with no short escape — six characters, not two. */
const RAW_CONTROL = ch(0x01);
const LONE_HIGH = ch(0xd800);
const LONE_LOW = ch(0xdfff);

const IN_DOMAIN: readonly unknown[] = [
  null,
  true,
  false,
  0,
  -1,
  1.5,
  1e21,
  1e-7,
  -0,
  "",
  "plain",
  'quotes " and \\ backslashes',
  CONTROLS,
  RAW_CONTROL,
  "unicode: é 日本語 🎉",
  "😀",
  [],
  {},
  [1, 2, 3],
  [[[[1]]]],
  { a: 1, b: "two", c: [3, { d: null }] },
  { 'key with " quote': "value" },
  { "": "empty key" },
  [null, true, "x"],
  { nested: { deeply: { and: { again: [1, 2, { z: "end" }] } } } },
];

describe("jsonLength", () => {
  it("agrees with JSON.stringify on every JSON value", () => {
    for (const value of IN_DOMAIN) {
      const { counted, expected } = agrees(value);
      expect(
        counted,
        `disagreed on ${(JSON.stringify(value) as string | undefined) ?? "undefined"}`,
      ).toBe(expected);
    }
  });

  it("escapes a lone surrogate the way JSON.stringify does", () => {
    /* Since ES2019 `JSON.stringify` emits well-formed UTF-16, so an unpaired
       surrogate becomes a six-character escape. Base64 never contains one; a
       site's prompt can, and a meter that is right only for the common case
       is one somebody can be billed wrongly by. */
    for (const text of [
      LONE_HIGH,
      `a${LONE_LOW}b`,
      `${LONE_HIGH}${LONE_HIGH}`,
      `${LONE_LOW}${LONE_HIGH}`,
    ]) {
      const { counted, expected } = agrees(text);
      expect(counted, JSON.stringify(text)).toBe(expected);
    }
  });

  it("drops an undefined object value and keeps an undefined array element", () => {
    /* The one asymmetry in JSON serialisation, and getting it backwards would
       misreport by four characters per member. */
    expect(agrees({ a: 1, b: undefined, c: 2 }).counted).toBe(
      JSON.stringify({ a: 1, b: undefined, c: 2 }).length,
    );
    expect(agrees([1, undefined, 2]).counted).toBe(
      JSON.stringify([1, undefined, 2]).length,
    );
  });

  it("counts a non-finite number as null, because that is what it becomes", () => {
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const { counted, expected } = agrees(value);
      expect(counted).toBe(expected);
    }
  });

  it("declines what it cannot promise, rather than guessing", () => {
    /**
     * Out of domain returns `undefined` and the caller serialises — the
     * failure direction is "no saving", never "a wrong number". A parsed
     * envelope contains none of these, which is why declining costs nothing.
     */
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    for (const value of [
      undefined,
      () => 1,
      Symbol("s"),
      new Date(0),
      new Map(),
      new Set(),
      Object.create(null) as object,
      cyclic,
      { nested: { deep: new Date(0) } },
    ]) {
      expect(jsonLength(value), typeof value).toBeUndefined();
    }
  });

  it("declines a PLAIN object carrying a toJSON, which is the case that hides", () => {
    /**
     * `Date` is refused by the prototype check before `toJSON` is ever
     * consulted, so deleting the `toJSON` guard changed nothing and the
     * mutation survived. The case it actually exists for is an ordinary
     * object literal with a `toJSON` method: its prototype IS
     * `Object.prototype`, so it walks straight past that check, and
     * `JSON.stringify` serialises **what the method returns** —
     * `{ toJSON: () => 1 }` is `1`, one character, not `{}`.
     *
     * Counting it as an object would have the meter disagree with the store
     * about a value the store would write as a number.
     */
    const withToJson = {
      toJSON() {
        return 1;
      },
    };
    expect(JSON.stringify(withToJson)).toBe("1");
    expect(jsonLength(withToJson)).toBeUndefined();
    expect(jsonLength({ nested: withToJson })).toBeUndefined();

    /* And the boundary: a NON-callable `toJSON` is not consulted at all, so
       the object serialises normally. Declining it is a lost saving rather
       than a wrong number, which is the direction this function fails in. */
    expect(JSON.stringify({ toJSON: 5, a: 1 })).toBe('{"toJSON":5,"a":1}');
  });

  it("counts a value that repeats across branches, which is not a cycle", () => {
    /* The seen-set holds ancestors only. Refusing a shared sub-object would
       send every envelope down the fallback and quietly undo the row. */
    const shared = { a: 1 };
    const { counted, expected } = agrees({ left: shared, right: shared });
    expect(counted).toBe(expected);
  });

  it("agrees on ten thousand random values", () => {
    /**
     * The cases above are the ones I thought of. This is for the ones I did
     * not — random structures over the whole JSON domain, with strings built
     * from the character classes that escape.
     */
    let seed = 20260910;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const CHARS = [
      "a",
      "Z",
      "0",
      " ",
      '"',
      "\\",
      "/",
      ch(0x0a),
      ch(0x09),
      RAW_CONTROL,
      "é",
      "日",
      "🎉",
      LONE_HIGH,
      LONE_LOW,
    ];
    const makeString = () => {
      let out = "";
      const length = Math.floor(random() * 12);
      for (let index = 0; index < length; index += 1) {
        out += CHARS[Math.floor(random() * CHARS.length)] ?? "a";
      }
      return out;
    };
    const make = (depth: number): unknown => {
      const roll = random();
      if (depth > 3 || roll < 0.3) {
        if (roll < 0.06) return null;
        if (roll < 0.12) return random() < 0.5;
        if (roll < 0.2) return Math.floor(random() * 1e6) - 5e5;
        return makeString();
      }
      if (roll < 0.65) {
        const length = Math.floor(random() * 4);
        return Array.from({ length }, () => make(depth + 1));
      }
      const out: Record<string, unknown> = {};
      const keys = Math.floor(random() * 4);
      for (let index = 0; index < keys; index += 1) {
        out[makeString()] = make(depth + 1);
      }
      return out;
    };

    for (let trial = 0; trial < 10_000; trial += 1) {
      const value = make(0);
      const { counted, expected } = agrees(value);
      if (counted !== expected) {
        throw new Error(
          `disagreed on ${JSON.stringify(value)}: counted ` +
            `${String(counted)}, stringify says ${String(expected)}`,
        );
      }
    }
  });
});
