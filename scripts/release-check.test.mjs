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
/**
 * A registry that is SERVING, and does not hold `version` — B314.
 *
 * `registry(v, [])` answered nothing at all: empty `versions`, empty
 * `dist-tags`. That is a read path that is down, and it was the only "not
 * there" this harness could express — so the check's verdict for it was the
 * only verdict "nothing is published" could ever get.
 *
 * This is the other one, and it is the state a release is in before it
 * happens: every package resolvable, every dist-tag answered, and none of them
 * naming the version asked about.
 */
function servingOther(other = "0.0.1") {
  return Object.fromEntries(
    NAMES.map((n) => [
      n,
      { versions: [other], "dist-tags": { alpha: other, latest: other } },
    ]),
  );
}

function run(version, present, attempts = "1", env = {}, fixture = undefined) {
  dir = mkdtempSync(join(tmpdir(), "release-check-"));
  const path = join(dir, "registry.json");
  writeFileSync(
    path,
    JSON.stringify(fixture ?? registry(version, present)),
    "utf8",
  );
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

  it("says the version was never published, when npm answers and lacks it", async () => {
    /**
     * **The state this check had no verdict for — B314.**
     *
     * Its two failure sentences both assume a publish was ATTEMPTED: a mix is
     * a partial release, and silence is a registry not serving. Neither covers
     * a tag that was never pushed, a workflow that never started, or somebody
     * running the check early — and in all three npm answers perfectly.
     *
     * It reported *"the shape of a registry that is not serving reads"* while
     * printing that registry's dist-tags one screen up. Whoever read that
     * would go and find npm working: the most expensive kind of wrong
     * diagnosis — correct-looking, unfalsifiable from where they stand, and
     * pointing away from the tag.
     *
     * Found by running the giving-up path on purpose before using it in a
     * release, which is what `RELEASE_CHECK_ATTEMPTS` exists for.
     */
    const seen = await run(V, [], "1", {}, servingOther());

    expect(seen.status).toBe(1);
    expect(seen.stderr).toContain("never published");
    /* The remedy points at the tag and the workflow, not at npm. */
    expect(seen.stderr).toContain("git ls-remote");
    expect(seen.stderr).toContain("gh run list");
    /* And explicitly not the sentence it used to give. */
    expect(seen.stderr).not.toContain("not serving reads");
    expect(seen.stderr).not.toContain("Confirmed live:");
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

describe("what the Release workflow can actually ask — B318", () => {
  /**
   * `alpha.103` published all six packages and the run went **red**, on the
   * step after the publish:
   *
   *     Verify the registry actually has it
   *     refusing: the hosted pin check is not on this machine.
   *
   * `release-check` asks two questions, and the second — do the two sibling
   * repositories pin this version — is `pins-checked.mjs`, which looks for
   * `../byollm-cloud` and refuses when it is absent. That refusal is right:
   * *"a check that cannot answer must not answer fine."*
   *
   * **A GitHub runner checks out one repository.** It will never have the
   * siblings, so this step asked an unanswerable question on every release and
   * reported a successful publish as a failed one. A red Release for a release
   * that worked is how somebody learns to skim the Actions tab, and the next
   * red one will be real — the same family as everything the third state
   * exists for, arriving in the workflow rather than in a script.
   *
   * The question is not dropped. It is asked where it can be answered: before
   * the tag by `tag.sh` refusal 5, and after the publish by CCB running this
   * script locally — which is the run that catches the lockfiles, and did.
   */
  const workflow = readFileSync(
    fileURLToPath(new URL("../.github/workflows/release.yml", import.meta.url)),
    "utf8",
  );

  const step = () => {
    const at = workflow.indexOf("Verify the registry actually has it");
    expect(at, "the post-publish step has moved or gone").toBeGreaterThan(-1);
    return workflow.slice(at, at + 400);
  };

  it("does not ask the sibling repositories about themselves", () => {
    /* Without this the step is red on every successful release, which is the
       state alpha.103 shipped in. */
    expect(step()).toMatch(/BYOLLM_PINS:\s*skip/u);
  });

  it("still asks the registry, which is the half a runner can answer", () => {
    /* The skip is narrow: npm is reachable from CI and the publish is exactly
       what this step exists to confirm. Dropping the whole step would trade a
       false red for a real blind spot. */
    expect(step()).toContain("release-check.mjs");
  });

  it("leaves the opt-out loud, so the gap is in the log", () => {
    /**
     * `pins-checked` prints "THE HOSTED PINS ARE NOT CHECKED FOR THIS STEP"
     * when skipped. If that ever became silent, a green Release would imply
     * three repositories agree when one machine looked at one of them.
     */
    const pins = readFileSync(
      fileURLToPath(new URL("./pins-checked.mjs", import.meta.url)),
      "utf8",
    );
    expect(pins).toContain("THE HOSTED PINS ARE NOT CHECKED FOR THIS STEP");
    expect(pins).toMatch(/BYOLLM_PINS"\]\s*===\s*"skip"/u);
  });
});

describe("the channel a version belongs to — B339", () => {
  /**
   * This check hardcoded `alpha`. `0.1.0` published to `latest`, `alpha`
   * correctly stayed at `0.1.0-alpha.103`, and the check reported **six BAD
   * TAGs and exited 1 on a release that was entirely correct** — then told the
   * operator to re-run a workflow that cannot move a dist-tag, and died before
   * the step that creates the GitHub Release.
   *
   * Todd, 09-22: *"we need to remove the alpha check now that we are out of
   * alpha."*
   */

  /** A registry serving `version` on `channel` only, as npm really would. */
  const onChannel = (version, channel, otherwise = "0.0.9") =>
    Object.fromEntries(
      NAMES.map((n) => [
        n,
        {
          versions: [version],
          "dist-tags": {
            alpha: otherwise,
            latest: otherwise,
            [channel]: version,
          },
        },
      ]),
    );

  it("asks `latest` for a stable version, and passes", async () => {
    const version = "1.2.3";
    const { status, stdout } = await run(
      version,
      NAMES,
      "1",
      {},
      onChannel(version, "latest"),
    );
    expect(stdout).toContain("tagged `latest`");
    expect(status, stdout).toBe(0);
  });

  it("asks `alpha` for a prerelease, and passes", async () => {
    /**
     * The mutation case. Hardcoding `latest` back into the script passes the
     * one above and fails this one — which is the pair that makes the rule a
     * rule rather than a different constant.
     */
    const version = "1.2.3-alpha.7";
    const { status, stdout } = await run(
      version,
      NAMES,
      "1",
      {},
      onChannel(version, "alpha"),
    );
    expect(stdout).toContain("tagged `alpha`");
    expect(status, stdout).toBe(0);
  });

  it("does not ask a prerelease to have moved `latest`", async () => {
    /* `release.yml` §4 sends a prerelease to its own tag deliberately, so
       `latest` naming the release BEFORE it is the design working. Reporting
       that as a problem is how a correct release gets a red. */
    const version = "1.2.3-beta.2";
    const { status, stdout } = await run(
      version,
      NAMES,
      "1",
      {},
      onChannel(version, "beta", "1.2.2"),
    );
    expect(status, stdout).toBe(0);
    expect(stdout).toContain("tagged `beta`");
  });

  it("refuses a stable version whose `latest` still names the previous one", async () => {
    const version = "1.2.3";
    const stale = Object.fromEntries(
      NAMES.map((n) => [
        n,
        {
          versions: [version],
          "dist-tags": { alpha: "1.2.2", latest: "1.2.2" },
        },
      ]),
    );
    const { status, stdout, stderr } = await run(
      version,
      NAMES,
      "1",
      {},
      stale,
    );
    const out = stdout + stderr;
    expect(status, out).toBe(1);
    expect(out).toContain("BAD TAG");

    /**
     * **The remedy has to be one that works.**
     *
     * It said "This is a partial release... Re-run the Release workflow for
     * this tag." Both halves were wrong for this state: the packages ARE
     * published, and re-running cannot move a dist-tag — publishing is
     * idempotent, so it refuses and changes nothing. A remedy that cannot work
     * is the loop somebody runs twice before they start doubting the message.
     */
    expect(out).toContain("npm dist-tag add");
    expect(out).not.toMatch(/Re-run the Release workflow for this tag/u);
    expect(out).not.toMatch(/This is a partial release/u);
  });

  it("never offers to point `latest` at a prerelease", async () => {
    /**
     * Found by running this against the real registry after the channel
     * change, not from a fixture.
     *
     * `latest` is 0.1.0 and the version checked was 0.1.0-alpha.103, so
     * `latest` is AHEAD. The note called that "still behind" and printed
     * `npm dist-tag add <pkg>@0.1.0-alpha.103 latest` — a command that drags
     * every `npm install byollm` back onto a prerelease, offered by a line
     * describing the correct state as a lag.
     *
     * `release.yml` §4 never sends a prerelease to `latest`, so there is no
     * state in which that command is right.
     */
    const version = "1.2.3-alpha.7";
    const ahead = Object.fromEntries(
      NAMES.map((n) => [
        n,
        {
          versions: [version],
          "dist-tags": { alpha: version, latest: "1.2.3" },
        },
      ]),
    );
    const { status, stdout } = await run(version, NAMES, "1", {}, ahead);
    expect(status, stdout).toBe(0);
    expect(
      stdout,
      "the check offers to move `latest` onto a prerelease",
    ).not.toMatch(/dist-tag add \S+@1\.2\.3-alpha\.7 latest/u);
    expect(stdout).not.toMatch(/`latest` still behind/u);
    expect(stdout).toContain("never moves `latest` for a prerelease");
  });

  it("does not promise a named dist-tag in its own header", () => {
    /**
     * **The decay that followed B336 by one day, and CW caught it.**
     *
     * The channel change landed in the code and the file's opening docstring
     * kept saying the check asserts "the `alpha` dist-tag points at it", with
     * a section headed "`latest` is reported, never asserted". Both were true
     * of the alpha era and false of the code beneath them — the prose moved
     * out from under the constant, which is exactly what B336 was about, one
     * file over.
     *
     * Reading prose is the only way to catch this, so the assertion is narrow
     * on purpose: the header's numbered claim must name the RULE, and must not
     * name a tag as the thing asserted. The file mentions `alpha` elsewhere
     * for honest reasons — the history of this very bug — so a blanket ban on
     * the word would forbid the paragraph explaining why the word went.
     */
    const script = readFileSync(join("scripts", "release-check.mjs"), "utf8");
    const header = script.slice(0, script.indexOf("*/"));
    expect(header, "the opening docstring has moved").toContain(
      "It queries npm for each package and asserts two things",
    );

    expect(
      header,
      "the header promises a named dist-tag again; it asserts the version's " +
        "own channel, and hardcoding one is what cost the first stable release",
    ).not.toMatch(/the `(?:alpha|beta|next|latest)` dist-tag points at it/u);
    /**
     * Asked of the section HEADING, not of the words.
     *
     * The first version of this rule matched the bare phrase and failed on the
     * paragraph that QUOTES it while explaining why it went — a rule that
     * cannot tell a citation from a claim, which is the same defect
     * `rehearse-the-cut.test.mjs` found in itself. A revert restores the
     * heading; the history keeps the quotation.
     */
    expect(header).not.toMatch(
      /^\s*\*\s*##\s*`latest` is reported, never asserted/mu,
    );

    /* And that it names the rule it actually follows, rather than going
       silent — a header that says nothing cannot decay, and cannot inform. */
    expect(header).toMatch(/channelOf|CHANNEL/u);
  });

  it("spells the rule the way `release.yml` spells it", () => {
    /**
     * **Two sources.** CW allowed the four lines to be copied with a comment
     * saying where they live; a copy with a pointer is still a copy, and the
     * failure it invites is the two ends disagreeing about which tag holds a
     * release. So the workflow's own `case` is parsed and compared.
     *
     * `release.yml` is the source of truth because it is what actually
     * publishes. If somebody adds `*-rc.*) TAG_NAME=rc ;;` there, this goes
     * red until the script learns it — instead of the check quietly asking the
     * wrong tag on the next release candidate.
     */
    const workflow = readFileSync(
      join(".github", "workflows", "release.yml"),
      "utf8",
    );
    const block = /case "\$VERSION" in([\s\S]*?)esac/u.exec(workflow);
    expect(block, "release.yml §4's case statement has moved").not.toBeNull();

    const arms = [
      ...(block?.[1] ?? "").matchAll(/(\S+)\)\s*TAG_NAME=(\w+)/gu),
    ].map(([, pattern, tag]) => ({ pattern, tag }));
    expect(
      arms.length,
      "no arms parsed out of the case statement",
    ).toBeGreaterThan(2);

    /* A version that exercises each arm, built from the arm's own glob. */
    const sample = (pattern) =>
      pattern === "*" ? "9.9.9" : `9.9.9${pattern.replaceAll("*", "")}1`;

    const script = readFileSync(join("scripts", "release-check.mjs"), "utf8");
    const channelOf = (v) => {
      if (v.includes("-alpha.")) return "alpha";
      if (v.includes("-beta.")) return "beta";
      if (v.includes("-")) return "next";
      return "latest";
    };
    /* The local copy above is what the assertion compares WITH; that it
       matches the script's own four lines is asserted separately, so a drift
       in either one is caught. */
    for (const line of [
      'if (v.includes("-alpha.")) return "alpha";',
      'if (v.includes("-beta.")) return "beta";',
      'if (v.includes("-")) return "next";',
      'return "latest";',
    ]) {
      expect(
        script,
        "release-check.mjs's channelOf has been reworded",
      ).toContain(line);
    }

    for (const { pattern, tag } of arms) {
      expect(
        channelOf(sample(pattern)),
        `release.yml sends ${pattern} to ${tag}`,
      ).toBe(tag);
    }
  });
});
