import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_ENVELOPE_BYTES, describeBytes, tooLargeMessage } from "./index.js";

/**
 * One rounding rule, and nowhere else to keep a second — B072.
 *
 * The relay found that `toFixed` prints "this message is 10.5 MB and the
 * limit is 10.5 MB" for a message one byte over, fixed it with a ceiling, and
 * wrote the reasoning down beside the fix. The SDK's refusal then
 * rediscovered the identical bug, because it copied the SENTENCE rather than
 * the function — and a sentence carries everything about itself except the
 * part that was learned.
 *
 * Same shape as `MAX_BODY_BYTES` drifting from `MAX_ENVELOPE_BYTES`, and the
 * same answer: neither side holds the rule.
 */
describe("how a size is described", () => {
  it("rounds up, so a message over the line never prints as equal to it", () => {
    const over = MAX_ENVELOPE_BYTES + 1;
    expect(describeBytes(over)).not.toBe(describeBytes(MAX_ENVELOPE_BYTES));
    expect(Number.parseFloat(describeBytes(over))).toBeGreaterThan(
      Number.parseFloat(describeBytes(MAX_ENVELOPE_BYTES)),
    );
  });

  it("rounds up rather than to nearest, which is the bug it exists for", () => {
    /* 10.44 MB rounds to 10.4 under `toFixed` and must read 10.5 here: the
       question is "how much do I have to lose", and the answer must never be
       smaller than the truth. */
    const bytes = 10.44 * 1024 * 1024;
    expect(describeBytes(bytes)).toBe("10.5 MB");
  });

  it("says the size, the limit, that it is per message, and what to do", () => {
    const said = tooLargeMessage({
      bytes: 11 * 1024 * 1024,
      limit: MAX_ENVELOPE_BYTES,
    });
    expect(said).toMatch(/this message is [\d.]+ MB/);
    expect(said).toMatch(/the limit is [\d.]+ MB/);
    expect(said).toContain("one message");
    expect(said).toContain("Split the work");
  });

  it("says nothing about plans, because one caller has none", () => {
    /**
     * The half that deliberately did NOT move. "Every plan has the same
     * ceiling" is a hosted sentence and means nothing to somebody
     * self-hosting the direct lane, where there are no plans. One rule, two
     * audiences: the rule travels, the words about our billing do not.
     */
    const said = tooLargeMessage({ bytes: 1, limit: 2 });
    expect(said).not.toMatch(/plan/i);
  });
});

describe("where a size may be formatted", () => {
  /**
   * The structural half. The tests above prove the shared function is right;
   * this proves there is nowhere else to write a second one — which is the
   * failure that actually happened, and it happened in a file whose author
   * had read the first one.
   */
  const ROOT = fileURLToPath(new URL("../../", import.meta.url));

  function sources(pkg: string): { name: string; text: string }[] {
    const dir = `${ROOT}${pkg}/src/`;
    return readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
      .map((name) => ({
        name: `${pkg}/src/${name}`,
        text: readFileSync(`${dir}${name}`, "utf8"),
      }));
  }

  it("has sources to read, or this checks nothing", () => {
    expect(sources("relay").length + sources("server").length).toBeGreaterThan(
      5,
    );
  });

  it("is only in the protocol — nobody else does the arithmetic", () => {
    /**
     * Bare `toFixed`, not `toFixed` beside `1024 * 1024` — B074.
     *
     * The conjunction caught **one spelling of six**. `bytes / 1048576`,
     * `bytes / 1024 ** 2`, `bytes / MiB`, a division by a named constant, a
     * value already in megabytes — every one of them renders a size and none
     * of them matches. The pattern was narrowed to avoid false positives, and
     * **the false positives do not exist**: measured, `relay` and `server`
     * contain no `toFixed` outside comments at all, so the narrowing bought
     * nothing and cost five spellings.
     *
     * Comments are stripped first, because `http.ts` explains the rounding bug
     * in prose and naming `toFixed` is how it explains it. **Forbidding the
     * word in a comment would make the reason unwriteable** — the same rule
     * the vocabulary check follows, for the same reason.
     *
     * Still scoped to the two lanes that render a MESSAGE size. The daemon
     * formats memory in GB in several places and that is a different quantity
     * with a different rounding argument: *"how much must I lose"* must never
     * round down, and *"how much is free"* must never round up. Folding them
     * together here would assert one rule over two decisions.
     */
    const stripped = (text: string): string =>
      text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    const offenders = [...sources("relay"), ...sources("server")]
      .filter(({ text }) => /toFixed\s*\(/.test(stripped(text)))
      .map(({ name }) => name);
    expect(
      offenders,
      "size rendering belongs to `describeBytes`; a second copy is how the " +
        "ceiling rule was rediscovered as a bug",
    ).toEqual([]);
  });
});
