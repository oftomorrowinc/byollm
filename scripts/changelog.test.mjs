import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { versions, render } from "./changelog.mjs";

/**
 * The changelog is in the order it claims — B340, fixed at the 0.1.1 cut.
 *
 * The file's own second line promises "newest first", and at the 0.1.1 tag it
 * listed `0.1.0` above `0.1.1`. `rank()` gave every stable release `Infinity`
 * — meant to lift a release above its own prereleases, and it lifted all of
 * them to the same number, so any two stable releases tied and `readdir` order
 * decided. **The first release to have a second stable version is the first
 * one that could show it**, which is why a generated file still needs a case.
 *
 * Asked of `versions()` against a fixture directory rather than of `rank()`,
 * which is not exported: what the reader gets is the order of the rows, and a
 * helper that sorts correctly into a list nobody renders proves nothing.
 */

let dir;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A notes directory holding exactly these versions. */
function notes(list) {
  dir = mkdtempSync(join(tmpdir(), "changelog-"));
  mkdirSync(dir, { recursive: true });
  for (const v of list)
    writeFileSync(join(dir, `${v}.md`), `# ${v}\n\n**A note for ${v}.**\n`);
  return dir;
}

describe("newest first, which is what the file says it is", () => {
  it("puts a later release above an earlier one", () => {
    /* CW's case. Both are stable, so both took the `Infinity` branch and tied;
       the order that came out was whatever the filesystem listed first. */
    expect(versions(notes(["0.1.0-alpha.103", "0.1.0", "0.1.1"]))).toEqual([
      "0.1.1",
      "0.1.0",
      "0.1.0-alpha.103",
    ]);
  });

  it("keeps a release above its own prereleases", () => {
    /* The property `Infinity` was reaching for, which the fix must not lose:
       `release.yml` §4 never sends a prerelease to `latest`, so a release
       outranks every prerelease of itself. */
    expect(
      versions(notes(["0.1.0", "0.1.0-alpha.1", "0.1.0-alpha.103"])),
    ).toEqual(["0.1.0", "0.1.0-alpha.103", "0.1.0-alpha.1"]);
  });

  it("does not let a prerelease outrank the next patch", () => {
    /**
     * The gap, asserted rather than the constant. The ceiling is 99999 because
     * a patch step adds 100000; a prerelease numbered past that would sort
     * above the release after it. Nothing we ship comes close — the largest is
     * `alpha.103` — and the day it did, this is what would say so.
     */
    expect(versions(notes(["0.1.1", "0.1.0-alpha.99998"]))).toEqual([
      "0.1.1",
      "0.1.0-alpha.99998",
    ]);
  });

  it("orders prereleases by number, not by string", () => {
    /* `alpha.9` sorts after `alpha.100` as text, which would put the history
       in an order no reader could explain — and the reader is the point. */
    expect(
      versions(notes(["0.1.0-alpha.9", "0.1.0-alpha.100", "0.1.0-alpha.21"])),
    ).toEqual(["0.1.0-alpha.100", "0.1.0-alpha.21", "0.1.0-alpha.9"]);
  });

  it("renders the rows in that order, with the promise above them", () => {
    /* The claim and the order are one fact stated twice; nothing else makes
       them move together. */
    const out = render(notes(["0.1.0", "0.1.1"]));
    expect(out).toContain("newest first");
    expect(out.indexOf("[`0.1.1`]")).toBeLessThan(out.indexOf("[`0.1.0`]"));
  });
});
