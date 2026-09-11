import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REFUSAL_TEXT, RefusalReason } from "./index.js";

/**
 * A reason code we publish ships with the sentence for it — B103.
 *
 * `JobRefused` and `RefusalReason` were exported and `REFUSAL_TEXT` was not, so
 * **we shipped the vocabulary and withheld the sentences.** Nothing in this
 * repository constructs a refusal: the producers are sites and the hub, and
 * every one of them would have written its own message for a reason code we
 * defined.
 *
 * `message` is a **required** field on `JobRefused`, so each of them had to
 * write something. That is the drift this table's own docstring argues against
 * — *"three refusals written in three places drift into three slightly
 * different sentences, and slightly different is all an oracle needs"* — made
 * inevitable by the export list rather than by anybody's carelessness.
 *
 * The seam was found by CW's audit under a plainer description: exported,
 * tested, never called. It was never called because the only callers it could
 * have are on the other side of the package boundary.
 */
describe("the refusal vocabulary", () => {
  it("is importable from the package, not just from inside it", () => {
    /* The whole fix in one line: `./index.js`, which is what
       `exports["."]` resolves to, rather than `./job.js`, which only this
       repository can reach. The old test imported the latter and passed
       throughout. */
    expect(typeof REFUSAL_TEXT).toBe("object");
  });

  it("has a sentence for every reason it publishes", () => {
    /**
     * The property that makes the table worth publishing, and the one a
     * consumer depends on: a reason with no sentence sends them straight back
     * to writing their own, which is the state this replaces.
     *
     * Derived from the schema rather than listed, so a reason added next month
     * fails here instead of shipping without its words.
     */
    for (const reason of RefusalReason.options) {
      expect(
        REFUSAL_TEXT[reason],
        `"${reason}" is published with no sentence, so every producer will ` +
          "write their own — which is what this table exists to stop",
      ).toBeTruthy();
    }
  });

  it("is named in the public export list, where a consumer would look", () => {
    /* Read, because the import above proves it RESOLVES and not that it is
       part of the surface on purpose — a symbol reachable by accident is one
       somebody removes without knowing it was load-bearing. */
    const index = readFileSync(
      fileURLToPath(new URL("./index.ts", import.meta.url)),
      "utf8",
    );
    expect(index).toContain("REFUSAL_TEXT");
  });
});
