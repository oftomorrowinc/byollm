import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The secret scan can fail — B224.
 *
 * It is green on this repository and runs in `verify`, which is the dangerous
 * kind of check: a gate whose failing path has never executed reports green
 * about nothing. The sweep it replaces (`c6634db`) was an action; this is the
 * gate, and a gate has to be watched going red.
 *
 * ## Every fixture is built at runtime, and that is not stylistic
 *
 * The scanner reads the tracked tree, and this file is tracked. A literal
 * `ghp_` token or a PEM header written here would be found by the real run in
 * `verify` — **the check would flag its own tests and be deleted the same
 * day.** So every credential shape below is assembled from pieces, and the
 * proof that it worked is that `pnpm verify` passes with this file committed.
 *
 * There is a case for the same property one level in: the scanner must not
 * flag its own source either, since its patterns necessarily contain the
 * prefixes they match.
 */

const SCRIPT = fileURLToPath(
  new URL("./no-secrets-in-the-tree.mjs", import.meta.url),
);

/* Assembled, never written whole. See the docstring. */
const GITHUB_TOKEN = ["ghp", "_", "A".repeat(32)].join("");
const PEM_HEADER = [
  "-----",
  ["BEGIN", "RSA", "PRIVATE", "KEY"].join(" "),
  "-----",
].join("");
const JWT = [
  "eyJ",
  "a".repeat(20),
  ".",
  "b".repeat(20),
  ".",
  "c".repeat(20),
].join("");
const AWS_KEY = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");

/** A git repository with whatever files a case needs. */
const repo = (files) => {
  const root = mkdtempSync(join(tmpdir(), "secret-scan-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  /* Twelve filler files, because the scanner refuses a tree it can barely
     read and a case about a planted secret must not trip that instead. */
  const all = { ...files };
  for (let i = 0; i < 12; i += 1) all[`filler-${String(i)}.txt`] = "ordinary\n";
  for (const [path, contents] of Object.entries(all)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
};

const run = (root) => {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [SCRIPT], {
        encoding: "utf8",
        env: { ...process.env, SECRET_SCAN_ROOT: root },
        timeout: 60_000,
      }),
    };
  } catch (error) {
    return {
      code: error.status ?? -1,
      out: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
};

describe("a credential in a tracked file", () => {
  it("is found, named, and located", () => {
    const { code, out } = run(
      repo({ "src/config.ts": `const token = "${GITHUB_TOKEN}";\n` }),
    );
    expect(code).toBe(1);
    expect(out).toContain("src/config.ts:1");
    expect(out).toContain("GitHub personal access token");
  });

  it("is found on the line it is on, not the first line", () => {
    /* A report that always said line 1 would be useless on a long file, and
       nothing above would have noticed. */
    const { out } = run(
      repo({
        "deep.ts": `${"// filler\n".repeat(40)}const k = "${GITHUB_TOKEN}";\n`,
      }),
    );
    expect(out).toContain("deep.ts:41");
  });

  it("finds a private key header", () => {
    const { code, out } = run(repo({ "key.pem": `${PEM_HEADER}\n` }));
    expect(code).toBe(1);
    expect(out).toContain("private key");
  });

  it("finds a signed JWT, which is the shape a Supabase service key has", () => {
    const { code, out } = run(repo({ ".env.example": `KEY=${JWT}\n` }));
    expect(code).toBe(1);
    expect(out).toContain("JWT");
  });

  it("finds an AWS access key id", () => {
    expect(run(repo({ "notes.md": `${AWS_KEY}\n` })).code).toBe(1);
  });

  it("reports every hit rather than stopping at the first", () => {
    /* Somebody pasting a block of environment variables pastes several. A
       report naming one sends them to fix one. */
    const { out } = run(
      repo({
        "a.ts": `"${GITHUB_TOKEN}"\n`,
        "b.ts": `"${JWT}"\n`,
      }),
    );
    expect(out).toContain("a.ts");
    expect(out).toContain("b.ts");
  });
});

describe("what it correctly lets through", () => {
  it("passes an ordinary tree", () => {
    const { code, out } = run(
      repo({ "src/index.ts": "export const x = 1;\n" }),
    );
    expect(code).toBe(0);
    expect(out).toContain("no credential shapes");
  });

  it("does not flag a prefix without the run of characters after it", () => {
    /**
     * The false-alarm direction, and the one that gets a scanner deleted.
     * Prose about these tokens is ordinary in a repository that documents its
     * own release process, and `ghp_` in a sentence is not a credential.
     */
    const { code } = run(
      repo({
        "docs.md": "Set a token like ghp_ or npm_ in the environment.\n",
      }),
    );
    expect(code).toBe(0);
  });

  it("does not flag its own source", () => {
    /**
     * The patterns necessarily contain the prefixes they match. A scanner
     * that reported itself would be switched off on its first run, and the
     * real `verify` run proves it against the whole tree — this proves the
     * property directly, so a future pattern written carelessly fails here
     * rather than in somebody's push.
     */
    const source = readFileSync(SCRIPT, "utf8");
    const { code } = run(repo({ "scanner-copy.mjs": source }));
    expect(code).toBe(0);
  });
});

describe("the refusal to pass nothing", () => {
  it("refuses a tree it can barely read", () => {
    /* Zero of zero files are clean is a perfect green about a checkout that
       is not one. Exit 2 is "I could not ask". */
    const root = mkdtempSync(join(tmpdir(), "secret-scan-empty-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "only.txt"), "one\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: root });
    const { code, out } = run(root);
    expect(code).toBe(2);
    expect(out).toContain("layout moved");
  });
});
