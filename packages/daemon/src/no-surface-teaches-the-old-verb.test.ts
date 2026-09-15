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
/**
 * Every package's source, not this one's — B070.
 *
 * The docstring above states the law — *"a check reads every place its words
 * come from"* — and then this read `packages/daemon/src` and nothing else. **A
 * check scoped to one folder while claiming a law about every folder is the
 * unguarded state that produced B055**, which is the same shape one level up:
 * B040 verified the rename where it was easiest to look.
 *
 * Every surface is clean today, so this is not a live bug. It is the guard
 * that was missing when it was not — and the daemon is not the only thing that
 * prints: the SDK refuses jobs in sentences, the relay names commands in its
 * errors, and the conformance kit tells somebody what to run next.
 */
const PACKAGES = fileURLToPath(new URL("../../", import.meta.url));

/** This package, for the two cases that name a specific file on purpose. */
const HERE = fileURLToPath(new URL("./", import.meta.url));

/**
 * The repository, because source is not where most of the teaching happens —
 * B070's second half.
 *
 * `byollm_023` asks for *"every place the vocabulary is published — byollm's
 * READMEs, docs/, site/, examples/, the server and relay refusal strings"*.
 * Widening to `packages/*` covered the refusal strings and left the documents,
 * which is backwards from where a reader meets a command: **nobody learns a
 * verb from a string literal.**
 *
 * The web repo's prose is the one part that stays out, and it is B039's class
 * rather than an omission — a check cannot read another repository, and
 * `byollm_023` names the two shapes that would work (a copy over there, or a
 * rule shipped from a package both import) and the cost of each.
 */
const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/** Retired verbs, and what to say instead. `npm install` is not one of these. */
const RETIRED: Readonly<Record<string, string>> = {
  "byollm install": "byollm start",
  "byollm uninstall": "byollm stop",
  "byollm pause": "byollm stop",
  "byollm resume": "byollm start",
  "byollm models": "byollm services",
};

/**
 * A path this file can match on, whatever platform produced it.
 *
 * `readdirSync` yields `specs\\byollm_016-services.md` on Windows, and every
 * exclusion below is written with `/`. So `!name.startsWith("specs/")` was
 * false there, the working record was scanned as though it were a published
 * surface, and CI reported **17 retired verbs in our own design notes** — on
 * Windows only, which is why a green local run never showed it.
 *
 * Normalised once, where the names are produced, rather than at each of the
 * nine places that test them.
 */
const slashed = (name: string): string => name.split("\\").join("/");

/**
 * Read once, not once per case — and the reason is a Windows CI timeout.
 *
 * Both collectors walk a whole tree and read every file they keep. Six cases
 * call them, so the repository was being scanned six times; on
 * `windows-latest` that ran past vitest's 5s default and the file failed on
 * timeouts rather than on anything it asserts. Locally it is fast enough that
 * nothing showed.
 *
 * Memoised rather than given a longer timeout: the work was redundant, and a
 * raised timeout would have kept paying for it and hidden the next regression
 * in the same place.
 */
function once<T>(make: () => T): () => T {
  let held: T | undefined;
  return () => (held ??= make());
}

const sources = once((): { name: string; text: string }[] =>
  readdirSync(PACKAGES, { recursive: true, encoding: "utf8" })
    .map(slashed)
    .filter(
      (name) =>
        name.endsWith(".ts") &&
        !name.includes(".test.") &&
        /* Emitted copies of the same source, twice over. They would double
           every finding and name a path nobody can edit. */
        !name.includes("/dist/") &&
        !name.includes("/.tsbuild/") &&
        !name.includes("node_modules"),
    )
    .map((name) => ({
      name,
      text: readFileSync(`${PACKAGES}${name}`, "utf8"),
    }))
    .concat(published()),
);

/**
 * The documents, where a person actually learns a command.
 *
 * Read whole rather than through {@link printed}: markdown has no string
 * literals, and every word in it is published. The window rule below is what
 * keeps history writable here — a release note explaining the rename names both
 * verbs, so it passes for the same reason `byollm models takes no arguments …
 * use byollm services` does.
 */
const published = once((): { name: string; text: string }[] =>
  readdirSync(REPO, { recursive: true, encoding: "utf8" })
    .map(slashed)
    .filter(
      (name) =>
        (name.endsWith(".md") || name.endsWith(".html")) &&
        !name.includes("node_modules") &&
        !name.includes("/dist/") &&
        !name.startsWith("dist/") &&
        !name.includes("/.tsbuild/") &&
        /**
         * **`specs/` is not a surface, and neither is `coverage/`.**
         *
         * The spec asks for *"READMEs, docs/, site/, examples/"* and stops
         * there, which is right: `specs/` is our working record and it has to
         * be able to say the old word — a design note reading *"B040 renamed
         * `byollm install`"* is history, and a rule that forbade it would make
         * the reason unwriteable. **Exactly why comments are stripped out of
         * the source half**, one directory up.
         *
         * `coverage/` is generated HTML containing a copy of every source
         * file, so it would report each finding twice and name a path nobody
         * can edit.
         *
         * Run without these two, this found 22 occurrences and every one was
         * in them.
         */
        !name.startsWith("specs/") &&
        !name.startsWith("coverage/"),
    )
    .map((name) => ({
      name,
      text: readFileSync(`${REPO}${name}`, "utf8"),
    })),
);

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

/**
 * A longer timeout than the 5s default, and it is not hiding slow work.
 *
 * The collectors above are memoised now, so the repository is read ONCE per
 * run rather than once per case — the redundancy is gone. What is left is a
 * genuinely large single read (every `.ts`, `.md` and `.html` in the tree),
 * and on `windows-latest` that one read still runs past five seconds.
 *
 * Raised only after the redundancy was removed. A timeout raised first would
 * have made the symptom go away while the six-fold scan stayed, and the next
 * regression here would have been invisible for the same reason this one was.
 */
const SLOW_ENOUGH_FOR_A_COLD_WINDOWS_RUNNER = 60_000;

describe(
  "what the daemon prints",
  { timeout: SLOW_ENOUGH_FOR_A_COLD_WINDOWS_RUNNER },
  () => {
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
      expect(
        surface,
        "and that prose is not something it prints",
      ).not.toContain("byollm install");
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
        /* A document has no string literals and no comments — every word in it
         is published, so it is read whole. Stripping would delete the text. */
        const surface = /\.(md|html)$/.test(name) ? text : printed(text);
        for (const [retired, instead] of Object.entries(RETIRED)) {
          let at = surface.indexOf(retired);
          while (at !== -1) {
            const passage = surface.slice(
              Math.max(0, at - WITHIN),
              at + WITHIN,
            );
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
  },
);
