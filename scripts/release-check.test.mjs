import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * A read that timed out is not a broken release — ruled 2026-09-04.
 *
 * The check reported failure on three consecutive cuts — .74, .76 and .77,
 * every time on `@byollm/protocol`, the largest package — while every version
 * was live. **A red that is benign three times running is a red people learn
 * to ignore**, which is the failure this step exists to prevent.
 *
 * The first fix gave unread its own exit code and reported it green. That was
 * the wrong trade and the review caught it: a package that was never
 * published and one the registry is slow to serve are the same empty read, so
 * making unread benign made a real partial release pass. What actually fixed
 * the crying wolf was the window — two minutes against a package that took
 * two. It is five now, and after it, anything unconfirmed fails.
 *
 * ## Why these run against fixtures
 *
 * The first version of this file drove the live registry. Six packages,
 * several reads each, three platforms — **Windows CI spent thirty minutes and
 * then failed on a slow read**, which says nothing whatever about whether
 * this logic is right. A test that needs the network to say what a function
 * does is a test that reports the network.
 *
 * The real registry is still exercised: this script does its actual job on
 * every release, and both branches were rehearsed against it by hand before
 * shipping — `0.1.0-alpha.10` is genuinely partial on npm (control-plane
 * first appears at alpha.58 while its siblings go back to alpha.0) and
 * reported the asymmetry; a version npm has never seen reported silence.
 * What the suite proves is the reasoning, in milliseconds.
 */
const script = fileURLToPath(new URL("./release-check.mjs", import.meta.url));

/**
 * The packages, DERIVED — the same rule the script and the release workflow
 * apply, for the same reason.
 *
 * This was six names written out, and it broke the moment a seventh package
 * joined: the fixture answered for six, the script asked about seven, and the
 * missing one read as an unpublished package — a test failing for a reason
 * that has nothing to do with what it asserts.
 *
 * Which is the bug the script's own header is about (`@byollm/relay` absent
 * from four hardcoded lists at once), arriving in the test that proves the
 * script does not have it.
 */
const NAMES = readdirSync("packages")
  .map((dir) => join("packages", dir, "package.json"))
  .filter((manifest) => existsSync(manifest))
  .map((manifest) => JSON.parse(readFileSync(manifest, "utf8")))
  .filter((pkg) => pkg.private !== true)
  .map((pkg) => pkg.name)
  .sort();

let dir;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A registry that holds `version` for every package named in `present`. */
function registry(version, present) {
  const entry = (has) => ({
    versions: has ? [version] : [],
    "dist-tags": has ? { alpha: version, latest: version } : {},
  });
  return Object.fromEntries(NAMES.map((n) => [n, entry(present.includes(n))]));
}

/**
 * `BYOLLM_PINS` by default, because these cases are about npm — B234.
 *
 * The script also asks whether the repositories that pin these packages name
 * the version, and that question needs two private checkouts this repository's
 * CI does not have. Those pins are proven where they live, by
 * `byollm-cloud/infra/test/pins-agree.test.ts`; what belongs here is that the
 * question gets ASKED and its answer honoured, which is what the last two
 * cases below are for.
 *
 * A default of `skip` would be exactly the omission B234 exists to stop if it
 * were the default on release night. It is not: it is set by this harness, per
 * run, and the control case asserts the banner the skip prints — so deleting
 * the pin step from the script would take the banner with it and go red.
 */
function run(version, present, attempts = "1", env = {}) {
  dir = mkdtempSync(join(tmpdir(), "release-check-"));
  const path = join(dir, "registry.json");
  writeFileSync(path, JSON.stringify(registry(version, present)), "utf8");
  return new Promise((settle) => {
    /* `execFile`, never a synchronous spelling — byollm_004 §2, and eslint
       enforces it in this repository's tests too. */
    execFile(
      process.execPath,
      [script, version],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          RELEASE_CHECK_ATTEMPTS: attempts,
          RELEASE_CHECK_FIXTURE: path,
          BYOLLM_PINS: "skip",
          ...env,
        },
      },
      (error, stdout, stderr) => {
        settle({
          status: error === null ? 0 : (error.code ?? -1),
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

const V = "0.1.0-alpha.999";

describe("the release read-back", () => {
  it("fails a partial release, and names what did answer", async () => {
    /* The dangerous state: some packages at the version, others not, and
       every one of them resolvable by anyone who installs. This is the path
       that had no test at all — the branch the whole check exists for. */
    const seen = await run(
      V,
      NAMES.filter((n) => n !== "@byollm/control-plane"),
    );

    expect(seen.status).toBe(1);
    /* Asserted on phrases that do not span a line break — the message is
       hand-wrapped, and "the shape of a partial release" is split across two
       lines in the source. */
    expect(seen.stderr).toContain("Some packages answered and these did not");
    expect(seen.stderr).toContain("Confirmed live:");
    expect(seen.stderr).toContain("@byollm/protocol");
    expect(seen.stdout).toMatch(/UNREAD\s+@byollm\/control-plane/u);
  });

  it("does not call a total silence a partial release", async () => {
    /* A publish that failed outright fails the step above, so nothing
       answering is a registry not serving reads. Same exit code — the release
       is unconfirmed either way — and a different first move: wait, rather
       than republish. */
    const seen = await run(V, []);

    expect(seen.status).toBe(1);
    expect(seen.stderr).toContain("No package answered");
    expect(seen.stderr).not.toContain("Confirmed live:");
    expect(seen.stderr).toContain("re-run this check");
  });

  it("exits 0 when every package is there, having asked about the pins", async () => {
    /* The control. Everything above is satisfied by a script that never
       succeeds, and a release check that always complains is one nobody
       keeps.

       The banner is the second half of the control: it is printed by
       `pins-checked.mjs` and by nothing else, so its presence is this test
       watching the pin step run. Remove the step and a green release goes back
       to meaning "npm answered", which is what it meant on `.97`. */
    const seen = await run(V, NAMES);

    expect(seen.status).toBe(0);
    expect(seen.stdout).toContain("is live on every package");
    expect(seen.stderr).toContain("THE HOSTED PINS ARE NOT CHECKED");
  });
});

describe("the pins, which are the other half of a release — B234", () => {
  it("does not call a release green when the pin question went unanswered", async () => {
    /**
     * Every package live on npm, and the answer about the pins is anything but
     * zero — because they disagree, or because this machine has no checkouts
     * to ask. Both are "the pin is not known to be right", and shipping either
     * one as green is `.97`: a `.97` daemon on the fleet under a repository
     * claiming `.96`, invisible from the outside, caught by a question rather
     * than a check.
     *
     * Written to be true with or without those checkouts, so it is the same
     * test on CI and on the machine that cuts the release.
     */
    const seen = await run(V, NAMES, "1", { BYOLLM_PINS: "" });

    expect(seen.status).toBe(1);
    /* The refusal says both halves in one breath: the release happened, and
       the repositories that pin it have not caught up. Reading only the first
       clause is how `.97` got to the edge of a rebake. */
    expect(seen.stderr).toContain("is live on every package");
    expect(seen.stderr).toContain("do not all say so");
  });

  it("asks only after the registry has answered", async () => {
    /* A partial publish is the more urgent finding and republishing is what
       fixes it; a stale pin is a commit in another repository. Reading the pin
       failure first invites somebody to fix the cheap one and re-run. */
    const seen = await run(
      V,
      NAMES.filter((n) => n !== "@byollm/control-plane"),
      "1",
      { BYOLLM_PINS: "" },
    );

    expect(seen.status).toBe(1);
    expect(seen.stderr).toContain("Some packages answered and these did not");
    expect(seen.stderr).not.toContain("do not all say so");
  });
});
