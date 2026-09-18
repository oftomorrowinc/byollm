import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The files GitHub puts in front of a stranger — B270, B271, B224.
 *
 * `CODE_OF_CONDUCT.md` was the last public-repo artifact owed, and the
 * repository has been public since before it existed: GitHub's community
 * profile and the new-issue screen both link a code of conduct, so the moment
 * it matters is the moment somebody is already annoyed enough to write.
 *
 * The byline is the other half. The root README's last line — the last thing a
 * reader sees, under the company's own name — linked `oftomorrow.dev`, which
 * has **no DNS record**, on a repository that was already public. Todd picked
 * `oftomorrow.net`, and `the-links-we-ship-resolve.mjs` now reports zero dead
 * links across the tree for the first time.
 *
 * ## Why these are asserted at all
 *
 * A file that exists is not the same as a file that says what was ruled. Both
 * of these are short, both were written by somebody else and pasted by me, and
 * the failure mode for both is silent: a code of conduct with no reporting
 * address is a form with no address on it, and a byline is the one link nobody
 * clicks until a stranger does.
 */

const root = (name) =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");

describe("the code of conduct", () => {
  it("exists at the root, where GitHub looks for it", () => {
    /* Anywhere else and the community profile does not find it, which is the
       only reason the file is worth having rather than a paragraph in
       CONTRIBUTING. */
    expect(
      existsSync(
        fileURLToPath(new URL("../CODE_OF_CONDUCT.md", import.meta.url)),
      ),
    ).toBe(true);
  });

  it("says where to report, with an address", () => {
    /**
     * The one line that has to be right. A code of conduct that describes
     * unacceptable behaviour and never says who to tell is a document that
     * makes a promise it cannot keep — and the address went through two
     * drafts, so it is worth pinning that the final one is what landed.
     */
    const conduct = root("CODE_OF_CONDUCT.md");
    expect(conduct).toMatch(/## Reporting/u);
    expect(conduct).toContain("support@byollm.cloud");
  });

  it("carries no personal address", () => {
    /**
     * `support@byollm.cloud` is the one public address from here on. An
     * earlier draft named an individual, and a personal address on a public
     * repository's conduct page is a channel nobody can hand over and a
     * mailbox that fills with things it should not have.
     */
    expect(root("CODE_OF_CONDUCT.md")).not.toMatch(
      /[a-zA-Z0-9._%+-]+@(?!byollm\.cloud)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/u,
    );
  });

  it("promises a person, and confidentiality, because both were ruled", () => {
    /* The two clauses that make the address worth writing to. Without them it
       is a form; with them it is a commitment somebody can hold us to. */
    const conduct = root("CODE_OF_CONDUCT.md");
    expect(conduct).toMatch(/reply from a person/u);
    expect(conduct).toMatch(/stays between you and the/u);
  });
});

describe("the byline", () => {
  it("does not link the domain that has no DNS record", () => {
    /**
     * Asserted by absence, because the fix is that the dead name is gone
     * rather than that a particular replacement arrived — and `oftomorrow.dev`
     * is exactly the kind of string that comes back in a paste.
     */
    expect(root("README.md")).not.toContain("oftomorrow.dev");
  });

  it("links the company site Todd picked", () => {
    expect(root("README.md")).toContain("https://oftomorrow.net");
  });

  it("is still the last line, which is what makes it a byline", () => {
    /* A byline halfway up the page is a sentence. The position is the claim. */
    const lines = root("README.md").trimEnd().split("\n");
    expect(lines[lines.length - 1]).toMatch(/Built by .*Of Tomorrow/u);
  });
});
