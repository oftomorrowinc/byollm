import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./wire.js";

/**
 * Nobody spells the current protocol version out.
 *
 * Bumping `PROTOCOL_VERSION` from `"0"` to `"1"` broke 139 tests and one
 * example, because sixty-eight places had typed the number rather than
 * imported it. Every one of them was a second definition of a fact the
 * protocol already stated, and they all agreed right up until the moment the
 * fact changed — which is the moment a duplicate is worth catching.
 *
 * The example was worse than the tests: it lived outside `packages/`, so a
 * sweep that fixed the tests missed it, and CI found it after the version had
 * already been committed and tagged.
 *
 * ## What is allowed, and why that is not a loophole
 *
 * A literal of an **old** version is fine and stays fine. Those are fixtures
 * about staleness — `checkProtocolVersion({ protocolVersion: "0" })` asks what
 * an out-of-date client is told, and freezing that number is the point of the
 * case.
 *
 * So the rule is narrow and derived: no file may contain a literal equal to
 * the version this build declares. Nothing is listed by name, nothing needs
 * an exemption, and the next bump makes today's correct literals stale
 * automatically — which is exactly when they stop being fixtures and start
 * being duplicates.
 */

const ROOT = resolve(import.meta.dirname, "../../..");

/** Where a version literal could plausibly travel. */
const SEARCHED = ["packages", "examples", "site", "scripts"];

const SKIP = new Set(["node_modules", "dist", ".tsbuild", ".next", "coverage"]);

function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sources(path));
    } else if (/\.(ts|tsx|mjs|js|json)$/.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

describe("the protocol version has one definition", () => {
  it("is never typed out anywhere else", () => {
    /**
     * Matched as `protocolVersion` beside the literal, rather than the bare
     * number: `"1"` alone appears in a hundred honest places, and a check
     * that flagged those would be turned off within a week.
     */
    const spelled = new RegExp(
      `protocolVersion["']?\\s*[:=]\\s*["']${PROTOCOL_VERSION}["']|` +
        `protocolVersion=${PROTOCOL_VERSION}\\b`,
    );

    const offenders: string[] = [];
    for (const dir of SEARCHED) {
      const path = resolve(ROOT, dir);
      try {
        statSync(path);
      } catch {
        continue;
      }
      for (const file of sources(path)) {
        // Where it is *defined*, which is the one place it belongs.
        if (file.endsWith(join("protocol", "src", "wire.ts"))) continue;
        if (file.endsWith("version-is-not-typed-out.test.ts")) continue;
        if (spelled.test(readFileSync(file, "utf8"))) {
          offenders.push(relative(ROOT, file));
        }
      }
    }

    expect(
      offenders,
      "these spell the current protocol version instead of importing " +
        "`PROTOCOL_VERSION`, so the next bump will silently make them wrong",
    ).toEqual([]);
  });

  it("still finds a literal when there is one", () => {
    // The positive control. A regex that had stopped matching would report
    // "nobody spells it out" forever, which is the failure this whole file is
    // about wearing a different hat.
    const spelled = new RegExp(
      `protocolVersion["']?\\s*[:=]\\s*["']${PROTOCOL_VERSION}["']`,
    );
    expect(spelled.test(`{ protocolVersion: "${PROTOCOL_VERSION}" }`)).toBe(
      true,
    );
    // And leaves an older one alone, which is a fixture rather than a copy.
    expect(spelled.test('{ protocolVersion: "0" }')).toBe(false);
  });
});
