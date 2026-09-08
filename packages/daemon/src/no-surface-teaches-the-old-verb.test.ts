import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Nothing this daemon prints tells anybody to type a retired verb.
 *
 * B040 renamed `install`/`uninstall` to `start`/`stop` and checked the
 * COMMAND SURFACE: `--help` no longer offers the old words, and the aliases
 * print a notice. Both true, and both about the same one screen.
 *
 * Every other screen went on teaching the old word. Kevin met it at the end
 * of `byollm connect` — "byollm install     keep it running in the
 * background (recommended)" — and he is the first person to arrive here
 * without the old vocabulary in his head, which is exactly who a rename is
 * for. There were eight more: the install success block's `remove:`, its
 * failure block's `retry:`, two `status` lines, the model-change advice, the
 * npx refusal, and `services`' PATH note.
 *
 * The check-surface law, which this repo already applies to product
 * vocabulary in SQL and in rendered strings: **a check reads every place its
 * words come from.** A rename verified on the help text is a rename verified
 * where it was easiest to look.
 *
 * ## What counts, and what does not
 *
 * Only text this daemon PRINTS. Comments explaining why a word changed have
 * to be able to say the old word — that is history, and forbidding it would
 * make the reason unwriteable. So this reads string and template literals,
 * and it deliberately does not try to parse TypeScript: the cheap version
 * that finds quoted text is enough to have caught all nine.
 *
 * And the rule is not "never say the old word". `byollm models takes no
 * arguments` is right: it names the command somebody actually typed, and
 * then points at `byollm services`. What is wrong is the old verb ALONE, as
 * the thing to do next. So an occurrence passes when the replacement is
 * beside it — the same window the docs' prose check settled on, for the same
 * reason: page-granular would let a bare instruction sit under a paragraph
 * that happened to mention the new word.
 */
const HERE = fileURLToPath(new URL("./", import.meta.url));

/** Retired verbs, and what to say instead. `npm install` is not one of these. */
const RETIRED: Readonly<Record<string, string>> = {
  "byollm install": "byollm start",
  "byollm uninstall": "byollm stop",
  "byollm pause": "byollm stop",
  "byollm resume": "byollm start",
  "byollm models": "byollm services",
};

function sources(): { name: string; text: string }[] {
  return readdirSync(HERE, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
    .map((name) => ({ name, text: readFileSync(`${HERE}${name}`, "utf8") }));
}

/**
 * Everything inside quotes, with comments removed first.
 *
 * Comments go first because a `//` inside a string would otherwise eat the
 * rest of the line, and because the whole point is to read what is printed
 * rather than what is explained.
 */
function printed(text: string): string {
  const withoutComments = text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ");
  return [...withoutComments.matchAll(/`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"/g)]
    .map((hit) => hit[0])
    .join("\n");
}

describe("what the daemon prints", () => {
  it("has strings to read, and they mention the new verbs", () => {
    /* The control. A stripper that returned nothing would satisfy every
       assertion below — which is the failure mode of exactly this kind of
       check, and the reason this one is here. */
    const all = sources()
      .map(({ text }) => printed(text))
      .join("\n");
    expect(all.length).toBeGreaterThan(5_000);
    expect(all).toContain("byollm start");
  });

  it("keeps the old words out of the comments' way", () => {
    /* The other half of the control: the stripper must actually strip, or
       this file would fail on its own history-explaining comments and
       somebody would weaken the rule to make it pass. */
    const surface = printed(readFileSync(`${HERE}revoked.ts`, "utf8"));
    const whole = readFileSync(`${HERE}revoked.ts`, "utf8");
    expect(whole, "revoked.ts explains the old verb in prose").toContain(
      "byollm install",
    );
    expect(surface, "and that prose is not something it prints").not.toContain(
      "byollm install",
    );
  });

  it("reports what `start` did in the word `start` uses", () => {
    /**
     * CW's rider on this sweep, and it is the subtler half: `byollm start`
     * printed "Installed." — a word that is no longer any command's name.
     *
     * Not an instruction, so the rule below does not see it, and no test
     * asserted the line at all, which is how it survived three passes. It
     * leaves the reader holding the old vocabulary at the one moment they
     * are being taught the new one.
     */
    const install = readFileSync(`${HERE}install.ts`, "utf8");
    const surface = printed(install);
    expect(surface).toContain("Started.");
    expect(
      surface,
      "`start` must not report its success as an install",
    ).not.toContain("Installed.");
  });

  it("never tells anybody to type one without naming the new one", () => {
    /* Roughly a screen either side, so a refusal that echoes what somebody
       typed and then points at the replacement is fine, and a bare
       instruction is not. */
    const WITHIN = 300;
    const offences: string[] = [];
    for (const { name, text } of sources()) {
      const surface = printed(text);
      for (const [retired, instead] of Object.entries(RETIRED)) {
        let at = surface.indexOf(retired);
        while (at !== -1) {
          const passage = surface.slice(Math.max(0, at - WITHIN), at + WITHIN);
          if (!passage.includes(instead)) {
            offences.push(
              `${name}: "${retired}" at ${String(at)} — say "${instead}"`,
            );
          }
          at = surface.indexOf(retired, at + retired.length);
        }
      }
    }
    expect(
      offences,
      "a screen that instructs a retired verb is the rename undone on " +
        "every surface except the one that was checked",
    ).toEqual([]);
  });
});
