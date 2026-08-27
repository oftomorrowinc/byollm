import { describe, expect, it } from "vitest";
import {
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
});
