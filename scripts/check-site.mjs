#!/usr/bin/env node
/**
 * Keep the landing page honest.
 *
 * byollm_005 says every code sample executes in CI so docs cannot rot. The
 * page is static HTML, so its samples cannot literally be run — but the thing
 * that actually rotted was cheaper to catch than that: it named a package that
 * had been renamed, imported `createHandler` from the wrong entry point, and
 * called an `enqueue(store, …)` function that does not exist. Every one of
 * those is a string that should have matched a real export and didn't.
 *
 * So this asserts the page against the built packages: the names it mentions
 * exist, the symbols it shows are exported from the entry point it shows them
 * on, the version it claims matches the manifest, its anchors resolve, and it
 * loads nothing from the network.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const html = await readFile(new URL("site/index.html", root), "utf8");

let failures = 0;
function check(name, ok, detail = "") {
  process.stdout.write(`  ${ok ? "✓" : "✗"} ${name}\n`);
  if (!ok) {
    failures += 1;
    if (detail) process.stdout.write(`      ${detail}\n`);
  }
}

process.stdout.write("\nlanding page\n");

// 1. Names it mentions must be ones we actually publish. The daemon was
//    renamed from `@byollm/daemon` to the bare `byollm` at first publish, and
//    the page kept the old name for a week.
const RENAMED = ["@byollm/daemon"];
for (const dead of RENAMED) {
  check(`does not mention the renamed package ${dead}`, !html.includes(dead));
}

// 2. Symbols shown in code samples must be exported where the sample says.
const ENTRIES = {
  "@byollm/server": new URL("packages/server/dist/index.js", root),
  "@byollm/server/next": new URL("packages/server/dist/next.js", root),
  "@byollm/server/supabase": new URL(
    "packages/server/dist/supabase/index.js",
    root,
  ),
};
const SAMPLE_SYMBOLS = [
  ["createHandler", "@byollm/server/next"],
  ["supabaseStore", "@byollm/server/supabase"],
];
for (const [symbol, entry] of SAMPLE_SYMBOLS) {
  if (!html.includes(symbol)) continue;
  const mod = await import(fileURLToPath(ENTRIES[entry])).catch(() => null);
  check(
    `${symbol} is exported from ${entry}`,
    mod !== null && typeof mod[symbol] !== "undefined",
    mod === null
      ? "entry point failed to import — run `pnpm build`"
      : "not exported",
  );
}

// 3. A sample importing a symbol from the wrong entry point is the exact bug
//    that shipped, so assert the pairing, not just existence. Checked against
//    the code with its syntax-highlighting markup stripped out — matching
//    against the raw HTML is how a check ends up unable to fail.
const code = html
  .replace(/<[^>]+>/g, "")
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, "&");

const WRONG_IMPORTS = [
  [
    'import { createHandler } from "@byollm/server"',
    "createHandler lives in @byollm/server/next; the root exports createFetchHandler",
  ],
  [
    "enqueue(store,",
    "there is no bare enqueue(store, …) — enqueue is a method on ByollmApp",
  ],
];
for (const [snippet, why] of WRONG_IMPORTS) {
  check(`does not show \`${snippet}\``, !code.includes(snippet), why);
}

// 4. The version it advertises must be the version we ship.
const manifest = JSON.parse(
  await readFile(new URL("packages/daemon/package.json", root), "utf8"),
);
check(
  `advertises the shipped version (${manifest.version})`,
  html.includes(manifest.version),
  "the alpha banner names a different version than package.json",
);

// 5. Install commands must ask for @latest, and must ask for something.
//
//    This required `@alpha`, and the reason it gave was true when it was
//    written: a bare `npx byollm` resolves to whatever `latest` happens to
//    point at, and `latest` pointed at nothing anybody should install.
//
//    It is the wrong way round now. `alpha` is the tag the release publishes
//    under — it moves FIRST, on every cut — and `latest` moves later, by
//    hand, after a review says the build is fit to be the default. So
//    demanding `@alpha` sent every new reader to the least-scrutinised build
//    in the registry, which is the opposite of what pinning was for.
//
//    Ruled in byollm-cloud-web as B014 and enforced there since; this
//    repository went on enforcing the old rule, which is two repositories
//    giving opposite instructions for the same command.
const bareNpx = /npx byollm(?!@latest)(?!-certify)/.test(html);
check("every npx invocation pins @latest", !bareNpx);

// 6. Internal anchors must resolve.
const anchors = [...html.matchAll(/href="#([\w-]+)"/g)].map((m) => m[1]);
const ids = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
const dangling = anchors.filter((a) => !ids.has(a));
check(
  "every in-page anchor resolves",
  dangling.length === 0,
  dangling.join(", "),
);

// 7. Self-contained: byollm_005 requires it open from a file and deploy to any
//    static host with zero build, so nothing may be *fetched* from a CDN.
//    Only loading attributes count — an outbound <a href> is a link, not a
//    dependency, and treating the two alike flagged every honest link.
const loads = [
  ...html.matchAll(/<script[^>]+src="(https?:\/\/[^"]+)"/g),
  // Only <link> rels that actually fetch. `canonical` is metadata: it names
  // the page's own address and loads nothing.
  ...html.matchAll(
    /<link[^>]+rel="(?:stylesheet|preload|prefetch|icon|manifest)"[^>]*href="(https?:\/\/[^"]+)"/g,
  ),
  ...html.matchAll(/<img[^>]+src="(https?:\/\/[^"]+)"/g),
].map((m) => m[1]);
check("fetches nothing from the network", loads.length === 0, loads.join(", "));

// 8. target="_blank" without rel="noopener" hands the opener to the
//    destination. Cheap to get wrong, cheap to assert.
const blanks = [...html.matchAll(/<a\s[^>]*target="_blank"[^>]*>/g)].map(
  (m) => m[0],
);
const unsafe = blanks.filter((a) => !/rel="[^"]*noopener/.test(a));
check(
  "every target=_blank sets rel=noopener",
  unsafe.length === 0,
  unsafe.join(" "),
);

// 9. The providers table must list every provider we actually ship.
//
//    The page was written when the registry held seventeen entries and stated
//    the number in a heading. Adding `anthropic` made every one of those
//    claims wrong at once — the count, the table, and the promise that this
//    is the directory. A page that undercounts is worse than one that never
//    listed them: a reader concludes their provider is unsupported and goes
//    elsewhere.
//
//    Each row carries `data-provider="<registry id>"`, so this compares ids
//    to ids. Matching on the visible label instead would mean guessing that
//    "Google Gemini (your API key)" and a cell reading "Gemini" are the same
//    thing — a guess that fails open, which is the direction that lets a
//    provider quietly go missing.
const { BACKEND_IDS, BACKENDS } = await import(
  new URL("packages/protocol/dist/index.js", root)
);

/**
 * The numbers the page says out loud, against the things they count.
 *
 * Added after adding two package cards left "Four small pieces" above six of
 * them — and the same read found "Five endpoints" beside a protocol that has
 * six. Neither was caught by anything here: this file asserted that the NAMES
 * on the page exist, and never that a COUNT on the page was the count.
 *
 * A number in prose is a claim about a list, and this codebase already has
 * the rule for that one level down — a registry is a schema, an enum value is
 * the contract. A count is the contract too, and it is the kind that goes
 * wrong silently the moment somebody adds the thing being counted, which is
 * exactly how it went wrong.
 *
 * Written as words on the page because that is how the page reads, so the
 * check has to speak both.
 */
const WORDS = Object.freeze({
  1: "One",
  2: "Two",
  3: "Three",
  4: "Four",
  5: "Five",
  6: "Six",
  7: "Seven",
  8: "Eight",
  9: "Nine",
  10: "Ten",
  19: "Nineteen",
});
const { ENDPOINTS } = await import(
  new URL("packages/protocol/dist/index.js", root)
);
const endpointCount = Array.isArray(ENDPOINTS)
  ? ENDPOINTS.length
  : Object.keys(ENDPOINTS).length;
/**
 * Claims we have retired, wherever they are — B083.
 *
 * The h1 and the hero trio were changed and the SAME two claims were sitting
 * in `twitter:description`, which is the copy every link preview on X and
 * LinkedIn reads. Fix the visible one and the shared one goes on saying the
 * old thing to everybody who never opens the page. Fifth and sixth instance
 * of the one-fact-many-places shape this sweep exists for.
 *
 * A retired claim is not a typo — it is a sentence somebody decided was no
 * longer true, and the decision has to reach every copy of it or the decision
 * did not happen. So the words are banned rather than corrected: the check
 * cannot know where the next copy will be, and does not need to.
 *
 * `README.md`'s "the compute comes from the user" is NOT here, deliberately.
 * byollm_018 falsifies it and 018 has not shipped, so banning it now would
 * redden CI for a sentence that is still true. It is noted on 018's copy
 * section, which is where instruction 7 says a sentence with a known expiry
 * belongs.
 */
const RETIRED_CLAIMS = Object.freeze([
  [
    "no keys leaving the box",
    "keys are shared with nobody; they do not merely stay put",
  ],
  [
    "No keys leave their computer",
    "same claim, same reason — 'no shared keys'",
  ],
  [
    "on their own computers",
    "replaced by 'on devices they control' — a device is not always a computer",
  ],
  [
    "actually there and healthy",
    "consent and reachability are two promises; one clause strained",
  ],
]);
for (const [claim, why] of RETIRED_CLAIMS) {
  check(
    `does not repeat the retired claim "${claim.slice(0, 34)}"`,
    !html.includes(claim),
    why,
  );
}

/**
 * The cost classes the table shows, against the classes that exist.
 *
 * The table's Cost column is a list the registry owns — `free`, `metered`,
 * `subscription` — restated as prose. Nothing checked that the page shows all
 * of them or that everything it shows is real, so a fourth class would arrive
 * with the table silently one short, and a typo in a cell would read as a
 * class nobody has.
 *
 * Same shape as the counts above, and the same reason: this page keeps
 * restating things the build can compute.
 */
const registryCosts = new Set(
  BACKEND_IDS.map((id) => BACKENDS[id].cost).filter((cost) => cost !== null),
);
/* Any `tag` span, not one CSS class of them: the page styles `free` as
   `tag self` and `metered`/`subscription` as `tag lock`, and a check that
   knew only the first would report the page missing two classes it shows
   plainly. Which is what the first version of this did. */
const shownCosts = new Set(
  [...html.matchAll(/<span class="tag [\w-]+">(\w+)<\/span>/g)].map(
    (m) => m[1],
  ),
);
for (const cost of registryCosts) {
  check(
    `the providers table shows the ${cost} cost class`,
    shownCosts.has(cost),
    `the registry has a ${cost} class and the table never shows it`,
  );
}

/**
 * The config the page tells somebody to write, put through the real schema.
 *
 * B081b changed `"backend": "local"` to `"backend": "ollama"` and left a
 * snippet the daemon still rejects, because the VALUE was not the only thing
 * wrong with it: `backend` was renamed to `type`, and config is keyed by
 * service name with `kinds` listing the job kinds rather than keyed by job
 * kind. Two people looked at that line in one evening and both fixed the part
 * they were pointed at.
 *
 * So this stops reading it and starts running it. A snippet that parses is a
 * snippet somebody can paste; anything less is a guess about a schema that is
 * sitting right there and can be asked.
 */
const { DaemonConfig } = await import(
  new URL("packages/daemon/dist/index.js", root)
);
const snippet = /<code>("[\w.:-]+"\s*:\s*\{[^<]*\})<\/code>/.exec(html);
check(
  "the page's config snippet is one the daemon would accept",
  snippet !== null &&
    DaemonConfig.safeParse({
      services: JSON.parse(`{${snippet[1].replaceAll("&quot;", '"')}}`),
    }).success,
  snippet === null
    ? "no config snippet found on the page — if it moved, this check went quiet with it"
    : "the page shows a config the daemon rejects; run it through DaemonConfig rather than reading it",
);

/* Cards, counted the way a reader counts them: one npm link each. */
const cardCount = new Set(
  [...html.matchAll(/npmjs\.com\/package\/(@?[\w/-]+)/g)].map((m) => m[1]),
).size;

for (const [label, count, sentence] of [
  ["package cards", cardCount, "small pieces"],
  ["protocol endpoints", endpointCount, "endpoints, lease semantics"],
  /* The provider count is asserted below, by the check that already owned
     it — one fact, one assertion. */
]) {
  const word = WORDS[count];
  check(
    `the page's ${label} count says ${String(count)}`,
    word !== undefined && html.includes(`${word} ${sentence}`),
    `the page should read "${String(word)} ${sentence}" — there are ` +
      `${String(count)}, and a number in prose is a claim about a list`,
  );
}
// `openai-http` is the escape hatch, described in prose below the table
// rather than listed as a row — it is a way to reach a provider, not one.
const shipped = BACKEND_IDS.filter((id) => id !== "openai-http");
const providerSection = html.slice(
  html.indexOf('id="providers"'),
  html.indexOf("</section>", html.indexOf('id="providers"')),
);
const listed = new Set(
  [...providerSection.matchAll(/data-provider="([\w-]+)"/g)].map((m) => m[1]),
);
const missing = shipped.filter((id) => !listed.has(id));
check(
  "the providers table lists every provider in the registry",
  missing.length === 0,
  `missing: ${missing.join(", ")}`,
);
// And nothing invented: a row for a provider we do not ship is a promise the
// daemon cannot keep.
const invented = [...listed].filter((id) => !BACKEND_IDS.includes(id));
check(
  "the providers table invents nothing",
  invented.length === 0,
  `not in the registry: ${invented.join(", ")}`,
);

const NUMBERS = {
  16: "Sixteen",
  17: "Seventeen",
  18: "Eighteen",
  19: "Nineteen",
  20: "Twenty",
};
const claimed = /<h2>(\w+) providers\./.exec(providerSection)?.[1];
check(
  `the page's provider count says ${NUMBERS[BACKEND_IDS.length] ?? String(BACKEND_IDS.length)}`,
  claimed === NUMBERS[BACKEND_IDS.length],
  `page says "${claimed ?? "nothing"}", registry has ${String(BACKEND_IDS.length)}`,
);

// ---------------------------------------------------------------------------
// The same rot, in the READMEs.
//
// The landing page and the root README carried identical broken samples, and
// only the page was ever checked — so the README kept importing a symbol from
// the wrong entry point and calling a function that does not exist, for a
// week, on the front page of a public repo. Same assertions, same reasons.
// ---------------------------------------------------------------------------
process.stdout.write("\nreadmes\n");

/**
 * Every published package's README, plus the root one — enumerated, not
 * listed.
 *
 * This was a hand-written array, and it had already gone stale: `relay` had
 * shipped for weeks without being checked, and `control-plane` would have
 * joined it. A list of things to check does not grow when the code does,
 * which is the same shape as the call-site grep that missed the 2026-08-26
 * stop-ship — a check whose coverage is a literal is a check that silently
 * shrinks.
 *
 * `bump-version.mjs` already walks `packages/` for exactly these files, so
 * deriving here also means the two scripts cannot disagree about which
 * READMEs exist.
 */
const READMES = [
  "README.md",
  ...readdirSync("packages")
    .filter((dir) => {
      const manifest = join("packages", dir, "package.json");
      if (!existsSync(manifest)) return false;
      if (!existsSync(join("packages", dir, "README.md"))) return false;
      return JSON.parse(readFileSync(manifest, "utf8")).private !== true;
    })
    .sort()
    .map((dir) => `packages/${dir}/README.md`),
];

for (const rel of READMES) {
  const text = await readFile(new URL(rel, root), "utf8");
  const name = rel.replace("/README.md", "").replace("README.md", "root");

  for (const dead of RENAMED) {
    check(`${name}: no ${dead}`, !text.includes(dead));
  }
  for (const [snippet, why] of WRONG_IMPORTS) {
    check(`${name}: no \`${snippet}\``, !text.includes(snippet), why);
  }
  check(
    `${name}: names the shipped version`,
    text.includes(manifest.version),
    "the alpha banner names a different version than package.json",
  );
  /**
   * Two patterns, neither of which enumerates a binary.
   *
   * This was one pattern with `(?!-certify)` bolted on, and the day the
   * README list stopped being hand-maintained it failed on
   * `npx byollm-audit-deployment` — a binary that simply had not existed when
   * the exception was written. A check whose correctness depends on a list of
   * exceptions goes wrong the same way a check whose coverage depends on a
   * list of files does.
   *
   * So: `npx byollm` followed by neither `@` nor `-` is the unpinned bare
   * command, and anything after `-` is a different binary this rule has no
   * opinion about.
   */
  check(
    `${name}: every npx byollm invocation is pinned`,
    !/npx byollm(?![@\w-])/.test(text),
  );
  /* @latest, not @alpha — see the note on check 5. The tag that moves first
     is reviewed last, so asking for it explicitly is asking for the build
     nobody has looked at yet. */
  check(`${name}: every pin is @latest`, !/npx byollm@(?!latest\b)/.test(text));
}

process.stdout.write(
  failures === 0
    ? "\n  the page and the readmes match what we ship\n\n"
    : `\n  ${failures} docs check(s) failed\n\n`,
);
process.exit(failures === 0 ? 0 : 1);
