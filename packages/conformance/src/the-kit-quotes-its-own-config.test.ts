import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The kit's README quotes `vitest.config.ts`, so the quote has to be real.
 *
 * The "what a red means" section closes with a passage from this repository's
 * own test configuration — written about a slow Windows runner, long before
 * the conformance kit's reliability was under discussion:
 *
 * > A red build nobody can reproduce teaches people to hit rerun, and a suite
 * > whose failures are sometimes meaningless stops being read. That cost lands
 * > hardest on the first outside contributor, who cannot tell our flake from
 * > their mistake.
 *
 * It is quoted rather than paraphrased on purpose: the argument is stronger
 * for having been reached twice, from different evidence, by people who were
 * not talking to each other. **That strength depends entirely on the quote
 * being real.** An edit to `vitest.config.ts` would leave a published README
 * attributing words to a file that does not contain them — which is a
 * fabricated citation, in the package whose subject is whether a claim can be
 * trusted.
 *
 * So the block quote is compared to the source. If somebody improves that
 * comment, this fails and says to update the README rather than the other way
 * round.
 */
const README = fileURLToPath(new URL("../README.md", import.meta.url));
const CONFIG = fileURLToPath(
  new URL("../../../vitest.config.ts", import.meta.url),
);

/**
 * Prose wraps; the claim is the words, not the furniture around them.
 *
 * **Both markers, and the second one caught me twice tonight.** A markdown
 * blockquote's `>` and a JavaScript block comment's `*` both sit at the start
 * of a wrapped line — which means that once the newlines collapse, they land
 * in the MIDDLE of the sentence being compared. The first version of this
 * stripped `>` and not `*`, and failed against a file that contained the
 * quotation perfectly.
 *
 * A comparison of prose across two file types has to normalise both, or it is
 * comparing one language's decorations to another's.
 */
const words = (text: string): string =>
  text.replaceAll(/^\s*[>*]\s?/gm, "").replaceAll(/\s+/g, " ");

describe("the quotation in the kit's README", () => {
  it("is there at all, or this compares nothing", () => {
    const readme = readFileSync(README, "utf8");
    expect(readme).toContain("What a red means, and what it does not");
    expect(readme).toContain("vitest.config.ts");
  });

  it("matches the words `vitest.config.ts` actually contains", () => {
    const quoted = words(readFileSync(README, "utf8"));
    const source = words(readFileSync(CONFIG, "utf8"));
    const sentence =
      "A red build nobody can reproduce teaches people to hit rerun, and a " +
      "suite whose failures are sometimes meaningless stops being read. That " +
      "cost lands hardest on the first outside contributor, who cannot tell " +
      "our flake from their mistake.";

    expect(
      source,
      "vitest.config.ts no longer contains the sentence the kit's README " +
        "quotes — update the README, not this test",
    ).toContain(sentence);
    expect(quoted, "the kit's README no longer quotes it accurately").toContain(
      sentence,
    );
  });

  it("promises what a red does NOT mean, not only what it does", () => {
    /* The half a reader came for. A section that only explained the claim
       would be a restatement of the checks; the value is the sentence
       admitting the kit can be the one at fault. */
    const readme = words(readFileSync(README, "utf8"));
    expect(readme).toContain("you have no way to tell our defect from yours");
    expect(readme).toContain("It does not get its assertion loosened");
  });
});
