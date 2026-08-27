import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeys, keyId, publicIdentityOf } from "@byollm/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pairings, recordSites } from "./pairings.js";
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

const good = (origin: string) => {
  const site = publicIdentityOf(generateKeys(1_800_000_000_000));
  return {
    origin,
    runnerId: `runner_${origin}`,
    owner: "alice",
    // Keyed by the site's identity key id — cloud_009 §5. `token` is gone
    // with the bearer credential nothing had read since alpha.18, and `site`
    // with the single-site shape.
    sites: { [keyId(site.identity)]: site },
    pairedAt: 1_800_000_000_000,
  };
};

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

  it("reads a pairing that covers several sites", async () => {
    // cloud_009 §5. One pairing per upstream, covering a set: a user who
    // connects a site on a web dashboard has no reason to run a command on a
    // laptop afterwards, so the set follows consent rather than being frozen
    // at pairing.
    const SITE_A = publicIdentityOf(generateKeys(1_800_000_000_002));
    const SITE_B = publicIdentityOf(generateKeys(1_800_000_000_003));
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        pairings: [
          good("https://direct.test"),
          {
            origin: "https://hub.test",
            runnerId: "r_hub",
            owner: "alice",
            sites: {
              [keyId(SITE_A.identity)]: SITE_A,
              [keyId(SITE_B.identity)]: SITE_B,
            },
            pairedAt: 2,
          },
        ],
      }),
    );

    const pairings = new Pairings(path);
    await pairings.load();

    expect(pairings.skipped).toEqual([]);
    expect(pairings.list().map((p) => p.origin)).toEqual([
      "https://direct.test",
      "https://hub.test",
    ]);
    // A direct site is one entry rather than a different shape, which is what
    // lets the runner's lookup be one map read on every lane.
    expect(
      Object.keys(pairings.get("https://direct.test")?.sites ?? {}),
    ).toHaveLength(1);
    expect(
      Object.keys(pairings.get("https://hub.test")?.sites ?? {}).sort(),
    ).toEqual([keyId(SITE_A.identity), keyId(SITE_B.identity)].sort());
  });
});

describe("recording the site set an upstream describes", () => {
  it("writes when it moved, and says so", async () => {
    // cloud_009 §5: the heartbeat is the authority on which sites a pairing
    // covers, and the file follows it. A daemon that learns the set every few
    // seconds and forgets it at every restart behaves differently depending
    // on how recently it was rebooted.
    const SITE_A = publicIdentityOf(generateKeys(1_800_000_000_010));
    const SITE_B = publicIdentityOf(generateKeys(1_800_000_000_011));
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        pairings: [
          {
            origin: "https://hub.test",
            runnerId: "r",
            owner: "alice",
            sites: { [keyId(SITE_A.identity)]: SITE_A },
            pairedAt: 1,
          },
        ],
      }),
    );
    const pairings = new Pairings(path);
    await pairings.load();

    // Unchanged is not a write: a file rewritten every heartbeat is a disk
    // busy proving nothing.
    expect(
      await recordSites(
        pairings,
        "https://hub.test",
        new Map([[keyId(SITE_A.identity), SITE_A]]),
      ),
    ).toBe("unchanged");

    expect(
      await recordSites(
        pairings,
        "https://hub.test",
        new Map([
          [keyId(SITE_A.identity), SITE_A],
          [keyId(SITE_B.identity), SITE_B],
        ]),
      ),
    ).toBe("written");

    const reloaded = new Pairings(path);
    await reloaded.load();
    expect(
      Object.keys(reloaded.get("https://hub.test")?.sites ?? {}).sort(),
    ).toEqual([keyId(SITE_A.identity), keyId(SITE_B.identity)].sort());

    // A site removed leaves with its pin, which is finding 59 seen from the
    // machine: one site's revocation, not the whole relationship.
    expect(
      await recordSites(
        pairings,
        "https://hub.test",
        new Map([[keyId(SITE_B.identity), SITE_B]]),
      ),
    ).toBe("written");
    const after = new Pairings(path);
    await after.load();
    expect(Object.keys(after.get("https://hub.test")?.sites ?? {})).toEqual([
      keyId(SITE_B.identity),
    ]);
  });

  it("says so rather than throwing when nothing is paired there", async () => {
    // The run loop calls this from an event handler, where a throw takes the
    // runner with it. An origin with no pairing is an ordinary state — a
    // revocation dropped it a moment ago — not an error.
    await writeFile(path, JSON.stringify({ version: 1, pairings: [] }));
    const pairings = new Pairings(path);
    await pairings.load();

    expect(await recordSites(pairings, "https://gone.test", new Map())).toBe(
      "unpaired",
    );
  });
});

describe("one bad site entry is one site's problem — V1-9", () => {
  it("keeps the sites it can read and names the one it dropped", async () => {
    // The same amplification, one level further down than §2.3a reached.
    // `sites` is a single `z.record`, so a machine paired with three sites
    // lost all three because one entry was written by a version that spells
    // a field differently — and the CLI reported it as "not paired".
    const keep = publicIdentityOf(generateKeys(1_800_000_000_000));
    const keepId = keyId(keep.identity);
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        pairings: [
          {
            origin: "https://hub.test",
            runnerId: "runner_1",
            owner: "me",
            sites: {
              [keepId]: keep,
              BROKEN: { identity: "id-only", encryption: 7 },
            },
            pairedAt: 1_800_000_000_000,
          },
        ],
      }),
    );

    const pairings = new Pairings(path);
    await pairings.load();

    const pairing = pairings.get("https://hub.test");
    expect(Object.keys(pairing?.sites ?? {})).toEqual([keepId]);
    // Named, and by field path rather than by value: the entry that failed
    // holds key material, and a diagnostic that quotes it puts key material
    // in a log.
    expect(pairings.skipped.map((row) => row.problem).join(" ")).toContain(
      "sites.BROKEN",
    );
    expect(pairings.skipped[0]?.origin).toBe("https://hub.test");
  });

  it("says the file is unreadable rather than pretending nothing is paired", async () => {
    // Two opposite sentences shared one branch. "No file" means run
    // `byollm connect`; "cannot read the file" means this device has
    // pairings it can no longer see, and the CLI offered the first advice for
    // both.
    await writeFile(path, "{ not json at all");
    const pairings = new Pairings(path);
    await pairings.load();

    expect(pairings.list()).toEqual([]);
    expect(pairings.skipped).toHaveLength(1);
    expect(pairings.skipped[0]?.problem).toContain("not valid JSON");
  });

  it("never leaves a half-written file where the daemon reads one", async () => {
    // Written elsewhere and renamed into place. An in-place write makes the
    // name exist while the bytes are still arriving, and `load` reads
    // unparseable as never-paired — so a torn write disconnected a machine
    // from every site it served, silently.
    const pairings = new Pairings(path);
    await pairings.load();
    const site = publicIdentityOf(generateKeys(1_800_000_000_000));
    await pairings.put({
      origin: "https://hub.test",
      runnerId: "runner_1",
      owner: "me",
      sites: { [keyId(site.identity)]: site },
      pairedAt: 1_800_000_000_000,
    });

    // Nothing beside it: a temp file left behind is a file somebody's backup
    // copies and somebody's `ls` asks about.
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(home)).sort()).toEqual(["pairings.json"]);

    const reread = new Pairings(path);
    await reread.load();
    expect(reread.list()).toHaveLength(1);
  });
});

/**
 * A row whose origin will not normalize is one pairing's problem too.
 *
 * The stop-ship's other half. `normalizeOrigin` used to hand back whatever it
 * could not parse, so a row saying `origin: "not a url"` loaded fine and took
 * a key that matched nothing anybody could type — a pairing present in the
 * file, absent from every lookup, and reported nowhere. It now quarantines
 * like any other unreadable row, and the good rows beside it still load.
 */
describe("a row whose origin is not an origin", () => {
  it("is quarantined and named, and its neighbours survive", async () => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        pairings: [good("https://fine.test"), good("not a url")],
      }),
    );
    const pairings = new Pairings(path);
    await pairings.load();

    expect(pairings.list().map((p) => p.origin)).toEqual(["https://fine.test"]);
    expect(pairings.skipped).toEqual([
      {
        origin: "not a url",
        problem: "the origin is unusable — it does not name a host and port",
      },
    ]);
  });

  it("keys a stored row by the same name a person would type", async () => {
    // The lookup that missed. A pairing written down as `https://hub.test` is
    // found by `hub.test`, and one written down scheme-less is found by the
    // schemed spelling — in both directions, because both normalize on the
    // way in and the comparison is `===` on one canonical key.
    await writeFile(
      path,
      JSON.stringify({ version: 1, pairings: [good("hub.test")] }),
    );
    const pairings = new Pairings(path);
    await pairings.load();

    expect(pairings.list()[0]?.origin).toBe("https://hub.test");
    expect(pairings.get("hub.test")).toBeDefined();
    expect(pairings.get("https://hub.test")).toBeDefined();
    expect(pairings.get("https://hub.test/")).toBeDefined();
    expect(pairings.get("HUB.TEST")).toBeDefined();
  });

  it("does not let a scheme-less row shadow a different server", async () => {
    // Two rows, two servers, two keys — the collision half of the law.
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        pairings: [good("hub.test"), good("http://hub.test")],
      }),
    );
    const pairings = new Pairings(path);
    await pairings.load();

    expect(pairings.list().map((p) => p.origin)).toEqual([
      "https://hub.test",
      "http://hub.test",
    ]);
  });
});

/**
 * Machinery this version removed, taken out of the file and announced.
 *
 * `Pairing` is `.strict()`, so a row written by alpha.53–.57 carries `roster`
 * and `rosterRefusal` fields this version does not declare. Left alone they
 * would quarantine every pairing on the machine — a device that appears to
 * have forgotten every site it serves, over a field nobody needs. Stripped
 * silently they would be the other failure: a held roster *was* this device's
 * answer to "who may use me", and its removal is a real change in behaviour.
 *
 * So: cleaned up **and** reported, which is the rule for state left by
 * deleted machinery.
 */
describe("a pairing written before grants existed", () => {
  it("loads, keeps its sites, and says what was dropped", async () => {
    const row = {
      ...good("https://relay.test"),
      controlPlanePublic: "a-pinned-key",
      roster: {
        owner: "alice",
        members: ["bob"],
        issuedAt: 1_800_000_000_000,
        signature: "sig",
      },
      rosterRefusal: "stale",
    };
    await writeFile(path, JSON.stringify({ version: 1, pairings: [row] }));

    const pairings = new Pairings(path);
    await pairings.load();

    // Not quarantined — the pairing survives, which is the whole point.
    expect(pairings.skipped).toEqual([]);
    const [pairing] = pairings.list();
    expect(pairing?.origin).toBe("https://relay.test");
    expect(pairing?.controlPlanePublic).toBe("a-pinned-key");
    // And the retired fields are gone rather than carried.
    expect(pairing).not.toHaveProperty("roster");

    // Announced, naming the origin and what changed about it.
    expect(pairings.retired).toHaveLength(1);
    expect(pairings.retired[0]).toContain("https://relay.test");
    expect(pairings.retired[0]).toContain("signed grant");
  });

  it("says nothing when there is nothing to retire", async () => {
    // The half of the pair that is easy not to write: a healthy file must not
    // produce a notice, or the notice stops meaning anything.
    await writeFile(
      path,
      JSON.stringify({ version: 1, pairings: [good("https://relay.test")] }),
    );
    const pairings = new Pairings(path);
    await pairings.load();
    expect(pairings.retired).toEqual([]);
  });
});

describe("a pairings file this version cannot read at all", () => {
  it("says so, rather than reading as a device that never paired", async () => {
    /**
     * The whole-file case, beside the per-row ones above.
     *
     * `load` distinguishes three things a caller must not confuse: never
     * paired (silent, ordinary), a row it could not read (skipped, named),
     * and a *file* in a shape this version does not know. The third is the
     * one that reads as the first if nobody reports it — a device that
     * appears to have paired with nothing, telling somebody to run
     * `byollm connect` when their pairings are sitting on disk.
     */
    await writeFile(path, JSON.stringify({ version: 99, pairings: [] }));
    const pairings = new Pairings(path);
    await pairings.load();

    expect(pairings.list()).toEqual([]);
    expect(pairings.skipped).toEqual([
      {
        origin: path,
        problem: "the pairings file is not in a shape this version can read",
      },
    ]);
  });

  it("stays silent about a file that was never written", async () => {
    // The control, and the reason the case above matters: a daemon that has
    // never paired is the ordinary state, and reporting it would train
    // somebody to ignore the line that means something.
    const pairings = new Pairings(join(home, "absent.json"));
    await pairings.load();
    expect(pairings.skipped).toEqual([]);
  });
});
