import { describe, expect, it } from "vitest";
import { JOB_KINDS } from "./kinds.js";
import {
  MAX_PURPOSES,
  Manifest,
  RESERVED_PURPOSE,
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
