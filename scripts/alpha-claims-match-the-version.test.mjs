import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The docs stop saying "alpha" when the version stops being one — B222.
 *
 * `bump-version.mjs` rewrites the version INSIDE the alpha banner and never
 * removes the banner, so the flip commit would have published
 * *"Alpha (`0.1.0`) — under active development. Don't use this yet."* on eight
 * READMEs and the site, in the change that makes the repository public.
 *
 * And the banner is the smaller half: the docs carry live instructions pinned
 * to the `alpha` dist-tag, which the flip does not move. `npm install
 * @byollm/protocol@alpha` and `npx --package @byollm/server@alpha keygen` would
 * keep resolving to the last prerelease, so a reader following our own
 * quickstart installs an **older** package than the one just locked — and it
 * looks like their mistake.
 *
 * Every case drives the real script by exit code, the shape `pins-agree` takes
 * and for the same reason: a gate that has never been shown failing is a gate
 * nobody has tested.
 */

const SCRIPT = fileURLToPath(
  new URL("./alpha-claims-match-the-version.mjs", import.meta.url),
);
const REPO = fileURLToPath(new URL("..", import.meta.url));

/**
 * The script, by exit code.
 *
 * `execFileSync` with a fixed argv rather than `spawnSync`: byollm_004 §2 bans
 * the shell-invoking APIs and eslint enforces it, which caught the first draft
 * of this file. It throws on a non-zero exit, so the failure carries the
 * status and the streams and the catch is where the interesting cases land.
 */
const run = (root) => {
  const options = {
    encoding: "utf8",
    env: { ...process.env, ALPHA_CLAIMS_ROOT: root },
  };
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT], options) };
  } catch (error) {
    return {
      code: error.status ?? -1,
      out: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
};

/** A tree with one protocol version and whatever documents a case needs. */
const tree = (version, files) => {
  const root = mkdtempSync(join(tmpdir(), "alpha-claims-"));
  mkdirSync(join(root, "packages", "protocol"), { recursive: true });
  writeFileSync(
    join(root, "packages", "protocol", "package.json"),
    JSON.stringify({ name: "@byollm/protocol", version }),
  );
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, "utf8");
  }
  return root;
};

const BANNER =
  "> **Alpha (`0.1.0-alpha.102`) — under active development. Don't use this yet.**\n";

describe("at a clean version", () => {
  it("refuses the banner the bumper would have left behind", () => {
    /* The exact string `bump-version.mjs 0.1.0` produces: the version inside
       the banner is rewritten and the word around it is not. */
    const root = tree("0.1.0", {
      "README.md":
        "# byollm\n\n> **Alpha (`0.1.0`) — under active development. Don't use this yet.**\n",
    });
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain("README.md:3");
    expect(out).toContain("B222");
  });

  it("refuses an install instruction pinned to the alpha tag", () => {
    /* The half that is worse than a stale adjective. `latest` moves at the
       flip and `alpha` does not, so this line installs the PREVIOUS release. */
    const root = tree("0.1.0", {
      "README.md": "# byollm\n\nRun `npm install @byollm/protocol@alpha`.\n",
    });
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain("README.md:3");
  });

  it("refuses the same claim in a package README or on the site", () => {
    /* Nine documents, and the walk has to reach all of them. A check that
       only read the root README would have passed the flip with seven
       banners still standing. */
    const root = tree("0.1.0", {
      "packages/server/README.md": "# server\n\n`@byollm/server@alpha`\n",
      "site/index.html": '<meta content="Alpha software, under development">\n',
    });
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain("packages/server/README.md");
    expect(out).toContain("site/index.html");
  });

  it("leaves release-note history alone", () => {
    /**
     * `alpha.58` was an alpha permanently, and a README that stopped saying so
     * would be rewriting history to make a check pass. `bump-version.mjs`
     * draws this line first — *"README bodies are history too"* — and this
     * reader draws it the same way, so the two cannot disagree about which
     * lines are live.
     */
    const root = tree("0.1.0", {
      "README.md":
        "# byollm\n\n> **`alpha.58` broke everything.** Generate with\n" +
        "> `npx --package @byollm/server@alpha keygen`, then set the env var.\n",
    });
    const { code, out } = run(root);
    expect(code).toBe(0);
    expect(out).toContain("no document claims otherwise");
  });

  it("is what the real repository would fail on today", () => {
    /**
     * The case that makes this more than fixtures: the actual tree, with one
     * value changed to what the cut will set. Fourteen lines across nine
     * documents, and they are the lines a reader follows.
     */
    const root = mkdtempSync(join(tmpdir(), "alpha-claims-real-"));
    for (const path of ["README.md", "site", "packages"])
      cpSync(join(REPO, path), join(root, path), {
        recursive: true,
        filter: (src) =>
          !src.includes("node_modules") && !src.includes("/dist"),
      });
    writeFileSync(
      join(root, "packages", "protocol", "package.json"),
      JSON.stringify({ name: "@byollm/protocol", version: "0.1.0" }),
    );
    const { code, out } = run(root);
    expect(code).toBe(1);
    /* Named, not counted: these are the instructions, and a count would be
       satisfied by any fourteen lines. */
    expect(out).toContain("README.md");
    expect(out).toMatch(/@alpha/u);
  });
});

describe("at a prerelease", () => {
  it("passes the real repository as it stands", () => {
    const { code, out } = run(REPO);
    expect(code).toBe(0);
    expect(out).toContain("is a prerelease");
  });

  it("refuses a prerelease whose documents have stopped warning", () => {
    /* The other direction, and the reason this is a biconditional. A check
       that only fired after the flip would never have been run before it —
       and a repository shipping alphas with no warning is the same defect
       wearing the other face. */
    const root = tree("0.1.0-alpha.103", {
      "README.md": "# byollm\n\nA perfectly calm README.\n",
    });
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain("NO document says so");
  });
});

describe("invoked through a symlinked path", () => {
  it("still runs, instead of exiting 0 having read nothing", () => {
    /**
     * The fail-open `rehearse-the-cut.mjs` found on its first run.
     *
     * `import.meta.url` RESOLVES symlinks; `process.argv[1]` does not. On
     * macOS `/var` is a symlink to `/private/var`, so this script invoked from
     * anywhere under `/tmp` compared two spellings of the same file, concluded
     * it was being imported, ran nothing and **exited 0** — a gate reporting
     * success having checked nothing, which is the shape every refusal in it
     * is written against.
     *
     * The case builds the same trap deliberately: a symlink to the scripts
     * directory, and the script invoked through it. Exit 0 alone would pass
     * this; the output is what proves it ran.
     */
    const dir = mkdtempSync(join(tmpdir(), "alpha-claims-link-"));
    const link = join(dir, "scripts");
    symlinkSync(dirname(SCRIPT), link, "dir");
    const viaLink = join(link, "alpha-claims-match-the-version.mjs");

    const root = tree("0.1.0", {
      "README.md": "# byollm\n\nRun `npm install @byollm/protocol@alpha`.\n",
    });
    let out;
    let code = 0;
    try {
      out = execFileSync(process.execPath, [viaLink], {
        encoding: "utf8",
        env: { ...process.env, ALPHA_CLAIMS_ROOT: root },
      });
    } catch (error) {
      code = error.status ?? -1;
      out = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    expect(code, "the gate ran nothing and called it success").toBe(1);
    expect(out).toContain("still say alpha");
  });
});

describe("the reader refuses rather than passing nothing", () => {
  it("refuses a tree with no protocol manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "alpha-claims-empty-"));
    const { code, out } = run(root);
    expect(code).toBe(2);
    expect(out).toContain("packages/protocol/package.json");
  });

  it("refuses a tree with no documents at all", () => {
    /* Zero documents satisfies "no document claims alpha" perfectly, which is
       the fail-open this repository has shipped before. */
    const root = tree("0.1.0", {});
    const { code, out } = run(root);
    expect(code).toBe(2);
    expect(out).toContain("found no documents");
  });
});

describe("the live-versus-history rule, on text the repository does not contain", () => {
  /* The rules above are only ever exercised by documents that satisfy them.
     These are shapes nobody has written, driven through the real script. */

  it("counts the banner even though it is a blockquote", () => {
    const root = tree("0.1.0", { "README.md": BANNER });
    expect(run(root).code).toBe(1);
  });

  it("does not count a quoted install line", () => {
    const root = tree("0.1.0", {
      "README.md": "> install `@byollm/server@alpha` back then\n",
    });
    expect(run(root).code).toBe(0);
  });

  it("counts an unquoted one, and reports its line", () => {
    const root = tree("0.1.0", {
      "README.md": "one\ntwo\n`npm i @byollm/server@alpha`\n",
    });
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain("README.md:3");
  });

  it("does not count a version string that merely contains the word", () => {
    /* `0.1.0-alpha.102` appears on every release-note heading and in every
       lockfile and is not an instruction. `@alpha` is the dist-tag;
       `alpha.102` is a version. Matching the word alone would make this
       reader useless on the day it matters. */
    const root = tree("0.1.0", {
      "README.md": "Released 0.1.0-alpha.102 on a Tuesday.\n",
    });
    expect(run(root).code).toBe(0);
  });
});
