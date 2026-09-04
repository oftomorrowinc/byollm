import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const NAMES = [
  "byollm",
  "@byollm/protocol",
  "@byollm/relay",
  "@byollm/server",
  "@byollm/control-plane",
  "@byollm/conformance",
];

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

function run(version, present, attempts = "1") {
  dir = mkdtempSync(join(tmpdir(), "release-check-"));
  const path = join(dir, "registry.json");
  writeFileSync(path, JSON.stringify(registry(version, present)), "utf8");
  const options = {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      RELEASE_CHECK_ATTEMPTS: attempts,
      RELEASE_CHECK_FIXTURE: path,
    },
  };
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, [script, version], options),
      stderr: "",
    };
  } catch (error) {
    return {
      status: error.status,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
    };
  }
}

const V = "0.1.0-alpha.999";

describe("the release read-back", () => {
  it("fails a partial release, and names what did answer", () => {
    /* The dangerous state: some packages at the version, others not, and
       every one of them resolvable by anyone who installs. This is the path
       that had no test at all — the branch the whole check exists for. */
    const seen = run(
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

  it("does not call a total silence a partial release", () => {
    /* A publish that failed outright fails the step above, so nothing
       answering is a registry not serving reads. Same exit code — the release
       is unconfirmed either way — and a different first move: wait, rather
       than republish. */
    const seen = run(V, []);

    expect(seen.status).toBe(1);
    expect(seen.stderr).toContain("No package answered");
    expect(seen.stderr).not.toContain("Confirmed live:");
    expect(seen.stderr).toContain("re-run this check");
  });

  it("exits 0 when every package is there", () => {
    /* The control. Everything above is satisfied by a script that never
       succeeds, and a release check that always complains is one nobody
       keeps. */
    const seen = run(V, NAMES);

    expect(seen.status).toBe(0);
    expect(seen.stdout).toContain("is live on every package");
  });
});
