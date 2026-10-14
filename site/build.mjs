#!/usr/bin/env node
/**
 * The deploy's one step: write the build log's newest entries into the page.
 *
 * `index.html` stays the whole site — it opens from a file and deploys to any
 * static host as committed (byollm_005), with an empty build log that the
 * browser fills. This only makes the first paint carry the entries: it reads
 * signals' public feed, renders them with the page's OWN inline script
 * (`#log-script`, run here with no `document`), and writes the result to
 * `dist/`, which is what Vercel serves.
 *
 * The live line is never built in: a claim baked into a static page is a claim
 * that outlives the work. The browser draws it on load, or doesn't.
 *
 * Unreachable feed → the entries are left empty and the build still succeeds:
 * a deploy must not fail because a log is down. It says so on stderr.
 *
 *   node build.mjs [outDir]     LOG_FEED_URL overrides the feed (tests).
 */
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, process.argv[2] ?? "dist");
const NOT_SERVED = new Set(["build.mjs", "vercel.json", "dist"]);

const html = readFileSync(join(here, "index.html"), "utf8");
const attr = (name) =>
  html.match(new RegExp(`<div data-log[^>]*\\s${name}="([^"]*)"`))?.[1];
const feed = process.env.LOG_FEED_URL || attr("data-feed");
const scope = attr("data-scope");
const count = Number(attr("data-count"));
const script = html.match(/<script id="log-script">([\s\S]*?)<\/script>/)?.[1];
if (
  !feed ||
  !scope ||
  !count ||
  !script ||
  !html.includes("<!-- log:end -->")
) {
  throw new Error(
    "index.html has lost #log's data-feed/data-scope/data-count, its markers, or #log-script",
  );
}

const context = vm.createContext({});
vm.runInContext(script, context);
const { entriesHtml } = context.byollmLog;

const url = `${feed}?scope=${encodeURIComponent(scope)}&limit=${count}`;
let entries = [];
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  entries = (await res.json()).entries ?? [];
  process.stdout.write(`[log] ${url}: ${entries.length} entries\n`);
} catch (err) {
  process.stderr.write(
    `[log] ${url} unreachable (${err.message}); built empty, the browser fills it\n`,
  );
}

// A function replacer: an entry's text is data, and `$&` in it must stay `$&`.
const page = html.replace(
  /<!-- log:start -->[\s\S]*?<!-- log:end -->/,
  () => `<!-- log:start -->${entriesHtml(entries, count)}<!-- log:end -->`,
);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const name of readdirSync(here)) {
  if (name.startsWith(".") || NOT_SERVED.has(name) || join(here, name) === out)
    continue;
  cpSync(join(here, name), join(out, name), { recursive: true });
}
writeFileSync(join(out, "index.html"), page);
