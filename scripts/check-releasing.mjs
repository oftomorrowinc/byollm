/**
 * The release runbook must not state what `packages/` can be asked — B084.
 *
 * `docs/releasing.md` said *"Bump all four packages"*, named four of them,
 * and told an operator to re-word *"the alpha warning in the five READMEs"*.
 * There are six of each; relay and control-plane joined and the prose did
 * not. The scripts had already learned this — `bump-version.mjs` reads the
 * directory, and `release.yml` carries a comment about the same hardcoding
 * having missed `@byollm/relay` at alpha.58 — so the code learned the lesson
 * and the runbook did not.
 *
 * That is the worst possible file for it. The runbook is the fallback for
 * when the run summary is unavailable, which means it is consulted precisely
 * when something has already gone wrong, by somebody doing an irreversible
 * thing. It was wrong exactly when it was load-bearing.
 *
 * So the numbers and the name-lists in it are checked against the directory
 * rather than proof-read. Two rules, both computable:
 *
 * 1. A count of packages or READMEs must equal the real count.
 * 2. A shell loop over package names must name **all** of them. A partial
 *    list is the alpha.58 bug and the `404 PUT` on `@byollm/control-plane`,
 *    which this same document describes and then commits, in the one-time
 *    setup block an operator runs before a package can publish at all.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const doc = await readFile(new URL("docs/releasing.md", root), "utf8");

let failures = 0;
function check(name, ok, detail = "") {
  process.stdout.write(`  ${ok ? "✓" : "✗"} ${name}\n`);
  if (!ok) {
    failures += 1;
    if (detail) process.stdout.write(`      ${detail}\n`);
  }
}

process.stdout.write("\nrelease runbook\n");

/* The same rule the release workflow and the retag loop apply: every
   non-private manifest under `packages/`. Read, never typed — a check that
   hardcodes the list it is enforcing has the defect it is looking for. */
const packages = readdirSync(new URL("packages/", root))
  .map((dir) => ({
    dir,
    manifest: new URL(`packages/${dir}/package.json`, root),
  }))
  .filter(({ manifest }) => existsSync(manifest))
  .map(({ dir, manifest }) => ({
    dir,
    ...JSON.parse(readFileSync(manifest, "utf8")),
  }))
  .filter((pkg) => pkg.private !== true);

const readmes = packages.filter(({ dir }) =>
  existsSync(new URL(`packages/${dir}/README.md`, root)),
);

const WORDS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};
const numeral = (w) => WORDS[w.toLowerCase()] ?? Number(w);
const COUNTED = new RegExp(
  String.raw`\b(${Object.keys(WORDS).join("|")}|\d+)\s+` +
    /* Plural only. "the one package without a provenance attestation" is a
       definite article, not a count — and a genuine count of one would go
       unmatched, which the vacuity check above is there to notice. */
    String.raw`(?:published |publishable |remaining )?(packages|READMEs)\b`,
  "gi",
);

/**
 * A count next to a released version is history, and history does not
 * change. `alpha.6` left three packages live out of the five that existed;
 * making that sentence say six would be making it false to force a check
 * green — the check bending the document rather than the document being
 * wrong. Every other count is a claim about the set as it is today.
 */
const HISTORICAL = /alpha\.\d+/;
/* A bullet is its own scope. Taking the whole blank-line-delimited block
   swallowed a live count because a SIBLING bullet in the same list mentions
   `alpha.4` — a filter wide enough to excuse the thing it was meant to
   catch. The vacuity check above is what caught that. */
const BLOCK = /(?:\n\n|\n(?=- ))/g;
const blocks = [];
let at = 0;
for (const m of doc.matchAll(BLOCK)) {
  blocks.push({ start: at, end: m.index, text: doc.slice(at, m.index) });
  at = m.index + m[0].length;
}
blocks.push({ start: at, end: doc.length, text: doc.slice(at) });
const scopeAround = (index) =>
  blocks.find((b) => index >= b.start && index <= b.end)?.text ?? doc;

// 1. Every count in the prose that is about the set as it stands.
const counts = [...doc.matchAll(COUNTED)].filter(
  (m) => !HISTORICAL.test(scopeAround(m.index)),
);
check(
  `states a package count at all (${counts.length} found)`,
  counts.length > 0,
  "if this drops to zero the rule below is vacuous and this check is asleep",
);
for (const [text, word, noun] of counts) {
  const expected = /readme/i.test(noun) ? readmes.length : packages.length;
  check(
    `"${text.trim()}" matches the directory`,
    numeral(word) === expected,
    `packages/ has ${expected}: ${(/readme/i.test(noun) ? readmes : packages)
      .map((p) => p.name)
      .join(", ")}`,
  );
}

/**
 * 2. Every shell loop that names packages must name all of them.
 *
 * The one-time `npm trust` block listed five and omitted
 * `@byollm/control-plane` — the package that was then tagged without its
 * manual first publish and took a `404 PUT` mid-release, half-publishing a
 * version. The document describes that incident four paragraphs below the
 * loop that caused it.
 */
/* A backslash continuation is part of the list. Stopping at the first
   newline read a wrapped six-name loop as a truncated four-name one — the
   check reporting the very defect it was written to catch, in itself. */
const loops = [
  ...doc.matchAll(/for\s+\w+\s+in\s+((?:[^\n;\\]|\\\n)*)(?:;|\n)/g),
];
const named = loops.filter(([, list]) =>
  packages.some(
    ({ name, dir }) => list.includes(name) || list.includes(` ${dir}`),
  ),
);
check(
  `enumerating loops are still present (${named.length} found)`,
  named.length > 0,
  "no loop names a package, so the completeness rule below checks nothing",
);
for (const [, list] of named) {
  const missing = packages.filter(
    ({ name, dir }) =>
      !list.includes(name) && !new RegExp(`(^|\\s)${dir}(\\s|$)`).test(list),
  );
  check(
    `\`for ... in ${list.trim().slice(0, 44)}…\` names every package`,
    missing.length === 0,
    `missing: ${missing.map((p) => p.name).join(", ")}`,
  );
}

/**
 * 3. The three surfaces that name the note directory must agree.
 *
 * `tag.sh` refuses without the file, `release.yml` publishes it, and the
 * runbook tells a person to write it. Deleting the runbook step is a
 * mutation this check survived on purpose at first — the gate still holds,
 * so no release goes out noteless — but it puts the operator back to
 * discovering the rule by being refused by it, which is the state B084
 * started from. A check reads every place its words come from.
 */
const surfaces = {
  "scripts/tag.sh": await readFile(new URL("scripts/tag.sh", root), "utf8"),
  ".github/workflows/release.yml": await readFile(
    new URL(".github/workflows/release.yml", root),
    "utf8",
  ),
  "docs/releasing.md": doc,
};
for (const [where, text] of Object.entries(surfaces)) {
  check(
    `${where} names docs/release-notes/`,
    text.includes("docs/release-notes/"),
    "the gate, the publisher and the instructions have to point at one path",
  );
}

process.stdout.write(
  failures === 0
    ? "\n  the runbook matches packages/\n\n"
    : `\n  ${failures} runbook check(s) failed\n\n`,
);
process.exit(failures === 0 ? 0 : 1);
