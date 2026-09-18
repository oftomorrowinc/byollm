import { describe, expect, it } from "vitest";
import { JOB_KINDS } from "./kinds.js";
// Imported through the package entry, not the module, so a bound that is not
// exported fails here rather than in whatever tries to use it downstream.
import { MAX_PURPOSES as EXPORTED_MAX_PURPOSES } from "./index.js";
import {
  DEFAULT_ROUTING,
  MAX_PURPOSES,
  Manifest,
  Purpose,
  RESERVED_PURPOSE,
  routingOf,
  singlePurposeManifest,
} from "./manifest.js";

/**
 * What a site may declare, and the one key it may not.
 *
 * Press's real v1, because a schema tested only against shapes invented to
 * pass it is a schema tested against itself.
 */
const PRESS = {
  books: {
    label: "Books",
    description: "Reads and parses your existing books for use across the site",
    kinds: ["llm.generate"],
  },
  "fact-checker": {
    label: "Fact Checker",
    description:
      "Reviews facts in your non-fiction work and builds the reference list",
    kinds: ["llm.generate"],
  },
  revenue: {
    label: "Revenue",
    description: "Analyzes your sales, revenue, and ad spend performance",
    kinds: ["llm.generate"],
  },
  "writing-assistant": {
    label: "Writing Assistant",
    description: "Outlining and brainstorming to beat the blank page",
    kinds: ["llm.chat", "llm.generate"],
  },
  "style-trainer": {
    label: "Style Trainer",
    description:
      "Trains a model on your writing style to generate draft content in your voice",
    kinds: ["llm.generate"],
  },
};

describe("a site's declared needs", () => {
  it("accepts press's manifest as written", () => {
    const parsed = Manifest.safeParse(PRESS);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("keeps a purpose that spans kinds", () => {
    // A mapping is per (purpose, kind), so `writing-assistant` produces two
    // slots and a person may send chat and generation to different services.
    const parsed = Manifest.parse(PRESS);
    expect(parsed["writing-assistant"]?.kinds).toEqual([
      "llm.chat",
      "llm.generate",
    ]);
  });

  it("allows a purpose with no description", () => {
    expect(
      Manifest.safeParse({ books: { label: "Books", kinds: ["llm.generate"] } })
        .success,
    ).toBe(true);
  });
});

describe("the reserved purpose", () => {
  it("is refused, and the refusal names the remedy", () => {
    // Structural rather than a check in whatever handles registration: a
    // reserved id enforced by the schema cannot be declared by a path
    // somebody forgot to route through the validator.
    const parsed = Manifest.safeParse({
      [RESERVED_PURPOSE]: { label: "Everything", kinds: ["llm.generate"] },
    });
    expect(parsed.success).toBe(false);
    const message = JSON.stringify(parsed.error?.issues);
    expect(message).toContain("reserved");
    expect(message).toContain("your own vocabulary");
  });

  it("is what a site with no purposes of its own gets", () => {
    // The sugar, made explicit here so nothing downstream needs a branch for
    // the flat-list case: a consent screen, a mapping table and a resolver
    // all see a manifest with one purpose.
    const sugar = singlePurposeManifest({
      label: "Of Tomorrow Press",
      kinds: ["llm.generate"],
    });
    expect(Object.keys(sugar)).toEqual([RESERVED_PURPOSE]);
    // The site's own name, because "default" renders to nobody.
    expect(sugar[RESERVED_PURPOSE]?.label).toBe("Of Tomorrow Press");
  });
});

describe("what a manifest may not be", () => {
  it("refuses a site that declares nothing", () => {
    // A site with no purposes can enqueue nothing. Accepting it would move
    // the first refusal from registration, where somebody is looking, to a
    // job, where nobody is.
    expect(Manifest.safeParse({}).success).toBe(false);
  });

  it("refuses a key that is not a slug", () => {
    // The key is an id on a signed document, not a display string. Anything
    // needing escaping, or carrying a separator, belongs in the label.
    for (const key of [
      "Writing Assistant",
      "writing_assistant",
      "writing assistant",
      "-leading-hyphen",
      "",
      "a\nb",
    ]) {
      expect(
        Manifest.safeParse({
          [key]: { label: "x", kinds: ["llm.generate"] },
        }).success,
        key,
      ).toBe(false);
    }
  });

  it("refuses a purpose that lists no kinds", () => {
    expect(
      Manifest.safeParse({ books: { label: "Books", kinds: [] } }).success,
    ).toBe(false);
  });

  it("refuses a kind this protocol does not have", () => {
    expect(
      Manifest.safeParse({
        books: { label: "Books", kinds: ["llm.video"] },
      }).success,
    ).toBe(false);
  });

  it("refuses a field it does not know", () => {
    // `.strict()` on the purpose: a field this version does not read is a
    // field a site believes it declared.
    expect(
      Manifest.safeParse({
        books: { label: "Books", kinds: ["llm.generate"], model: "gpt-4o" },
      }).success,
    ).toBe(false);
  });

  describe("what a person will actually read", () => {
    const withLabel = (label: string) =>
      Manifest.safeParse({ books: { label, kinds: ["llm.generate"] } }).success;

    it("refuses a label that reorders what follows it", () => {
      /**
       * The attack this rule exists for — byollm-review 2026-08-27.
       *
       * `U+202E` reverses the run after it, so a declared label renders as a
       * different sentence with every character individually innocent. This
       * is the one field the whole consent decision rests on: a person reads
       * it and says yes.
       */
      expect(withLabel("Read your files\u202E — tnatsissa gnitirW")).toBe(
        false,
      );
      for (const bidi of ["\u202A", "\u202B", "\u202D", "\u2066", "\u200F"]) {
        expect(withLabel(`Writing${bidi}Assistant`), bidi).toBe(false);
      }
    });

    it("refuses control characters, so one label cannot draw another row", () => {
      // A newline spoofs the rows around it on a consent screen and in the
      // notification mail; an ANSI escape corrupts a terminal when a CLI
      // prints the purpose; NUL truncates in whatever reads it next.
      expect(withLabel("Writing\nAssistant")).toBe(false);
      expect(withLabel("Writing\u001B[31mAssistant")).toBe(false);
      expect(withLabel("Writing\u0000Assistant")).toBe(false);
    });

    it("refuses zero-width padding, which is how two purposes look alike", () => {
      expect(withLabel("Books\u200B")).toBe(false);
      expect(withLabel("Bo\u200Doks")).toBe(false);
      expect(withLabel("Books\uFEFF")).toBe(false);
    });

    it("refuses a label that is only whitespace", () => {
      // Passes every rule above and renders as an empty row — a slot with no
      // question on it.
      expect(withLabel("   ")).toBe(false);
    });

    it("still accepts the prose a real site writes", () => {
      // The rule has to leave ordinary product copy alone, accents and
      // punctuation included, or it is a rule sites route around.
      for (const label of [
        "Writing Assistant",
        "Fact Checker",
        "Révision — français",
        "日本語のアシスタント",
        "Books & Revenue (beta)",
      ]) {
        expect(withLabel(label), label).toBe(true);
      }
    });

    it("holds the description to the same rule", () => {
      // It renders on the same screen, under the label it explains.
      const bad = Manifest.safeParse({
        books: {
          label: "Books",
          description: "Reads your books\u202E evil",
          kinds: ["llm.generate"],
        },
      });
      expect(bad.success).toBe(false);
    });
  });

  describe("bounds, so a manifest cannot be a denial of service", () => {
    it("refuses more purposes than a person could answer", () => {
      const many: Record<string, unknown> = {};
      for (let i = 0; i <= MAX_PURPOSES; i += 1) {
        many[`purpose-${String(i)}`] = {
          label: `Purpose ${String(i)}`,
          kinds: ["llm.generate"],
        };
      }
      expect(Manifest.safeParse(many).success).toBe(false);
    });

    it("accepts exactly the limit, so the bound is the number it says", () => {
      const many: Record<string, unknown> = {};
      for (let i = 0; i < MAX_PURPOSES; i += 1) {
        many[`purpose-${String(i)}`] = {
          label: `Purpose ${String(i)}`,
          kinds: ["llm.generate"],
        };
      }
      expect(Manifest.safeParse(many).success).toBe(true);
    });

    it("exports its own bound, so a consumer can respect it", () => {
      /**
       * The published package is the surface, not the module.
       *
       * `MAX_PURPOSES` was declared and never re-exported from the entry
       * point, so it shipped invisible: this suite imported it from
       * `./manifest.js` and passed, while `@byollm/protocol` had no such
       * name. A dashboard wanting to say "at most 32" would have had to
       * hard-code the number — a second copy of a bound, which is how the two
       * come to disagree.
       *
       * Found by loading the published tarball and reading its exports, after
       * a missing publish notification made it worth looking at the artifact
       * rather than the registry's metadata.
       */
      expect(EXPORTED_MAX_PURPOSES).toBe(MAX_PURPOSES);
    });

    it("refuses a kind listed twice", () => {
      // One purpose could declare the same kind a million times, every element
      // individually valid, and the screen renders a slot per (purpose, kind).
      const twice = Manifest.safeParse({
        books: { label: "Books", kinds: ["llm.generate", "llm.generate"] },
      });
      expect(twice.success).toBe(false);
    });

    it("accepts every kind there is, because that is the honest ceiling", () => {
      // The bound is derived from the vocabulary rather than chosen, so it
      // grows with the protocol instead of becoming a number to remember.
      const all = Manifest.safeParse({
        books: { label: "Books", kinds: [...JOB_KINDS] },
      });
      expect(all.success).toBe(true);
    });
  });
});

/**
 * The routing key, reserved before the wire is declared stable — B236.
 *
 * `Purpose` is `.strict()`, so there is no additive change to it: a key added
 * after launch is refused by every validator built before it, and the OSS
 * repository ships the server, so those validators will exist on machines
 * nobody can upgrade. The window for this field is the one that closes at
 * 0.1.0.
 *
 * Nothing reads it yet. That is what these assert.
 */
describe("routing — reserved, validated, not acted on", () => {
  const purpose = { label: "Writing Assistant", kinds: ["llm.chat"] };

  it("accepts each ruled lane, and no others", () => {
    /* The enum IS the reservation. A permissive `z.string()` would reserve
       the key and nothing else, and the first typo would become a lane. */
    for (const lane of [
      "user-choice",
      "site-fixed",
      "user-first-with-fallback",
    ]) {
      expect(
        Purpose.safeParse({ ...purpose, routing: lane }).success,
        `${lane} is a ruled lane and was refused`,
      ).toBe(true);
    }
    for (const notALane of ["site_fixed", "userChoice", "fallback", ""]) {
      expect(
        Purpose.safeParse({ ...purpose, routing: notALane }).success,
        `${JSON.stringify(notALane)} is not a lane and was accepted`,
      ).toBe(false);
    }
  });

  it("is optional, and a manifest without it is still a manifest", () => {
    expect(Purpose.safeParse(purpose).success).toBe(true);
  });

  it("does not appear in a parsed purpose that did not declare it", () => {
    /**
     * The field defeating its own purpose, which is the failure worth a test.
     *
     * A `.default("user-choice")` here would be applied at PARSE, so every
     * manifest read by anything becomes a manifest carrying the key — and a
     * hub that parses a site's manifest, stores it and serves it back would
     * hand that key to readers built before it. That is exactly the break
     * this reservation exists to prevent, performed by the reservation.
     *
     * Asserted on the parsed OUTPUT rather than on the schema's declaration,
     * because `.default()` is invisible from the input side: a purpose
     * without `routing` parses fine either way, and only the output says
     * which one happened.
     */
    const parsed = Purpose.parse(purpose);
    expect(Object.hasOwn(parsed, "routing")).toBe(false);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(purpose));
  });

  it("adds no key to a manifest and drops none, declared or not", () => {
    /**
     * One level up, because the manifest is the document a third party writes
     * by hand and a hub stores and serves back.
     *
     * The KEY SET is the property, not the bytes. My first version of this
     * asserted byte-identical round-tripping and it was false before I
     * touched anything: zod emits keys in the schema's declaration order, not
     * the document's, so a manifest written `{label, kinds}` comes back
     * reordered whatever this field does. Asserting bytes would have pinned
     * an accident and gone red on the next reordering of an unrelated field.
     *
     * What matters, and what `.strict()` plus an absent default actually buy,
     * is that nothing is invented and nothing is lost.
     */
    for (const written of [
      { writing: { label: "Writing", kinds: ["llm.chat"] } },
      {
        writing: {
          label: "Writing",
          kinds: ["llm.chat"],
          routing: "site-fixed",
        },
      },
    ]) {
      const parsed = Manifest.parse(written) as Record<
        string,
        Record<string, unknown>
      >;
      expect(Object.keys(parsed).sort()).toEqual(Object.keys(written).sort());
      expect(Object.keys(parsed["writing"] ?? {}).sort()).toEqual(
        Object.keys(written.writing).sort(),
      );
      expect(parsed).toEqual(written);
    }
  });

  it("answers the absent case in exactly one place", () => {
    /**
     * `routingOf`, so that when B232 and B233 finally act on this there is no
     * second opinion about what "not stated" meant. A `?? "user-choice"` at
     * each call site is how one fact becomes four, and three of them are
     * wrong the day the default changes.
     */
    expect(routingOf(Purpose.parse(purpose))).toBe("user-choice");
    expect(routingOf(Purpose.parse(purpose))).toBe(DEFAULT_ROUTING);
    expect(
      routingOf(Purpose.parse({ ...purpose, routing: "site-fixed" })),
    ).toBe("site-fixed");
  });

  it("is not read by anything that routes, which is the point today", () => {
    /**
     * `singlePurposeManifest` is the one constructor in this file, and a
     * purpose built by it carries no routing — so the sugar path and the
     * hand-written path agree about the absent case rather than one of them
     * quietly picking a lane.
     */
    const made = singlePurposeManifest({
      label: "Of Tomorrow Press",
      kinds: ["llm.chat"],
    });
    const only = made[RESERVED_PURPOSE];
    /* `Manifest` is a record, so its index type is optional — and an absent
       reserved purpose would make both assertions below vacuous rather than
       false. Named first so the failure says which thing went wrong. */
    expect(
      only,
      "singlePurposeManifest did not make the reserved purpose",
    ).toBeDefined();
    expect(Object.hasOwn(only ?? {}, "routing")).toBe(false);
    expect(routingOf(only ?? { label: "x", kinds: ["llm.chat"] })).toBe(
      DEFAULT_ROUTING,
    );
  });
});
