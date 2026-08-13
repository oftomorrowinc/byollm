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
import { readFile } from "node:fs/promises";
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

// 5. Install commands must ask for @alpha — a bare `npx byollm` resolves to
//    whatever `latest` happens to point at.
const bareNpx = /npx byollm(?!@alpha)(?!-certify)/.test(html);
check("every npx invocation pins @alpha", !bareNpx);

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
const { BACKEND_IDS } = await import(
  new URL("packages/protocol/dist/index.js", root)
);
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

const READMES = [
  "README.md",
  "packages/protocol/README.md",
  "packages/daemon/README.md",
  "packages/server/README.md",
  "packages/conformance/README.md",
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
  check(
    `${name}: every npx invocation pins @alpha`,
    !/npx byollm(?!@alpha)(?!-certify)/.test(text),
  );
}

process.stdout.write(
  failures === 0
    ? "\n  the page and the readmes match what we ship\n\n"
    : `\n  ${failures} docs check(s) failed\n\n`,
);
process.exit(failures === 0 ? 0 : 1);
