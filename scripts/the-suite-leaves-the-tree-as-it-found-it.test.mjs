import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  changedMessage,
  treeState,
} from "./the-suite-leaves-the-tree-as-it-found-it.mjs";

/**
 * The watcher that refuses a run which rewrote this repository.
 *
 * It exists because `bump-version.mjs` rewrites every manifest under
 * `process.cwd()`, and a probe run from the wrong directory renumbered fifteen
 * tracked files here to `0.1.0` in one command. **A test that forgets `cwd`
 * does exactly that and passes** — which is why `rehearse-the-cut.mjs` copies
 * the tree before bumping and why every bumper case passes `cwd: <fixture>`.
 *
 * The comparison is pure so it can be tested; `globalSetup` is plumbing, and
 * what it is plumbed to is asserted below.
 */

const made = [];
afterEach(() => {
  while (made.length > 0) rmSync(made.pop(), { recursive: true, force: true });
});

describe("the verdict", () => {
  it("says nothing when the tree is as it was", () => {
    expect(changedMessage(" M a.txt\n", " M a.txt\n")).toBeNull();
  });

  it("says nothing when the tree was dirty throughout", () => {
    /* Work in progress is nobody's business here. The rule is "did the SUITE
       change it", which is a comparison rather than a demand for a clean
       tree — a watcher that failed on uncommitted work would be switched off
       on the first day somebody used it. */
    const wip = " M packages/relay/src/index.ts\n";
    expect(changedMessage(wip, wip)).toBeNull();
  });

  it("names what appeared", () => {
    const said = changedMessage("", " M package.json\n M README.md\n");
    expect(said).toContain("package.json");
    expect(said).toContain("README.md");
    expect(said, "the message does not say where to read why").toContain(
      "B333",
    );
  });

  it("names the likely cause, because the symptom does not", () => {
    /* Fifteen renumbered manifests look like somebody's edit. The one thing a
       reader needs is that a script was run without `cwd`. */
    const said = changedMessage("", " M package.json\n");
    expect(said).toMatch(/without `cwd`/u);
    expect(said).toMatch(/bump-version/u);
  });

  it("still complains when the suite REMOVED a change", () => {
    /**
     * The direction that looks like success. A test that reverted somebody's
     * work in progress leaves a tidier tree than it found, and that is worse
     * than a dirtier one — it is somebody's afternoon.
     */
    expect(changedMessage(" M a.txt\n", "")).not.toBeNull();
  });
});

describe("what it reads", () => {
  it("reads a real repository as a real state", () => {
    /* The vacuity control. If `treeState` returned the same string for every
       tree, every case above would pass and the watcher would report quiet for
       ever. Asked of a scratch repository so the answer is known exactly. */
    const dir = mkdtempSync(join(tmpdir(), "treestate-"));
    made.push(dir);
    const git = (...args) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "a@example.invalid");
    git("config", "user.name", "a");
    writeFileSync(join(dir, "a.txt"), "one\n");
    git("add", "-A");
    git(
      "-c",
      "user.email=a@b.c",
      "-c",
      "user.name=a",
      "commit",
      "--quiet",
      "-m",
      "one",
    );

    expect(treeState(dir)).toBe("");
    writeFileSync(join(dir, "a.txt"), "two\n");
    expect(treeState(dir)).toContain("a.txt");
  });

  it("does not count ignored files, or every build output is a breach", () => {
    /* `git status --porcelain` excludes ignored paths by its own rule, which
       is what keeps `node_modules`, build output and `.verified` from tripping
       this. Asserted because it is load-bearing rather than incidental. */
    const dir = mkdtempSync(join(tmpdir(), "treeignore-"));
    made.push(dir);
    const git = (...args) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git("init", "--quiet");
    writeFileSync(join(dir, ".gitignore"), "built/\n");
    git("add", "-A");
    git(
      "-c",
      "user.email=a@b.c",
      "-c",
      "user.name=a",
      "commit",
      "--quiet",
      "-m",
      "one",
    );
    execFileSync("mkdir", ["-p", join(dir, "built")]);
    writeFileSync(join(dir, "built", "out.js"), "x\n");
    expect(treeState(dir)).toBe("");
  });

  it("does not accuse when it cannot read at all", () => {
    /* A directory that is not a repository. Not a change, and not something to
       fail a suite over. */
    const dir = mkdtempSync(join(tmpdir(), "treenone-"));
    made.push(dir);
    expect(treeState(dir)).toBe("unreadable");
  });
});

describe("how it is wired", () => {
  it("is a globalSetup, or it is a module nobody runs", () => {
    /* Without the wiring every case above passes and the watcher never runs —
       which is the failure it was written for, one level up. */
    const config = readFileSync(
      fileURLToPath(new URL("../vitest.config.ts", import.meta.url)),
      "utf8",
    );
    expect(config).toContain(
      'globalSetup: ["scripts/the-suite-leaves-the-tree-as-it-found-it.mjs"]',
    );
  });

  it("fails the run rather than only printing", () => {
    /**
     * `byollm-cloud`'s twin threw from the teardown first. Vitest caught it,
     * printed the entire complaint and **exited 0** — driven there, `exit=0`
     * before and `exit=1` after. Pinned by source here because the fix is a
     * process exit, and exercising it from inside this suite would end it.
     */
    const watcher = readFileSync(
      fileURLToPath(
        new URL(
          "./the-suite-leaves-the-tree-as-it-found-it.mjs",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(watcher).toContain("process.exit(1)");
    expect(
      /throw new Error\(message\)/u.test(watcher),
      "the teardown throws again, and vitest swallows a throw into a green run",
    ).toBe(false);
  });
});
