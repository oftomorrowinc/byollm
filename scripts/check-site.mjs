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
//    static host with zero build, so nothing may be fetched from a CDN.
const remote = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)]
  .map((m) => m[1])
  .filter(
    (u) => !/^https?:\/\/(github\.com|www\.npmjs\.com|byo-llm\.com)/.test(u),
  );
check("loads no external assets", remote.length === 0, remote.join(", "));

process.stdout.write(
  failures === 0
    ? "\n  the page matches what we ship\n\n"
    : `\n  ${failures} landing-page check(s) failed\n\n`,
);
process.exit(failures === 0 ? 0 : 1);
