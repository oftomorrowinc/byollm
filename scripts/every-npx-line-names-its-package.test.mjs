import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  packageReadmes,
  rootReadme,
  site,
  text,
} from "./lib/published-surfaces.mjs";

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

/**
 * Published prose — the root README, every package README, **and the site**.
 *
 * `site/index.html` was missing, and it is the page somebody meets before any
 * README. It carries three `npx` lines today. This check exists because an
 * `npx` line naming a bin as though it were a package shipped to three
 * published READMEs; the surface it could not see is the most-read one.
 *
 * It is read through `text()`, which takes the markup off. A version of this
 * that simply added the path would have widened its coverage on paper: the
 * command is written `<code>npx byollm@latest connect</code>`, so without
 * stripping, the first token is `<code>npx` and every rule below silently
 * matches nothing. A case plants an ambiguous line in HTML and proves this one
 * catches it, because "we read that file now" is a claim like any other.
 *
 * The inventory lives in `lib/published-surfaces.mjs`: five gates here each
 * kept their own list of what we publish and no two agreed, so a new surface
 * had to be remembered five times by somebody who did not know there were
 * five. The scopes still differ on purpose — this one wants the site and not
 * CONTRIBUTING, because a contributor document is not where somebody's first
 * command comes from.
 */
function documents() {
  return [...rootReadme(), ...packageReadmes(), ...site()].map((path) => [
    path,
    text(path),
  ]);
}

/**
 * Every complaint one document earns, as a list of sentences.
 *
 * Hoisted out of the case so the fixtures below go through **this** code and
 * not a second copy of the rule written to agree with it. A fixture checked by
 * its own private matcher proves the matcher; it says nothing about the gate
 * that runs in `verify`.
 */
function problems(where, text) {
  const broken = [];
  const lines = text.split("\n");
  lines.forEach((line, at) => {
    const call = /\bnpx\s+(.+)$/u.exec(line);
    if (call?.[1] === undefined) return;
    const argv = call[1].trim().split(/\s+/);
    /**
     * Tokens with their markup stripped.
     *
     * **Fifth time that decoration has defeated a comparison.** In prose these
     * lines are written `` `npx @byollm/server keygen` ``, so the second token
     * arrives as ``keygen` `` — backtick attached — and matched no bin name.
     * The mutation restoring the ambiguous form went straight through a check
     * written ten minutes earlier to catch it.
     *
     * Backticks, commas and full stops are how a shell command is quoted
     * inside a sentence; none of them is part of the command.
     */
    const strip = (token) => token.replaceAll(/^[`'"(]+|[`'".,;:)]+$/gu, "");
    const flags = argv.map(strip);
    const words = flags.filter(
      (token) => token !== "" && !token.startsWith("-"),
    );

    /**
     * `npx --package <pkg> <bin>` — the form this check TELLS people to use,
     * and the one it used to skip outright, B304.
     *
     * A gate that recommends a form and then declines to read it guards
     * everything except its own advice. `npx --package @byollm/conformance
     * keygen` is a 404 with an extra step, and every sentence this file emits
     * points at it.
     */
    const flagAt = flags.findIndex((t) => t === "--package" || t === "-p");
    if (flagAt !== -1) {
      const named = flags[flagAt + 1];
      if (named === undefined) return;
      const pkg = named.replace(/@[^@/]*$/u, "");
      /* Not ours: not ours to vouch for. */
      if (!names.has(pkg)) return;
      const wanted = words.find((w) => bins.has(w));
      if (wanted === undefined) return;
      if (bins.get(wanted) === pkg) return;
      broken.push(
        `${where}:${String(at + 1)} \`--package ${pkg}\` does not ship ` +
          `\`${wanted}\` — that bin belongs to ${bins.get(wanted)}. The ` +
          "form is right and the pairing is wrong, which npx reports as a " +
          "missing command rather than a wrong package.",
      );
      return;
    }
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
        /(npm|pnpm|yarn)\s+(install|add)\b/u.test(line) && line.includes(owner),
    );
    if (installed) return;
    broken.push(
      `${where}:${String(at + 1)} \`npx ${first}\` is a bin of ${owner}, ` +
        `and npx looks for a PACKAGE called ${first}, which does not ` +
        "exist. Install the package beside it, or use --package.",
    );
  });
  return broken;
}

describe("the npx lines we publish", () => {
  it("finds bins and documents, or this checks nothing", () => {
    /* The control. "No broken line" is satisfied perfectly by reading no
       lines, and this check's whole subject is a set it discovers. */
    expect(bins.size).toBeGreaterThan(0);
    expect(documents().length).toBeGreaterThan(3);
  });

  it("names a package, or has one named beside it", () => {
    const broken = documents().flatMap(([where, body]) =>
      problems(where, body),
    );
    expect(broken, broken.join("\n")).toEqual([]);
  });

  it("reads the site, which is the page somebody meets first", () => {
    /* It was the READMEs only. `site/index.html` carries three npx lines and
       is what a stranger opens before any of them. */
    const where = join("site", "index.html");
    const entry = documents().find(([path]) => path === where);
    expect(entry, "the site is not in the document set").toBeDefined();

    /**
     * And that it arrives READABLE. Listing the path is the easy half; a
     * version that added it and passed the raw file would tokenise
     * `<code>npx` as the command and report the most-read page clean forever,
     * counting as coverage in the commit that claimed to add it.
     *
     * Asserted on the document set rather than on `text()` alone, because
     * what can rot is the wiring between them.
     */
    const body = entry?.[1] ?? "";
    expect(body).toContain("npx ");
    expect(
      /<(code|span|pre|div|p)\b/u.test(body),
      "the site is being read as raw HTML, so every rule below sees markup " +
        "where it expects a command",
    ).toBe(false);
  });
});

describe("the rule itself, on text the repository does not contain", () => {
  /**
   * Planted lines through the REAL rule — `problems` is the same function the
   * repository scan calls. A fixture graded by its own matcher proves the
   * matcher.
   */
  const anyBin = [...bins.keys()][0];
  const owner = bins.get(anyBin);
  const other = [...names].find((n) => n !== owner);

  it("has two packages and a bin to work with, or it proves nothing", () => {
    expect(anyBin).toBeDefined();
    expect(owner).toBeDefined();
    expect(other).toBeDefined();
  });

  it("catches a --package line paired with the wrong package", () => {
    /**
     * The form this check RECOMMENDS, and the one it used to skip outright: a
     * line containing `--package` returned before any rule ran. So every
     * sentence the file emits pointed at a spelling it declined to read, and
     * `npx --package <wrong> <bin>` — a 404 with an extra step — was invisible
     * to the gate built after exactly that class of defect shipped.
     */
    const found = problems("F.md", `    npx --package ${other} ${anyBin}`);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("does not ship");
  });

  it("passes the pairing that is right", () => {
    /* Without this the case above is satisfied by a rule that flags every
       --package line, which would be worse than skipping them. */
    expect(problems("F.md", `    npx --package ${owner} ${anyBin}`)).toEqual(
      [],
    );
  });

  it("still catches the ambiguous form the check was built for", () => {
    const found = problems("F.md", `    npx ${owner} ${anyBin}`);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("ambiguous form");
  });

  it("sees through HTML, or adding the site widened nothing", () => {
    /**
     * **The trap in this whole change.** The site writes its commands as
     * `<code>npx byollm@latest connect</code>`. A version that added the path
     * and read the raw file would tokenise `<code>npx` as the command, match
     * no package, report the file clean, and be counted as coverage — the
     * exact vacuous pass this repository keeps finding in its own gates, in
     * the commit that claimed to close a gap.
     *
     * So the planted line is real HTML, taken through `text()` the way the
     * document list takes it.
     */
    const html = `<p>Run <code>npx ${owner} ${anyBin}</code> to start.</p>`;
    const stripped = html
      .replaceAll(/<[^>]*>/gu, "")
      .replaceAll(/&lt;/gu, "<")
      .replaceAll(/&gt;/gu, ">")
      .replaceAll(/&quot;/gu, '"')
      .replaceAll(/&amp;/gu, "&");
    expect(problems("site/index.html", stripped)).toHaveLength(1);
    /* And that the stripping is what did it: the raw markup must NOT be
       readable, or this case would pass without `text()` existing. */
    expect(problems("site/index.html", html)).toHaveLength(0);
  });
});
