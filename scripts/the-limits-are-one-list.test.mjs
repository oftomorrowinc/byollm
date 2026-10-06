import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NOT_YET, notYetLine } from "@byollm/protocol";
import { describe, expect, it } from "vitest";

/**
 * Every surface that lists what BYOLLM does not do yet lists NOT_YET — Todd,
 * 2026-10-06.
 *
 * The README and byo-llm.com cannot import the list (one is markdown, the
 * other static HTML), so each carries a copy and this compares the copy to
 * the source: exactly the entries, in order, nothing added. A limit lifted in
 * `@byollm/protocol` and still listed here, or a new limit missing here, is
 * red.
 */

const read = (path) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

const want = NOT_YET.map(notYetLine);

/** The bullets between `### Not yet` and the next heading. */
function readmeNotYet(md) {
  const at = md.indexOf("\n### Not yet\n");
  if (at === -1) return null;
  const rest = md.slice(at + 1);
  const next = rest.slice(1).search(/\n#{1,3} /);
  const section = next === -1 ? rest : rest.slice(0, next + 1);
  return section
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
}

/** The `<li>` text inside `<section id="not-yet">`, tags stripped. */
function siteNotYet(html) {
  const section = html.match(/<section id="not-yet"[\s\S]*?<\/section>/)?.[0];
  if (section === undefined) return null;
  return [...section.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) =>
    m[1]
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

describe("the Not yet list", () => {
  it("is NOT_YET in the README's Status", () => {
    const md = read("README.md");
    expect(md.indexOf("### Not yet")).toBeGreaterThan(md.indexOf("## Status"));
    expect(readmeNotYet(md)).toEqual(want);
  });

  it("is NOT_YET on byo-llm.com, after the packages", () => {
    const html = read("site/index.html");
    expect(html).toMatch(
      /<section id="not-yet"[\s\S]*?<h2>What it doesn't do yet<\/h2>/,
    );
    expect(html.indexOf('id="not-yet"')).toBeGreaterThan(
      html.indexOf("Six small pieces."),
    );
    expect(siteNotYet(html)).toEqual(want);
  });

  it("goes red when either surface drops or adds an entry", () => {
    const md = read("README.md");
    const html = read("site/index.html");
    const dropped = `- ${want[2]}\n`;
    expect(readmeNotYet(md.replace(dropped, ""))).not.toEqual(want);
    expect(
      readmeNotYet(md.replace(dropped, `${dropped}- Telepathy\n`)),
    ).not.toEqual(want);
    expect(siteNotYet(html.replace(`<li>${want[2]}</li>`, ""))).not.toEqual(
      want,
    );
    expect(
      siteNotYet(
        html.replace(`<li>${want[2]}</li>`, `<li>${want[2]}</li><li>x</li>`),
      ),
    ).not.toEqual(want);
  });
});
