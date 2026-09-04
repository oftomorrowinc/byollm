import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A read that timed out is not a broken release — ruled 2026-09-04.
 *
 * This check reported failure on three consecutive cuts — .74, .76 and .77,
 * every time on `@byollm/protocol`, which is also the largest package — while
 * every version was in fact live. **A red that is benign three times running
 * is a red people learn to ignore**, which is precisely the failure the step
 * exists to prevent: the next genuine partial release goes out behind a shrug
 * from somebody who has learned that this one cries wolf.
 *
 * So the two findings stop sharing an answer. A partial release is a fact
 * about npm's contents and still fails. A read this check could not complete
 * is a fact about *this check*, exits 3, and is reported unproven.
 *
 * **The prover is not the proven**, and unproven is a third state.
 *
 * Driven against the real registry with the window forced to one attempt,
 * which is what the override exists for: the giving-up path costs five
 * minutes to reach honestly, and a failure message that expensive to
 * reproduce is a failure message nobody has ever read.
 *
 * The file is `.mjs` because that is what the suite globs under `scripts/`. A
 * `.ts` sibling here is a test nothing runs, which the first version of this
 * was for about a minute.
 */
const script = fileURLToPath(new URL("./release-check.mjs", import.meta.url));

/*
 * `execFileSync`, not `spawnSync` — byollm_004 §2 bans the shell-invoking
 * APIs and the lint is absolute about it. A fixed argv array either way; what
 * changes is that a non-zero exit arrives as a throw, so the code has to be
 * read off the error rather than off a result.
 */
function run(version, attempts) {
  const options = {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(attempts === undefined ? {} : { RELEASE_CHECK_ATTEMPTS: attempts }),
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

describe("the release read-back", () => {
  it("exits 3 and says unproven when it cannot read", () => {
    /* A version npm has never seen, with the window forced to one attempt —
       so this is the giving-up branch, reached in seconds. */
    const seen = run("0.1.0-alpha.9999", "1");

    expect(seen.status).toBe(3);
    expect(seen.stderr).toContain("UNPROVEN, not failed");
    /* And it must not describe a partial release, which is the other finding
       and needs the opposite response from whoever reads it. */
    expect(seen.stderr).not.toContain("This is a partial release");
  }, 120_000);

  it("exits 0 for a version that is genuinely live", () => {
    /* The control. Everything above is satisfied by a script that never
       succeeds, and a release check that always says something is wrong is a
       release check nobody keeps. */
    const seen = run("0.1.0-alpha.77");

    expect(seen.status).toBe(0);
    expect(seen.stdout).toContain("is live on every package");
  }, 300_000);
});
