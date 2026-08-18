import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeys, publicIdentityOf } from "@byollm/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pairings } from "./pairings.js";
import { removeTemp } from "./test-support.js";

/**
 * One bad row is one pairing's problem — cloud_008 §2.3a.
 *
 * `load` ran `safeParse` over the whole file and fell back to `[]`, so a
 * single malformed row silently disconnected the daemon from **every** site
 * it had paired with. The CLI then said "not paired with <origin>" — a true
 * sentence about a state nobody intended — and `byollm list` showed nothing
 * rather than showing a problem.
 *
 * Third instance of the shape in this brief: §0.1 was the control-plane
 * projection, where one bad device row froze revocation for everyone; §2.1a
 * was the routing store, where two stubs from an older version denied every
 * claim on the hub. Parse per row, skip what you cannot read, say which one.
 */

let home: string;
let path: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "byollm-pairings-"));
  path = join(home, "pairings.json");
});

afterEach(async () => {
  await removeTemp(home);
});

const good = (origin: string) => ({
  origin,
  runnerId: `runner_${origin}`,
  token: "t",
  owner: "alice",
  site: publicIdentityOf(generateKeys(1_800_000_000_000)),
  pairedAt: 1_800_000_000_000,
});

describe("a pairings file with one unreadable row", () => {
  it("keeps every row it can read", async () => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        pairings: [
          good("http://a.test"),
          // Written by a version that did not have `pairedAt`, or by a bad
          // write. Either way it is this row's problem.
          { ...good("http://broken.test"), pairedAt: undefined },
          good("http://b.test"),
        ],
      }),
    );

    const pairings = new Pairings(path);
    await pairings.load();

    expect(
      pairings
        .list()
        .map((p) => p.origin)
        .sort(),
    ).toEqual(["http://a.test", "http://b.test"]);
  });

  it("names the row it skipped, by origin and failing field", async () => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        pairings: [{ ...good("http://broken.test"), pairedAt: undefined }],
      }),
    );

    const pairings = new Pairings(path);
    await pairings.load();

    expect(pairings.skipped).toHaveLength(1);
    expect(pairings.skipped[0]?.origin).toBe("http://broken.test");
    expect(pairings.skipped[0]?.problem).toContain("pairedAt");
  });

  it("never puts a token or a key in the diagnostic", async () => {
    // A pairing row holds a bearer token and a pinned key. A message that
    // quoted the row to explain itself would put both in a log — the same
    // rule the projection's per-row logging follows: ids and reasons, never
    // contents.
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        pairings: [
          { ...good("http://broken.test"), token: "s3cret", pairedAt: "no" },
        ],
      }),
    );

    const pairings = new Pairings(path);
    await pairings.load();

    expect(JSON.stringify(pairings.skipped)).not.toContain("s3cret");
  });

  it("reports nothing for a healthy file", async () => {
    // The positive control. "Always report a skip" would pass the tests above
    // and warn every user on every command.
    await writeFile(
      path,
      JSON.stringify({ version: 1, pairings: [good("http://a.test")] }),
    );

    const pairings = new Pairings(path);
    await pairings.load();

    expect(pairings.skipped).toEqual([]);
    expect(pairings.list()).toHaveLength(1);
  });

  it("stays quiet when there is no file at all", async () => {
    // A daemon that has never paired is the ordinary case, not a fault.
    const pairings = new Pairings(path);
    await pairings.load();

    expect(pairings.list()).toEqual([]);
    expect(pairings.skipped).toEqual([]);
  });
});
