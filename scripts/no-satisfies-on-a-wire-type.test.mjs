import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as protocol from "@byollm/protocol";

/**
 * A strict wire shape is enforced where it is built — CW's ruling, 2026-09-19.
 *
 * B304: `runner.ts` sealed `{ outcome, ran } satisfies SealedOutcome` while
 * `ran` carried two keys `RunMetadata` refuses. Every claude-cli result on
 * every site was dropped, silently, for months.
 *
 * **`satisfies` excess-checks a fresh literal and checks nothing on a
 * variable, and the line looks identical either way.** That is the whole
 * finding. A reader cannot tell a protected site from an unprotected one
 * without chasing where each value came from, and neither can a reviewer.
 *
 * So the word is banned on wire types in the three packages that speak the
 * protocol, and the only spelling is `Schema.parse(...)` at the builder. It
 * costs a microsecond and does not depend on where the value came from.
 *
 * ## The set comes from the protocol, not from a list here
 *
 * Every exported zod schema is a wire type by construction, so a shape added
 * to `@byollm/protocol` tomorrow is covered without anybody remembering. A
 * hand-written list would go stale in the direction that matters — the new
 * shape is the one nobody has reasoned about yet.
 *
 * `ServiceBlock` is deliberately not in it: it is the daemon's own config, it
 * crosses no wire, and `satisfies` on it is doing the job it is good at.
 */

/** Every wire shape, as the protocol itself defines them. */
const WIRE = Object.entries(protocol)
  .filter(
    ([, value]) =>
      value !== null &&
      typeof value === "object" &&
      typeof (/** @type {{safeParse?: unknown}} */ (value).safeParse) ===
        "function",
  )
  .map(([name]) => name);

/** The packages that speak the protocol. A site, a device, and the middle. */
const SPEAKERS = ["daemon", "server", "relay"];

/**
 * Source with its comments removed.
 *
 * **A mention is not a use, and this file would have been the fourth time that
 * caught me.** `runner.ts` carries a comment explaining why `satisfies
 * SealedOutcome` was removed — so a rule reading raw source flags the very
 * file that fixed the defect, and whoever met that would delete the
 * explanation to get a green.
 */
function code(text) {
  return text
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
    .replaceAll(/^[ \t]*\/\/.*$/gmu, "");
}

function sources() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      if (entry.name.includes(".test.")) continue;
      found.push([path, readFileSync(path, "utf8")]);
    }
  };
  for (const name of SPEAKERS) {
    const src = join("packages", name, "src");
    if (existsSync(src)) walk(src);
  }
  return found;
}

/** Every `satisfies <WireType>` in one file's code, with its line. */
export function offences(text, wire = WIRE) {
  const found = [];
  code(text)
    .split("\n")
    .forEach((line, at) => {
      const hit = /\bsatisfies\s+([A-Za-z_$][\w$]*)/u.exec(line);
      if (hit === null) return;
      const name = hit[1] ?? "";
      if (!wire.includes(name)) return;
      found.push({ line: at + 1, name });
    });
  return found;
}

describe("the rule, on source the repository does not contain", () => {
  it("flags a wire type", () => {
    expect(offences("return ok({ a: 1 } satisfies FetchResponse);")).toEqual([
      { line: 1, name: "FetchResponse" },
    ]);
  });

  it("leaves a type that crosses no wire alone", () => {
    /* `ServiceBlock` is the daemon's own config. A rule that banned the word
       outright would be asking people to parse their local objects, and would
       be switched off for the ones that matter. */
    expect(offences("} satisfies ServiceBlock);")).toEqual([]);
  });

  it("does not flag a mention of the defect it exists for", () => {
    /**
     * The trap this file was most likely to fall into, and it is in the tree:
     * `runner.ts` explains in a comment why `satisfies SealedOutcome` was
     * removed. A rule reading raw source flags the fix's own explanation, and
     * the cheapest way to green is to delete the reason.
     */
    const written = [
      "/* `satisfies SealedOutcome` at the seal read like a guarantee. */",
      "// satisfies ClaimRequest — removed, see B304",
    ].join("\n");
    expect(offences(written)).toEqual([]);
  });

  it("knows the wire set is the protocol's, not a list", () => {
    /* If this were hand-written it would be complete on the day it was
       written and never again. */
    expect(WIRE.length).toBeGreaterThan(40);
    for (const name of ["SealedOutcome", "RunMetadata", "PairPollResponse"]) {
      expect(WIRE).toContain(name);
    }
    expect(WIRE).not.toContain("ServiceBlock");
  });
});

describe("what the protocol's speakers build", () => {
  it("reads them at all, or this reports a clean tree having opened none", () => {
    const files = sources();
    expect(files.length).toBeGreaterThan(20);
    expect(files.map(([path]) => path).join(" ")).toContain("handlers.ts");
  });

  it("says a wire shape with its schema, never with `satisfies`", () => {
    const broken = sources().flatMap(([path, text]) =>
      offences(text).map(
        ({ line, name }) =>
          `${path}:${String(line)} satisfies ${name} — say ` +
          `${name}.parse(...) instead; on a variable this checks nothing and ` +
          "the line looks the same either way (B304)",
      ),
    );
    expect(broken, broken.join("\n")).toEqual([]);
  });
});
