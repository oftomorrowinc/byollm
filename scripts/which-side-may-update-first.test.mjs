import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import * as protocol from "@byollm/protocol";

/**
 * Which side of a release may update before the hub is rolled — B323.
 *
 * **This script exists because I answered the same question by hand and the
 * answer was unfounded.** I told Todd his Macs could take `byollm@alpha`
 * before the roll, on the strength of a `sed` range over `job.ts` — and every
 * request schema lives in `wire.ts`. The range matched nothing on both sides,
 * and `diff` reported two empty strings as identical.
 *
 * The conclusion happened to be right. The derivation was a fail-open: the
 * exact shape this project keeps finding in other people's checks, in my own
 * hand-work, minutes after writing a row about it.
 *
 * So the cases below spend most of their effort on the one property that
 * matters — **that it can say no** — and on the third state that caught the
 * first version.
 */

const SCRIPT = fileURLToPath(
  new URL("./which-side-may-update-first.mjs", import.meta.url),
);

let dir;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A repository with one tagged commit and a working tree on top of it. */
function scratch(before, after) {
  dir = mkdtempSync(join(tmpdir(), "which-side-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  const src = join(dir, "packages", "protocol", "src");
  mkdirSync(src, { recursive: true });
  git("init", "-q");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "T");
  writeFileSync(join(src, "wire.ts"), before);
  git("add", "-A");
  git("commit", "-qm", "before");
  git("tag", "vPREV");
  writeFileSync(join(src, "wire.ts"), after);
  return dir;
}

function run(cwd, ref = "vPREV") {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [SCRIPT, ref], {
        cwd,
        encoding: "utf8",
      }),
    };
  } catch (error) {
    return {
      code: error.status ?? 1,
      out: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

const SHAPES = [
  "HeartbeatRequest",
  "ClaimRequest",
  "ResultRequest",
  "PairStartRequest",
  "PairPollRequest",
  "ReleaseRequest",
  "FetchRequest",
];

/** A file declaring every shape the script asks about. */
const wire = (extra = "") =>
  SHAPES.map(
    (n) =>
      `export const ${n} = z.object({ a: z.string()${
        n === "ClaimRequest" ? extra : ""
      } }).strict();`,
  ).join("\n");

describe("the shapes it asks about", () => {
  it("are all real exports, so a rename cannot shrink the question", () => {
    /**
     * The list is written out rather than discovered — narrowly on purpose,
     * because the answer is about ONE direction and a discovered set would
     * drag in shapes that do not cross it, which is the over-claim B322 fixed.
     *
     * The cost of a hand list is that it goes quietly stale. This is the
     * payment: every name must still be an exported schema.
     */
    const script = execFileSync("cat", [SCRIPT], { encoding: "utf8" });
    const listed = [...script.matchAll(/^ {2}"([A-Z][A-Za-z]*)",$/gmu)].map(
      (m) => m[1],
    );
    expect(listed.length).toBeGreaterThanOrEqual(6);
    for (const name of listed) {
      expect(
        typeof protocol[name]?.safeParse,
        `${name} is in the list and is not an exported schema`,
      ).toBe("function");
    }
  });
});

describe("what it answers", () => {
  it("says daemons may update when nothing on their side moved", () => {
    const repo = scratch(wire(), wire() + "\n// a comment, not a key\n");
    const seen = run(repo);
    expect(seen.code, seen.out).toBe(0);
    expect(seen.out).toContain("may update BEFORE the hub is rolled");
  });

  it("says ROLL FIRST when a daemon-to-hub shape gains a key", () => {
    /* The property that makes the other answer worth anything. Without this
       the script is a machine that prints "safe". */
    const repo = scratch(wire(), wire(", b: z.string().optional()"));
    const seen = run(repo);
    expect(seen.code, seen.out).toBe(1);
    expect(seen.out).toContain("ROLL THE HUB FIRST");
    expect(seen.out).toContain("ClaimRequest");
  });

  it("is UNPROVEN when a shape cannot be read on one side", () => {
    /**
     * The branch that caught my hand-work. A shape missing from one side is
     * not a shape that did not change, and answering "safe" there is the
     * false all-clear — which is precisely what my `sed` over the wrong file
     * produced.
     */
    const repo = scratch(wire(), "export const Nothing = 1;\n");
    const seen = run(repo);
    expect(seen.code, seen.out).toBe(1);
    expect(seen.out).toContain("UNPROVEN");
    expect(seen.out).not.toContain("may update BEFORE");
  });

  it("is UNPROVEN for a ref that does not exist, rather than clean", () => {
    const repo = scratch(wire(), wire());
    const seen = run(repo, "vNOPE");
    expect(seen.code, seen.out).toBe(1);
    expect(seen.out).toContain("UNPROVEN");
  });
});
