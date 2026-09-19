import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The inventory of surfaces a stranger reads — B304.
 *
 * **Five gates in this repository each decided for themselves what "the
 * documents we publish" means, and no two of them agree:**
 *
 *   - `bump-version.mjs` — package READMEs, the root README, the site
 *   - `alpha-claims-match-the-version.mjs` — the same three
 *   - `every-npx-line-names-its-package.test.mjs` — the READMEs, **not the site**
 *   - `the-links-we-ship-resolve.mjs` — the READMEs plus CONTRIBUTING and
 *     SECURITY, **not the site**
 *   - `every-part-links-the-others.test.mjs` — a list written out by hand
 *
 * The one that cost something is the third. That check exists *because* an
 * `npx` line naming a bin as though it were a package shipped to three
 * published READMEs — and it cannot see `site/index.html`, which carries three
 * `npx` lines and is the page somebody meets before any README.
 *
 * ## This does not force them equal, and that is deliberate
 *
 * The differences are not all mistakes. `the-links-we-ship-resolve` wants
 * CONTRIBUTING because a dead link there wastes a contributor's afternoon;
 * `alpha-claims` does not, because a contributor document saying "alpha" is
 * not an install instruction that will resolve to the wrong version. Flattening
 * them into one set would trade five considered scopes for one careless one.
 *
 * What was wrong is that the INVENTORY was written five times. A surface added
 * to the product had to be remembered in five places by somebody who did not
 * know there were five. Here it is written once; each gate still says which
 * parts it wants, and says why.
 */

/** Every package README we publish, in a stable order. */
export function packageReadmes(root = ".") {
  const dir = join(root, "packages");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((name) => join(dir, name, "README.md"))
    .filter((path) => existsSync(path));
}

/** The front door on npm and on GitHub. */
export function rootReadme(root = ".") {
  const path = join(root, "README.md");
  return existsSync(path) ? [path] : [];
}

/**
 * The marketing site.
 *
 * HTML, which is why gates forget it: every one of them was written while
 * reading markdown, and a rule that assumes markdown reads this file and finds
 * nothing rather than failing. `text()` below is the answer to that — a gate
 * that adds this surface without stripping the markup has widened its own
 * coverage on paper only.
 */
export function site(root = ".") {
  const path = join(root, "site", "index.html");
  return existsSync(path) ? [path] : [];
}

/** What somebody who wants to help, or to report something, reads. */
export function contributorDocs(root = ".") {
  return ["CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md"]
    .map((name) => join(root, name))
    .filter((path) => existsSync(path));
}

/**
 * A document's text with its markup taken off, so one rule can read both.
 *
 * Markdown passes through untouched. HTML loses its tags and the four entities
 * that appear in a shell command — otherwise `<code>npx byollm` tokenises as
 * `<code>npx`, the package name never matches, and the check reports a clean
 * file it never read. That is the shape this repository keeps finding in its
 * own gates, and adding a surface is exactly when it happens.
 */
export function text(path) {
  const raw = readFileSync(path, "utf8");
  if (!path.endsWith(".html")) return raw;
  return raw
    .replaceAll(/<[^>]*>/gu, "")
    .replaceAll(/&lt;/gu, "<")
    .replaceAll(/&gt;/gu, ">")
    .replaceAll(/&quot;/gu, '"')
    .replaceAll(/&amp;/gu, "&");
}
