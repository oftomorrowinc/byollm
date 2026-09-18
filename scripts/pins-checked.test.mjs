import { execFile } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The shim that decides what "cannot answer" means — B234.
 *
 * `pins-checked.mjs` holds one judgement and it is the whole reason the file
 * exists: a machine that cannot see the repositories which pin these packages
 * must not report that their pins are fine. Everything else it does is find a
 * script and forward an exit code.
 *
 * It locates that script **relative to itself**, which is what makes this
 * testable without the private checkouts: the shim is copied into a temporary
 * `byollm/scripts/`, and a `byollm-cloud/scripts/pins-agree.mjs` is written
 * beside it — or deliberately not written. No seam, no override, no
 * environment variable that exists only for tests; the resolution under test
 * is the resolution that runs on release night.
 *
 * The real check lives in `byollm-cloud`, next to the pins, and is proven
 * there by `infra/test/pins-agree.test.ts`. Nothing in this repository's suite
 * reaches for those checkouts, because its CI does not have them.
 */
const SHIM = fileURLToPath(new URL("./pins-checked.mjs", import.meta.url));

let dir;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/**
 * A pair of sibling repositories, as the shim expects to find them.
 *
 * `checker` is the stub that stands in for `pins-agree.mjs`: it records the
 * arguments it was handed and exits with the code the case is about. Omit it
 * and the sibling repository simply is not there.
 */
function siblings({ checkerExit, checkerDies } = {}) {
  dir = mkdtempSync(join(tmpdir(), "pins-checked-"));
  const here = join(dir, "byollm", "scripts");
  mkdirSync(here, { recursive: true });
  copyFileSync(SHIM, join(here, "pins-checked.mjs"));
  if (checkerExit !== undefined || checkerDies === true) {
    const there = join(dir, "byollm-cloud", "scripts");
    mkdirSync(there, { recursive: true });
    writeFileSync(
      join(there, "pins-agree.mjs"),
      `#!/usr/bin/env node\n` +
        `console.log("ARGS " + process.argv.slice(2).join(" "));\n` +
        (checkerDies === true
          ? `process.kill(process.pid, "SIGKILL");\n`
          : `process.exit(${String(checkerExit)});\n`),
    );
  }
  return join(here, "pins-checked.mjs");
}

/**
 * Both streams, on both paths.
 *
 * The first version of this helper returned stdout alone when the shim
 * succeeded, and the skip banner is written to stderr — so the case asserting
 * that a skip announces itself in capitals was reading an empty string. A
 * harness that drops half the output on the success path is a harness that can
 * only find failures.
 */
/**
 * Both streams, on both paths, through `execFile` — byollm_004 §2 bans the
 * synchronous spellings and eslint enforces it here too.
 *
 * The first version of this helper returned stdout alone when the shim
 * succeeded, and the skip banner is written to stderr — so the case asserting
 * that a skip announces itself in capitals was reading an empty string. A
 * harness that drops half the output on the success path is a harness that can
 * only find failures.
 */
function run(shim, args, env = {}) {
  return new Promise((settle) => {
    execFile(
      process.execPath,
      [shim, ...args],
      { encoding: "utf8", env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        settle({
          /* `error.code` is the exit status for execFile; a signal death
             leaves it undefined, and undefined must not read as a pass. */
          status: error === null ? 0 : (error.code ?? -1),
          out: `${String(stdout)}${String(stderr)}`,
        });
      },
    );
  });
}

describe("finding the check that lives next to the pins", () => {
  it("runs it, and hands it every argument it was given", async () => {
    /* The control. Without it, a shim hard-wired to refuse would satisfy the
       case below and this file would be asserting a constant. */
    const shim = siblings({ checkerExit: 0 });
    const seen = await run(shim, [
      "0.1.0-alpha.103",
      "--manifests-only",
      "--committed",
    ]);

    expect(seen.status).toBe(0);
    expect(seen.out).toContain(
      "ARGS 0.1.0-alpha.103 --manifests-only --committed",
    );
  });

  it("fails when the check fails", async () => {
    const shim = siblings({ checkerExit: 1 });
    expect((await run(shim, ["0.1.0-alpha.103"])).status).toBe(1);
  });

  it("fails when the check dies on a signal and names no exit code", async () => {
    /**
     * A process killed by a signal has a null status, and `null ?? 0` is a
     * pass — the gate answering "fine" because the thing it asked was struck
     * down mid-sentence. Out of memory, a stray `pkill`, a laptop lid: none of
     * them is evidence that two repositories agree about a version.
     */
    const shim = siblings({ checkerDies: true });
    const seen = await run(shim, ["0.1.0-alpha.103"]);

    expect(seen.status).not.toBe(0);
    expect(seen.status).not.toBeNull();
  });

  it("refuses when the sibling repository is not on this machine", async () => {
    /**
     * The judgement. A release is only honest when this repository and the two
     * that pin its packages agree, and a machine that cannot see them cannot
     * say they agree. "Cannot answer" rendered as green is the shape of every
     * expensive bug in this portfolio — most recently a console fence with
     * nobody behind it, green everywhere it was measured.
     */
    const shim = siblings();
    const seen = await run(shim, ["0.1.0-alpha.103"]);

    expect(seen.status).toBe(1);
    expect(seen.out).toContain("not on this machine");
    expect(seen.out).toContain("byollm-cloud");
  });
});

describe("BYOLLM_PINS=skip", () => {
  it("passes, and says in capitals that nothing was checked", async () => {
    /* The difference between a decision and an omission is that somebody
       typed the decision — and that it is impossible to read the output
       afterwards and believe the pins were checked. */
    const shim = siblings();
    const seen = await run(shim, ["0.1.0-alpha.103"], { BYOLLM_PINS: "skip" });

    expect(seen.status).toBe(0);
    expect(seen.out).toContain("THE HOSTED PINS ARE NOT CHECKED");
  });

  it("is that exact word, not any value at all", async () => {
    /* `BYOLLM_PINS=1`, `=true`, `=yes` are what somebody types when they are
       guessing at a flag they half-remember. None of them turns the gate off:
       the refusal below is the gate still running. */
    const shim = siblings();
    for (const value of ["1", "true", "yes", ""]) {
      expect(
        (await run(shim, ["0.1.0-alpha.103"], { BYOLLM_PINS: value })).status,
        `BYOLLM_PINS=${value} turned the gate off`,
      ).toBe(1);
    }
  });
});

/**
 * The gate at its call site — B234's first half.
 *
 * `tag.sh` is a shell script whose subject is an irreversible act, so it is
 * read rather than driven: rehearsing it means making a tag, and the one
 * property worth asserting is that the step is a command rather than a
 * sentence in a comment.
 */
describe("the tag cannot be made without asking", () => {
  const tag = readFileSync(
    fileURLToPath(new URL("./tag.sh", import.meta.url)),
    "utf8",
  );
  const runbook = readFileSync(
    fileURLToPath(new URL("../docs/releasing.md", import.meta.url)),
    "utf8",
  );

  const invocation = tag.split("\n").findIndex((line) =>
    /* `startsWith` on the TRIMMED line, so `# node …` and
           `true # node …` are both excluded while `… || exit 1` is not. */
    line
      .trim()
      .startsWith(
        'node scripts/pins-checked.mjs "$version" --manifests-only --committed',
      ),
  );

  it("runs the check as a command, not as a comment", () => {
    /* A whole trimmed line that is exactly the command cannot be commented
       out and cannot have a `true` in front of it — which is how a gate that
       somebody stepped around once stays stepped around. */
    expect(invocation, "tag.sh does not run the pin check").toBeGreaterThan(-1);
  });

  it("lets the refusal stop the tag", () => {
    /* `tag.sh` is `set -eu`, which does not stop on a failing command in every
       spelling somebody might reach for, so the exit is explicit and this is
       the assertion that it stays explicit. */
    const line = tag.split("\n")[invocation];
    expect(line, "a failing pin check does not stop the tag").toContain(
      "|| exit 1",
    );
  });

  it("asks before the tag is made", () => {
    /* After `git tag` the refusal would be a report. The whole of B234 is that
       the tag cannot exist, not that somebody is told about it afterwards. */
    const tags = tag
      .split("\n")
      .findIndex((line) => line.trim().startsWith("git tag -a"));
    expect(tags).toBeGreaterThan(-1);
    expect(invocation).toBeLessThan(tags);
  });

  it("is the order the runbook tells somebody to work in", () => {
    /**
     * The manifests move BEFORE the tag and the lockfiles after the publish,
     * because a lockfile cannot resolve a version npm has not served. A
     * runbook that put them in the other order would send whoever cuts the
     * next release into a refusal with no way out but the escape hatch.
     */
    const pins = runbook.indexOf("Move the hosted pins");
    const tagStep = runbook.indexOf("./scripts/tag.sh");
    const locks = runbook.indexOf("--lockfile-only");
    expect(pins).toBeGreaterThan(-1);
    expect(locks).toBeGreaterThan(-1);
    expect(pins, "the runbook tags before it pins").toBeLessThan(tagStep);
    expect(locks, "the runbook locks before it tags").toBeGreaterThan(tagStep);
  });
});
