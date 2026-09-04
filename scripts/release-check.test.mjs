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
 * The partial case uses a version that is *actually* partial on npm today
 * rather than a fixture, so the shape under test is one the registry really
 * serves.
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
  it("fails, and sees the asymmetry, on a genuinely partial version", () => {
    /**
     * A real partial state from the real registry — no fixture.
     *
     * `@byollm/control-plane` first appears at `alpha.58`; every other
     * package goes back to `alpha.0`. So at `0.1.0-alpha.10` five packages
     * are present and one has never existed, which is the shape the whole
     * check is for: some at the version, others not, and every one of them
     * resolvable by anyone who installs.
     *
     * This is the exit-1 path, and until now it had no test at all — the one
     * branch that matters most was the one never exercised.
     */
    const seen = run("0.1.0-alpha.10", "1");

    expect(seen.status).toBe(1);
    /* The asymmetry itself: the absent package reads as unconfirmed while
       its siblings do not. An old version also fails the `alpha` dist-tag
       check, which is correct and is not what this asserts. */
    expect(seen.stdout).toMatch(/UNREAD\s+@byollm\/control-plane/u);
    expect(seen.stdout).not.toMatch(/UNREAD\s+@byollm\/protocol/u);
    expect(seen.stderr).toContain("partial release");
  }, 120_000);

  it("does not call a total silence a partial release", () => {
    /**
     * The other shape, and the reason the message branches.
     *
     * A version npm has never seen for anything answers for nothing. That is
     * not a partial — a publish that failed outright fails the step above —
     * it is a registry not serving reads, and the first move is different:
     * wait, rather than republish. Same exit code, because either way the
     * release could not be confirmed.
     */
    const seen = run("0.1.0-alpha.9999", "1");

    expect(seen.status).toBe(1);
    expect(seen.stderr).toContain("No package answered");
    /* The tell that it is not claiming asymmetry. Asserted on the half that
       only appears in the partial branch — the first version of this test
       looked for "shape of a partial release", which the uniform message
       also contains, in the sentence saying it is not one. */
    expect(seen.stderr).not.toContain("Confirmed live:");
    expect(seen.stderr).toContain("re-run this check");
  }, 120_000);

  it("exits 0 for a version that is genuinely live", () => {
    /* The control. Everything above is satisfied by a script that never
       succeeds, and a release check that always complains is one nobody
       keeps. */
    const seen = run("0.1.0-alpha.77");

    expect(seen.status).toBe(0);
    expect(seen.stdout).toContain("is live on every package");
  }, 300_000);
});
