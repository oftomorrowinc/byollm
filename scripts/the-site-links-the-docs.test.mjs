import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * byo-llm.com sends a reader to the docs from where they are — Todd,
 * 2026-10-06.
 *
 * It linked docs.byollm.cloud from the footer and nowhere else, so somebody
 * reading the integration sample or the user steps had no route to the page
 * that explains them. Now the nav, the developer section and the user section
 * link it too, each to the heading that answers that reader.
 *
 * The anchors live in another repository. When it is checked out beside this
 * one they are read from its source; otherwise the test holds the two ids,
 * which byollm-cloud-web keeps stable, so a typo here still goes red.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const html = readFileSync(join(root, "site/index.html"), "utf8");
const DOCS = join(root, "..", "byollm-cloud-web", "apps", "docs", "src");

const hrefs = [
  ...html.matchAll(/href="(https:\/\/docs\.byollm\.cloud[^"]*)"/g),
].map((m) => m[1]);
const anchors = hrefs
  .map((href) => new URL(href).hash.slice(1))
  .filter((id) => id !== "");

/** Every `id="…"` in the docs app's source, if it is on this machine. */
function docsIds() {
  if (!existsSync(DOCS)) return null;
  const ids = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(tsx?|mdx?)$/.test(entry.name)) {
        for (const m of readFileSync(path, "utf8").matchAll(/\bid="([^"]+)"/g))
          ids.add(m[1]);
      }
    }
  };
  walk(DOCS);
  return ids;
}

describe("byo-llm.com links the docs", () => {
  it("from more than its footer", () => {
    expect(hrefs.length).toBeGreaterThanOrEqual(4);
  });

  it("deep-links the integration guide and the plain explanation", () => {
    expect(anchors.sort()).toEqual(["embed", "what-is-byollm"]);
  });

  it("to headings that exist in byollm-cloud-web", () => {
    const ids = docsIds();
    if (ids === null) return; // not checked out here; the literal ids above hold
    for (const id of anchors) expect(ids, `#${id}`).toContain(id);
  });
});
