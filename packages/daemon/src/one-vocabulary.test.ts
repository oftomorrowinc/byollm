import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The words a person reads use this build's vocabulary.
 *
 * byollm_016 renamed the offer scopes: `self` became `private`, `named` became
 * `team`. Types moved, schemas moved, the compiler found every one — and two
 * strings survived, because a rename cannot see inside quotes:
 *
 *   `"team" was narrowed to "self": …`
 *   `"x" is not an offer scope — use self, named, or public`
 *
 * Both were read by an owner at the exact moment they were confused. The
 * second tells somebody to type a word this build refuses; the first describes
 * a scope that no longer exists, in a message about why their service was not
 * shared.
 *
 * Found by a person reading their own terminal, twice, hours apart. That is
 * the same defect the dashboard's `one-noun` lint exists for, and the same
 * argument: a word nobody can compile is a word nobody checks.
 *
 * **Scope: strings, not identifiers.** `self` is still a legal English word
 * and appears in prose; what is banned is the old *scope* vocabulary in text
 * a user sees, which is why the patterns below are anchored to the shapes
 * those messages actually take.
 */

const SRC = fileURLToPath(new URL(".", import.meta.url));

/** The retired scope words, in the shapes a message puts them in. */
const RETIRED: readonly { pattern: RegExp; was: string }[] = [
  { pattern: /narrowed to ["'`]self["'`]/i, was: "self is now private" },
  {
    pattern: /["'`]self["'`]\s*(?:,|or)\s*["'`]?named/i,
    was: "self/named are now private/team",
  },
  { pattern: /use self, named/i, was: "self, named are now private, team" },
  { pattern: /offered to ["'`]?named["'`]?\b/i, was: "named is now team" },
  {
    pattern: /scope.{0,20}\bnamed\b.{0,20}\bpublic\b/i,
    was: "named is now team",
  },
];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
      out.push(path);
  }
  return out;
}

/** Only what a user reads: the argument of an output call. */
const USER_FACING = /\b(?:io\.(?:out|err)|message:|detail:|throw new Error)\b/;

describe("what a person reads uses this build's words", () => {
  const files = sources(SRC);

  it("has sources to read", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("never shows a retired scope word", () => {
    const offenders: string[] = [];
    for (const path of files) {
      const lines = readFileSync(path, "utf8").split("\n");
      lines.forEach((line, index) => {
        // A comment explaining the rule has to be able to name what it bans,
        // and a test fixture has to be able to reproduce the old shape.
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
        for (const { pattern, was } of RETIRED) {
          if (!pattern.test(line)) continue;
          // Only inside something a user is shown, or a few lines under one:
          // these messages are built across several concatenated lines.
          const window = lines
            .slice(Math.max(0, index - 6), index + 1)
            .join("\n");
          if (!USER_FACING.test(window)) continue;
          offenders.push(
            `${path.replace(SRC, "")}:${String(index + 1)}  ${line.trim()}\n    (${was})`,
          );
        }
      });
    }
    expect(
      offenders,
      "these show a person a scope word this build does not accept:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("still recognises the messages that got through", () => {
    // The control, using the two real survivors verbatim. A regex that
    // stopped matching would pass this file for ever while the drift returned.
    expect(
      RETIRED[0]?.pattern.test('`"team" was narrowed to "self": ok`'),
    ).toBe(true);
    expect(
      RETIRED[2]?.pattern.test(
        'io.err(`"${scope}" is not an offer scope — use self, named, or public`)',
      ),
    ).toBe(true);
  });

  it("leaves the current words alone", () => {
    // The half that keeps this a guard rather than a nuisance.
    for (const { pattern } of RETIRED) {
      expect(pattern.test('narrowed to "private"')).toBe(false);
      expect(pattern.test("use private, team, or public")).toBe(false);
      expect(pattern.test("offered to team")).toBe(false);
    }
  });
});
