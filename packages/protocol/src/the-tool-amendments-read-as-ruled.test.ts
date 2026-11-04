import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * byollm_012 §12 amends two sentences elsewhere, word for word — #7053.
 *
 * The amended byollm_004 §2 sentence and byollm_016's "Kept out" line are
 * written out in §12 as rulings, and both are copied into their own specs.
 * Two copies of one ruling drift unless something compares them, so this
 * does: each amended text, as §12 quotes it (bold dropped, lines joined),
 * appears in the spec it amends.
 */

const SPECS = fileURLToPath(new URL("../../../specs/", import.meta.url));
const read = (name: string) =>
  readFileSync(`${SPECS}${name}`, "utf8").replace(/\r\n/g, "\n");
const flat = (text: string) =>
  text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();

const tools = flat(read("byollm_012-tools.md"));

/** The text between two markers in §12, as one line. */
function quoted(after: string, until: string): string {
  const start = tools.indexOf(after);
  expect(start, `§12 no longer says ${after}`).toBeGreaterThan(-1);
  const from = start + after.length;
  return tools.slice(from, tools.indexOf(until, from)).trim();
}

describe("byollm_012 §12's amendments, where they apply", () => {
  it("amends byollm_004 §2's no-tools sentence", () => {
    const ruled = quoted(
      '"No prompt-driven tools" becomes: "',
      '" `OUTPUT_INERT`',
    );
    expect(ruled.length).toBeGreaterThan(200);
    expect(flat(read("byollm_004-execution-isolation.md"))).toContain(ruled);
  });

  it("amends byollm_016's Kept out line", () => {
    const ruled = quoted('The amended line reads: "', '." The amendment');
    expect(ruled).toMatch(/^payload-influenced request fields, ever — except/);
    expect(flat(read("byollm_016-services.md"))).toContain(ruled);
  });
});
