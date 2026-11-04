import { describe, expect, it } from "vitest";
import { JobKind } from "./kinds.js";
import { NOT_YET, notYetFor, notYetSentence } from "./not-yet.js";

/**
 * The limits are one list, and the sentence is that list — Todd, 2026-10-06.
 *
 * The surfaces (README, byo-llm.com, byollm.cloud) are checked against
 * NOT_YET where they live. What only this module can prove is that the list
 * is whole, its kinds entry is the protocol's kinds, and the paragraph says
 * every entry.
 */
describe("NOT_YET", () => {
  it("names the five limits the post names, in its order", () => {
    expect(NOT_YET.map((n) => n.what.split(" ")[0])).toEqual([
      "tools",
      "access",
      "streaming",
      "job",
      "jobs",
    ]);
  });

  it("derives its job kinds from JobKind, not from a typed pair", () => {
    const kinds = NOT_YET.find((n) => n.what.startsWith("job kinds"));
    expect(kinds?.what.match(/\bllm\.[a-z]+\b/g)).toEqual(JobKind.options);
  });

  it("changes what it says the day a kind is added", () => {
    const added = notYetSentence(notYetFor([...JobKind.options, "llm.embed"]));
    expect(added).not.toBe(notYetSentence());
    expect(added).toContain(
      "llm.generate, llm.chat, llm.tools, llm.vision, llm.image and llm.embed",
    );
  });
});

describe("NOT_YET after 0.1.5 — byollm_012 §13, byollm_021 §11", () => {
  it("no longer says tool use is missing, bare", () => {
    // A site's own tools run now, on the site. Saying "no tool use" would be
    // false; saying nothing would hide what is still not there.
    expect(notYetSentence()).not.toContain("no tool use");
    expect(notYetSentence()).toContain("no tools that run on your device");
    expect(notYetSentence()).toContain("Claude or Codex subscriptions");
  });

  it("drops images and keeps audio", () => {
    expect(notYetSentence()).not.toContain("images yet");
    expect(notYetSentence()).toContain("audio yet");
  });
});

describe("notYetSentence", () => {
  it("says every entry, and its detail", () => {
    const sentence = notYetSentence();
    for (const { what, detail } of NOT_YET) {
      expect(sentence).toContain(`no ${what}`);
      if (detail) expect(sentence).toContain(detail);
    }
  });

  it("reads as the post's paragraph", () => {
    expect(notYetSentence()).toBe(
      "Things we know are limiting right now: no tools that run on your " +
        "device (a site's own tools run on its servers, and not yet on Claude " +
        "or Codex subscriptions), no access to your local files, no streaming " +
        "(a result comes back whole), no job kinds beyond llm.generate, " +
        "llm.chat, llm.tools, llm.vision and llm.image (no embeddings or audio " +
        "yet) and no jobs while your device is offline (your device has to be " +
        "online for your jobs to run). We have plans for every one of these, " +
        "and we are building in public.",
    );
  });
});
