import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Exported, tested, and called by nothing — B103.
 *
 * The shape this catches is not dead code, which is obvious and gets deleted.
 * It is **a seam that looks finished**: a function with a docstring, a test
 * that passes, and no caller — so the reasoning in the docstring describes a
 * protection the product does not have.
 *
 * It was found twice in one night by reading, and both were the same story
 * one layer apart. `REFUSAL_TEXT` held the one sentence per refusal reason *"so
 * a message cannot vary by call site"* — and was not in the public export list,
 * so every producer outside this repository had to write its own.
 * `servicePlatform` held the three-way supervisor classification with its
 * simplification argued in a paragraph — while `defaultServiceIo` wrote the
 * same three branches out inline, carrying none of it.
 *
 * ## Why `knip` does not cover this
 *
 * Relay and control-plane are not in its workspaces, and the daemon's globs
 * count test files as consumers — so a symbol reached only by its own test
 * reads as used, which is exactly the state being looked for.
 *
 * ## What this alone does not catch, and what does
 *
 * **An import counts as a reference.** Delete the last CALL to a symbol and
 * leave its `import` behind, and this still sees it consumed — measured, by
 * removing `servicePlatform`'s caller and watching this stay green.
 *
 * `@typescript-eslint/no-unused-vars` is what closes that: the same edit fails
 * the lint with *"'servicePlatform' is defined but never used"*. Two checks,
 * one property, and neither holds it alone — said here rather than left for
 * somebody to discover, because a check that silently depends on another is
 * the one that goes quiet when the other moves.
 *
 * ## What is deliberately allowed, and why each one
 *
 * A test helper that lives in production source is legitimate and common: a
 * shared contract suite, a cache reset, a corpus. Naming them individually
 * with a reason is the point — *"we did not think of it"* and *"we decided
 * against it"* look identical in an absence, and only the second survives
 * review. An entry here is a claim somebody can argue with.
 */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const ALLOWED: Readonly<Record<string, string>> = {
  "relay/src/store-contract.ts: describeStoreContract":
    "a contract suite every store adapter runs against itself; its callers are " +
    "tests by construction, which is what a contract test IS",
  "control-plane/src/store-contract.ts: describePolicyStoreContract":
    "the same, for policy stores",
  "server/src/testing.ts: createHarness":
    "the SDK's test harness, shipped for site authors — a `testing.ts` whose " +
    "callers are tests is the file doing its job",
  "server/src/testing.ts: subscriptionCapabilities":
    "a fixture in the same harness",
  "daemon/src/test-support.ts: removeTemp":
    "the file is named for what it is; its callers are tests by design",
  "daemon/src/test-support.ts: noSupervisor": "same file, same reason",
  "daemon/src/test-support.ts: testControlPlane": "same file, same reason",
  "daemon/src/backends/claude-cli.ts: resetClaudeLaunchCache":
    "a reset hook for a module-level cache — only a test needs to un-warm it, " +
    "and the alternative is exporting the cache itself",
  "daemon/src/backends/quota.ts: observedQuotaCorpus":
    "the adversarial corpus B058 requires: real observed strings, kept beside " +
    "the parser they were observed against rather than in a fixture folder",
  "protocol/src/musts.ts: RETIRED_MUSTS":
    "history, and load-bearing history — a MUST that was retired must not be " +
    "silently re-used, so the list outlives its callers on purpose",
  "daemon/src/site-outcome.ts: siblingsOf":
    "derives the set of codes a site cannot tell apart, FOR the fence test — " +
    "the test is the consumer, and listing the siblings by hand there is the " +
    "convention it replaced",
};

function files(): { name: string; path: string; text: string }[] {
  const found: { name: string; path: string; text: string }[] = [];
  for (const pkg of readdirSync(ROOT)) {
    const dir = `${ROOT}${pkg}/src/`;
    let names: string[];
    try {
      names = readdirSync(dir, { recursive: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".ts")) continue;
      found.push({
        name: `${pkg}/src/${name}`,
        path: `${dir}${name}`,
        text: readFileSync(`${dir}${name}`, "utf8"),
      });
    }
  }
  return found;
}

describe("a seam that looks finished", () => {
  const all = files();
  const production = all.filter((file) => !file.name.includes(".test."));
  const entries = production.filter((file) => file.name.endsWith("/index.ts"));
  const published = entries.map((file) => file.text).join("\n");

  it("reads several packages, or it is a check about one folder", () => {
    /* B070's lesson, applied before the fact: a check that states a law about
       every package and reads one is the unguarded state wearing a tick. */
    const packages = new Set(production.map((file) => file.name.split("/")[0]));
    expect(packages.size).toBeGreaterThan(3);
  });

  it("finds no export that only its own test can reach", () => {
    const orphans: string[] = [];
    for (const file of production) {
      if (file.name.endsWith("/index.ts")) continue;
      const declarations =
        /^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm;
      for (const match of file.text.matchAll(declarations)) {
        const symbol = match[1] ?? "";
        const word = new RegExp(`\\b${symbol}\\b`, "g");
        /* Re-exported from an entry point is published API: its callers are
           other people's code, and this repository cannot see them. */
        if (word.test(published)) continue;

        const count = (text: string) => (text.match(word) ?? []).length;
        const here = count(file.text);
        const elsewhere = production
          .filter((other) => other.path !== file.path)
          .reduce((total, other) => total + count(other.text), 0);

        /* `here <= 1` is the declaration itself and nothing more — a symbol
           used inside its own file is consumed, whatever its export says. */
        if (here <= 1 && elsewhere === 0) {
          orphans.push(`${file.name}: ${symbol}`);
        }
      }
    }

    expect(
      orphans.filter((entry) => ALLOWED[entry] === undefined),
      "exported, tested, called by nothing — either give it the caller its " +
        "docstring describes, or name it in ALLOWED with the reason it is a " +
        "helper rather than a seam",
    ).toEqual([]);
  });

  it("keeps the allowance honest, so it cannot rot into a mute list", () => {
    /**
     * An allowlist nobody re-derives becomes a way to silence the check. Every
     * entry has to still BE an orphan — the day one gains a caller, its excuse
     * is stale and the line goes.
     *
     * This is the half that makes the list a set of claims rather than a set
     * of exceptions.
     */
    const stale = Object.keys(ALLOWED).filter((entry) => {
      const [name, symbol] = entry.split(": ");
      const file = production.find((candidate) => candidate.name === name);
      if (file === undefined) return true;
      const word = new RegExp(`\\b${symbol ?? ""}\\b`, "g");
      const here = (file.text.match(word) ?? []).length;
      const elsewhere = production
        .filter((other) => other.path !== file.path)
        .reduce(
          (total, other) => total + (other.text.match(word) ?? []).length,
          0,
        );
      return !(here <= 1 && elsewhere === 0);
    });
    expect(
      stale,
      "these are allowed as helpers and are no longer orphans — the excuse is " +
        "spent, and a list of spent excuses is how a check goes quiet",
    ).toEqual([]);
  });
});
