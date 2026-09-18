import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every `npx` line we publish NAMES A PACKAGE npm can resolve — B224, renamed
 * under B243.
 *
 * **It was called `every-npx-command-resolves`, and that name was a lie by one
 * word.** It reads text; it has never run anything. CW found the difference the
 * expensive way: the `npx byollm-certify` line this check certifies as correct
 * **still failed**, because the command could not load a relative path — and
 * this file was green through every measurement, including the `pnpm verify`
 * that shipped the broken command.
 *
 * The law that came out of it: *a check whose name is a claim about what a
 * command does must run the command; reading the command is checking our
 * spelling.* This one checks our spelling, so it now says so. The execution
 * claim lives in `packages/conformance/test/the-command-runs.test.ts`, which
 * spawns the built bin from a directory that is not the package.
 *
 * What it still does, and it is worth having:
 *
 * ## The defect, on the page a stranger reaches first
 *
 * `@byollm/conformance`'s README said:
 *
 *     npx byollm-certify ./my-target.js
 *
 * **There is no package called `byollm-certify`.** It is a bin *inside*
 * `@byollm/conformance`, and `npx <name>` resolves a PACKAGE of that name — so
 * a reader following the kit's own npm page got:
 *
 *     npm error 404 Not Found - GET https://registry.npmjs.org/byollm-certify
 *
 * On the conformance kit, whose entire job is to be the thing somebody runs to
 * find out whether their integration works. Their first command failed, and
 * nothing in the error says the instruction was ours.
 *
 * It was in **three** published READMEs, which is why this is a check and not
 * an edit: `@byollm/conformance`, `@byollm/server` and `@byollm/relay` all
 * carried a bare bin name.
 *
 * ## The rule, and why there is only one
 *
 * A bin name on its own resolves **only** if the package is already installed.
 * So the line is fine when the package is named within a few lines — by an
 * install, or by `--package`/`-p` on the invocation — and broken when it is
 * not.
 *
 * My first version had two rules, one forbidding bare bins and one allowing
 * them beside an install, so a correctly-written line failed the first and
 * passed the second. A check that disagrees with itself teaches people to read
 * past it.
 */
const PACKAGES = "packages";

/** Every bin we publish, and the package that owns it. */
function published() {
  const bins = new Map();
  const names = new Set();
  for (const dir of readdirSync(PACKAGES)) {
    const manifest = join(PACKAGES, dir, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    if (pkg.private === true) continue;
    names.add(pkg.name);
    for (const bin of Object.keys(pkg.bin ?? {})) bins.set(bin, pkg.name);
  }
  return { bins, names };
}

const { bins, names } = published();

/** Published prose: the root README and every package README. */
function documents() {
  const found = [["README.md", readFileSync("README.md", "utf8")]];
  for (const dir of readdirSync(PACKAGES)) {
    const path = join(PACKAGES, dir, "README.md");
    if (existsSync(path)) found.push([path, readFileSync(path, "utf8")]);
  }
  return found;
}

describe("the npx lines we publish", () => {
  it("finds bins and documents, or this checks nothing", () => {
    /* The control. "No broken line" is satisfied perfectly by reading no
       lines, and this check's whole subject is a set it discovers. */
    expect(bins.size).toBeGreaterThan(0);
    expect(documents().length).toBeGreaterThan(3);
  });

  it("names a package, or has one named beside it", () => {
    const broken = [];
    for (const [where, text] of documents()) {
      const lines = text.split("\n");
      lines.forEach((line, at) => {
        const call = /\bnpx\s+(.+)$/u.exec(line);
        if (call?.[1] === undefined) return;
        const argv = call[1].trim().split(/\s+/);
        if (argv.some((token) => token === "--package" || token === "-p")) {
          return;
        }
        /**
         * Tokens with their markup stripped.
         *
         * **Fifth time tonight that decoration has defeated a comparison.** In
         * prose these lines are written `` `npx @byollm/server keygen` ``, so
         * the second token arrives as ``keygen` `` — backtick attached — and
         * matched no bin name. The mutation restoring the ambiguous form went
         * straight through a check written ten minutes earlier to catch it.
         *
         * Backticks, commas and full stops are how a shell command is quoted
         * inside a sentence; none of them is part of the command.
         */
        const words = argv
          .map((token) => token.replaceAll(/^[`'"(]+|[`'".,;:)]+$/gu, ""))
          .filter((token) => token !== "" && !token.startsWith("-"));
        const first = words[0];
        if (first === undefined) return;
        /* A package we publish resolves on its own — UNLESS a bin name
           follows it. `npx @byollm/server keygen` is the ambiguous form: npx
           takes the first word as the command and looks for a bin matching the
           package's own last segment, which is `server`, and there is no such
           bin. Whether it falls back to the package's only bin is a version
           detail, and a published instruction should not rest on one.

           **This is the hole that let five of these through an hour after I
           wrote the check.** The rule said "a package we publish resolves",
           and it does — as a package. It does not resolve as a route to a
           particular bin. */
        if (names.has(first.replace(/@[^@/]*$/u, ""))) {
          const second = words[1];
          if (second !== undefined && bins.has(second)) {
            broken.push(
              `${where}:${String(at + 1)} \`npx ${first} ${second}\` is the ` +
                "ambiguous form — npx reads the first word as the command. " +
                `Use \`npx --package ${first} ${second}\`.`,
            );
          }
          return;
        }
        const owner = bins.get(first);
        /* Not one of our bins: not ours to vouch for. */
        if (owner === undefined) return;
        /**
         * Ours, bare — so an INSTALL of the owner has to be nearby, or the
         * reader's first command is a 404.
         *
         * **An install, not a mention.** The first version accepted any line
         * containing the package name, and the relay README's prose two lines
         * above the block says *"`@byollm/conformance` ships a posture
         * audit…"* — so dropping `--package` from the command passed. That is
         * the third time tonight I have written "a mention is not a route"
         * into a check as a substring match, and the third time a mutation
         * caught it. Prose about a package does not install it.
         */
        const near = lines.slice(Math.max(0, at - 5), at + 3);
        /* Two plain conditions rather than one clever pattern: the line is an
           install, and the line names the owner. A `\\b` before `@byollm/...`
           matches nothing — `@` is not a word character, so there is no
           boundary between it and the space before it, and the first version
           of this silently accepted everything. */
        const installed = near.some(
          (line) =>
            /(npm|pnpm|yarn)\s+(install|add)\b/u.test(line) &&
            line.includes(owner),
        );
        if (installed) return;
        broken.push(
          `${where}:${String(at + 1)} \`npx ${first}\` is a bin of ${owner}, ` +
            `and npx looks for a PACKAGE called ${first}, which does not ` +
            "exist. Install the package beside it, or use --package.",
        );
      });
    }
    expect(
      broken,
      "a published document tells a reader to run a command that 404s",
    ).toEqual([]);
  });
});
