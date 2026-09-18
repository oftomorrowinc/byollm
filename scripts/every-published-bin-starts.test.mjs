import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every published bin starts, from somewhere that is not us — B243.
 *
 * ## Why this file exists rather than four files
 *
 * B243 was one bin: `byollm-certify` could not load a relative path, and
 * nothing in this workspace had ever run it. `certify()` is tested directly,
 * which is right for an engine — and that is exactly what left the argv path
 * proven by nobody.
 *
 * The obvious next question was whether the other three had the same seam. Two
 * did, in a smaller way: `byollm-audit-deployment` treated `--help` as a URL
 * and exited 1 after a failed scan of the flag, and every published invocation
 * of `keygen` used the ambiguous `npx <package> <bin>` form.
 *
 * **So the gate is the set, derived from the manifests.** A hand-written list
 * of four bins is this repository's most-repeated defect — `@byollm/relay` has
 * gone missing from one twice — and a bin added tomorrow gets checked here
 * without anybody remembering this file.
 *
 * ## What it asserts, and why `--help`
 *
 * `--help` is what a person types before anything else, and it is the flag
 * B243 found broken on two bins out of two that had one. The universal
 * property is narrower than "prints usage", because not every bin must
 * implement it: **whatever it does, it must not fail by unwinding through our
 * own code.** A Node stack trace naming `@byollm/...` is the misattribution
 * this whole row is about — the reader concludes our package is broken, and
 * nothing in the trace says otherwise.
 *
 * Run from a temp directory, because relative resolution against `dist/`
 * happens to find things when you are standing next to `dist/`.
 */
const PACKAGES = "packages";

/** Every bin we publish, with the file it points at — derived. */
function publishedBins() {
  const found = [];
  for (const dir of readdirSync(PACKAGES)) {
    const manifest = join(PACKAGES, dir, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    if (pkg.private === true) continue;
    for (const [bin, target] of Object.entries(pkg.bin ?? {})) {
      found.push({ bin, pkg: pkg.name, path: resolve(PACKAGES, dir, target) });
    }
  }
  return found;
}

const BINS = publishedBins();

function run(path, args) {
  const cwd = mkdtempSync(join(tmpdir(), "bin-"));
  try {
    const out = execFileSync(process.execPath, [path, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out, err: "" };
  } catch (error) {
    return {
      code: error.status ?? -1,
      out: error.stdout ?? "",
      err: error.stderr ?? "",
    };
  }
}

describe("every bin we publish", () => {
  it("is found, and there is more than one", () => {
    /* The control. "No bin misbehaves" is satisfied perfectly by finding no
       bins, and this set is discovered rather than written down. */
    expect(BINS.length).toBeGreaterThan(2);
  });

  it("exists on disk where the manifest says", () => {
    /**
     * A `bin` pointing at a file the package does not ship installs cleanly
     * and fails at the moment somebody runs it — which is the same shape as
     * B243 and even quieter, because `npm install` says nothing.
     */
    for (const { bin, path } of BINS) {
      expect(existsSync(path), `${bin} -> ${path}`).toBe(true);
    }
  });

  it("starts when asked for help, without unwinding through our code", () => {
    for (const { bin, pkg, path } of BINS) {
      const ran = run(path, ["--help"]);

      expect(ran.code, `${bin} did not start at all`).not.toBe(-1);
      const said = `${ran.out}${ran.err}`;
      expect(said, `${bin} could not load its own modules`).not.toContain(
        "ERR_MODULE_NOT_FOUND",
      );
      /* The trace is the misattribution: a reader seeing node unwind through
         our package concludes the package is broken, and there is no second
         reading available to them. */
      expect(said, `${bin} printed a Node stack trace`).not.toContain(
        "node:internal",
      );
      expect(said, `${bin} printed a stack frame`).not.toMatch(/\n\s+at /u);
      expect(said, `${bin} is silent about ${pkg}`).not.toBe("");
    }
  });

  it("does not treat --help as data", () => {
    /**
     * `byollm-audit-deployment` did: it read `--help` as the URL to audit and
     * exited 1 after failing to scan the flag. A flag answered with a failed
     * attempt at itself is worse than an unrecognised one — it reads as the
     * tool having tried, and as the deployment being broken.
     *
     * Asserted as an absence of the flag in the output, which is what "it was
     * used as a value" looks like from outside.
     */
    for (const { bin, path } of BINS) {
      const said = run(path, ["--help"]);
      expect(
        `${said.out}${said.err}`,
        `${bin} echoed --help back, which is what using it as a value looks like`,
      ).not.toMatch(/—\s*--help|audit.*--help|posture.*--help/u);
    }
  });
});
