import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "./fixtures/log-feed/log-feed.mjs";

/**
 * byo-llm.com shows BYOLLM's build log (signals #961): the newest entries
 * from signals' public feed for ot.byollm, one line each the way
 * oftomorrow.net writes them, and "The whole log →" to oftomorrow.net.
 *
 * Read at deploy by site/build.mjs, which renders with the page's own inline
 * script, and again in the browser on load. These run the real build against
 * a fixture feed and read what it wrote.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const site = join(root, "site");
const source = readFileSync(join(site, "index.html"), "utf8");
const vercel = JSON.parse(readFileSync(join(site, "vercel.json"), "utf8"));

/** Run the deploy's build into a temp dir. Async: the fixture feed answers
 *  from this process, and a synchronous spawn would starve it. */
async function build(feedUrl) {
  const out = mkdtempSync(join(tmpdir(), "byollm-site-"));
  const child = spawn(process.execPath, [join(site, "build.mjs"), out], {
    env: { ...process.env, LOG_FEED_URL: feedUrl },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  const status = await new Promise((done) => child.on("close", done));
  const html =
    status === 0 ? readFileSync(join(out, "index.html"), "utf8") : "";
  rmSync(out, { recursive: true, force: true });
  return { status, stdout, stderr, html };
}

const between = (html) =>
  html.match(/<!-- log:start -->([\s\S]*?)<!-- log:end -->/)?.[1];
const lines = (html) =>
  [...between(html).matchAll(/<li [^>]*>([\s\S]*?)<\/li>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, ""),
  );

describe("the build writes the newest entries in", () => {
  let feed;
  let built;
  beforeAll(async () => {
    feed = await serve();
    built = await build(feed.url);
  });
  afterAll(() => feed.close());

  it("succeeds and says how many it read", () => {
    expect(built.status, built.stderr).toBe(0);
    expect(built.stdout).toContain("5 entries");
  });

  it("five lines of ot.byollm, newest first, in oftomorrow.net's form", () => {
    expect(lines(built.html)).toEqual([
      "[ccb, for todd · byollm] Landed #958 as 3888033 in byollm: Live canaries skip loudly on a provider refusal",
      "[todd · byollm] Said: Cost is a protocol fact, not a setting. $&amp; stays $&amp;.",
      "[todd · byollm] Ruled on #957: &lt;img src=x onerror=alert(2)&gt; is a title, not markup",
      "[ccb, for todd · byollm] Built #953: byollm.cloud opens: the signup gate comes off (8m)",
      "[ccb, for todd · byollm] Decided on #953: the gate&#39;s function keeps its name",
    ]);
  });

  it("links the card to its board and the title into the whole log", () => {
    expect(between(built.html)).toContain(
      '<a href="https://signals.oftomorrow.net/board?scope=ot.byollm&amp;card=958" class="log-card">#958</a>',
    );
    expect(between(built.html)).toContain(
      'href="https://oftomorrow.net/log/byollm#e110" class="log-title"',
    );
  });

  it("escapes the feed's text: markup in a title stays text", () => {
    expect(between(built.html)).not.toContain("<img");
    expect(between(built.html)).not.toMatch(/<script/i);
  });

  it("never builds the live line in", () => {
    expect(built.html).toContain(
      '<div class="log-live-lines" data-log-live hidden></div>',
    );
  });

  it("links the whole log", () => {
    expect(built.html).toContain(
      '<a href="https://oftomorrow.net/log/byollm" data-log-all>The whole log →</a>',
    );
  });
});

describe("an unreachable feed", () => {
  it("builds anyway, with no entries for the browser to fill", async () => {
    const built = await build("http://127.0.0.1:9/api/log");
    expect(built.status, built.stderr).toBe(0);
    expect(built.stderr).toMatch(/unreachable.*built empty/);
    expect(between(built.html)).toBe("");
  });
});

describe("the page as committed, and what serves it", () => {
  it("carries no entries: opened from a file, the browser fills it", () => {
    expect(between(source)).toBe("");
  });

  it("is built by build.mjs and served from what it wrote", () => {
    expect(vercel.buildCommand).toBe("node build.mjs");
    expect(vercel.outputDirectory).toBe("dist");
  });

  /* The browser's read is the only network request the page makes; the CSP
     is `default-src 'none'`, so without connect-src it is silently blocked
     and the page shows only what it was built with, forever. */
  it("lets the browser reach the feed the page names, and nothing else", () => {
    const feed = source.match(/<div data-log[^>]*\sdata-feed="([^"]+)"/)[1];
    const csp = vercel.headers
      .flatMap((h) => h.headers)
      .find((h) => h.key === "Content-Security-Policy").value;
    expect(csp).toContain(`connect-src ${new URL(feed).origin};`);
  });
});
