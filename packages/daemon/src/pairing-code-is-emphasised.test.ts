import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The pairing code is emphasised where it is printed — T2-S2.
 *
 * `emphasise` was tested thoroughly and its one call site was not, so
 * replacing the call with the bare value stayed green: a helper proved
 * correct and never proved *used*. **A feature exists when it is consumed**,
 * and a highlight nothing calls is a highlight nobody sees.
 *
 * Source-shaped, and the limit is worth stating: this holds the wiring, not
 * the rendered terminal. What it can prove is that the value printed in step
 * 2 goes through the helper, that the label does not, and that nothing else
 * on the screen has quietly acquired escapes.
 */
const source = readFileSync(
  fileURLToPath(new URL("./cli.ts", import.meta.url)),
  "utf8",
);

function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const code = withoutComments(source);

describe("the pairing code, at the place it is printed", () => {
  it("goes through the helper", () => {
    expect(code).toContain("emphasise(info.userCode, terminalContext())");
  });

  it("wraps the code and not the label", () => {
    /* Emphasis larger than the thing emphasised stops meaning anything, and
       "Enter code:" is not what somebody carries to the other window. */
    const step = code.slice(code.indexOf("2) Enter code:"));
    const line = step.slice(0, step.indexOf("\\n"));
    expect(line).toContain("emphasise(info.userCode");
    expect(line.slice(0, line.indexOf("emphasise"))).toContain("Enter code:");
  });

  it("is the only thing on this screen that is emphasised", () => {
    /**
     * The control, and the reason it is not paranoia: the same three steps
     * carry a URL and a fingerprint, and both are values somebody copies. An
     * escape inside either is a paste that fails, so the budget is one — the
     * current step — and spending it twice spends it on nothing.
     */
    expect(code.split("emphasise(")).toHaveLength(2);
  });
});
