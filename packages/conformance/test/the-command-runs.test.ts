import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The published command, executed — B243.
 *
 * ## The seam nothing was watching
 *
 * `certify()` is tested thoroughly and directly, which is the right way to
 * test an engine. **Nothing in this workspace ever ran `dist/cli.js`.** So the
 * argv path — the only path a stranger uses — was proven by nobody, and it did
 * not work: `await import(targetPath)` resolved the person's relative path
 * against `dist/cli.js` rather than their own directory, and the kit looked
 * for their server adapter inside our package.
 *
 * They installed our kit, typed the line off our npm page, and got
 * `ERR_MODULE_NOT_FOUND` naming a path inside `@byollm/conformance`. Nothing
 * in that error says the instruction was ours.
 *
 * It is the third time in a week: a restricted shell tested and never spawned,
 * an actions layer rendered and never executed, and now a CLI whose engine is
 * tested and whose entry point never runs. **The optional dependency is the
 * production caller itself.**
 *
 * ## Why these cases spawn rather than import
 *
 * Because importing `certify()` cannot see any of it. Every assertion here is
 * about what happens between a person's shell and our engine: argument
 * parsing, path resolution, exit codes and what lands on stderr. A test that
 * imported the module would have been green through all of it — and was.
 *
 * Run from a temp directory **outside the package**, because the defect was
 * invisible from inside: relative resolution against `dist/` happens to find
 * things when you are already standing in `dist/`'s neighbourhood.
 */
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

interface Ran {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** The command, as a shell runs it, from somewhere that is not us. */
function run(args: readonly string[], cwd: string): Ran {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out, err: "" };
  } catch (error) {
    const failure = error as {
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: failure.status ?? -1,
      out: failure.stdout ?? "",
      err: failure.stderr ?? "",
    };
  }
}

/** A directory that is not the package, with a target module sitting in it. */
function somewhereElse(): string {
  const dir = mkdtempSync(join(tmpdir(), "certify-"));
  writeFileSync(
    join(dir, "my-target.js"),
    /* Enough of a target to prove the path loaded: it is asked for, it throws
       where `certify` starts, and that failure is a DIFFERENT one from not
       being found. */
    "export default () => ({ name: 'stub' });\n",
    "utf8",
  );
  return dir;
}

describe("byollm-certify, as somebody actually types it", () => {
  it("loads a relative path from the directory the person is in", () => {
    /**
     * The defect, and the only assertion that could have caught it. A relative
     * path is the form every one of our documents publishes.
     *
     * It is asserted as an ABSENCE of the module-not-found failure rather than
     * a success, because a stub target cannot pass certification — what
     * matters is that the kit got past loading and started judging.
     */
    const dir = somewhereElse();
    const ran = run(["./my-target.js"], dir);

    expect(
      ran.err,
      "the kit could not find a file that is right there",
    ).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(ran.err).not.toContain("could not load");
    /* And never a path inside our own package, which is the misattribution. */
    expect(ran.err).not.toContain("node_modules/@byollm/conformance");
  });

  it("loads an absolute path too", () => {
    const dir = somewhereElse();
    const ran = run([join(dir, "my-target.js")], dir);
    expect(ran.err).not.toContain("ERR_MODULE_NOT_FOUND");
  });

  it("answers --help with the usage it already had, and exits 0", () => {
    /* It used to hand `--help` to `import()` as a filename and print a Node
       stack trace. The usage text existed and was wired to one case of three. */
    for (const flag of ["--help", "-h"]) {
      const ran = run([flag], somewhereElse());
      expect(ran.code, flag).toBe(0);
      expect(ran.out, flag).toContain("usage: byollm-certify");
      expect(ran.err, flag).toBe("");
    }
  });

  it("still exits 2 with no arguments", () => {
    const ran = run([], somewhereElse());
    expect(ran.code).toBe(2);
    expect(ran.err).toContain("usage: byollm-certify");
  });

  it("says when a module loaded but is not a target, in our words", () => {
    /**
     * The next misattribution along, fixed in the same pass. Before this, a
     * module that loaded with the wrong shape reached `certify`, which called
     * `target.reset()` and threw a `TypeError` with a stack trace through our
     * own `dist` — the same "this package is broken" reading the path defect
     * produced, one step later.
     */
    const dir = somewhereElse();
    const ran = run(["./my-target.js"], dir);

    expect(ran.code).toBe(2);
    expect(ran.err).toContain("is not a ConformanceTarget");
    expect(ran.err, "it does not say what arrived").toContain("exported:");
    expect(ran.err, "a stack into our dist reads as our bug").not.toContain(
      "    at ",
    );
  });

  it("explains a path it cannot load, in our words and without a stack", () => {
    /**
     * The trace is the part that misattributes: a reader who sees Node unwind
     * through `@byollm/conformance/dist` concludes our package is broken. What
     * they need is the path they typed, where we looked, and nothing about our
     * internals.
     */
    const ran = run(["./not-here.js"], somewhereElse());

    expect(ran.code).toBe(2);
    expect(ran.err).toContain("could not load ./not-here.js");
    expect(ran.err).toContain("looked for:");
    expect(ran.err, "a Node stack trace reads as our bug").not.toContain(
      "    at ",
    );
    expect(ran.err).not.toContain("node:internal");

    /**
     * **And not one mention of where we live.**
     *
     * Node's `ERR_MODULE_NOT_FOUND` ends *"imported from <our dist/cli.js>"*,
     * and that was the last line a reader saw. The importer is always us —
     * we are the one calling `import()` — so it tells them nothing and undoes
     * the framing above it: an error ending inside `@byollm/conformance` reads
     * as our package being broken however carefully the lines above are worded.
     *
     * Asserted against the CLI's own directory rather than a fixed string, so
     * any future leak of our internals reddens, not just this one.
     */
    const ourDirectory = dirname(CLI);
    expect(
      ran.err,
      "the error names a path inside our own package",
    ).not.toContain(ourDirectory);
    expect(ran.err).not.toContain("imported from");
  });
});

describe("byollm-audit-deployment, the other published bin", () => {
  const AUDIT = fileURLToPath(new URL("../dist/audit-cli.js", import.meta.url));

  it("runs and asks for what it needs", () => {
    /**
     * CW's condition 5, and the reason for it is the row itself: this bin takes
     * a URL and does no dynamic import, so it *should* be clean — and expecting
     * is exactly what produced B243.
     */
    let code = 0;
    let err = "";
    try {
      execFileSync(process.execPath, [AUDIT], {
        cwd: somewhereElse(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      code = failure.status ?? -1;
      err = failure.stderr ?? "";
    }
    expect(code, "it did not start at all").not.toBe(-1);
    expect(err).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(err).not.toContain("node:internal");
  });
});
