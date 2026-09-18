import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The licence check can fail — B224.
 *
 * It runs in `verify` and it is green on this repository today, which is the
 * dangerous kind of check: nobody has watched it go red, and a gate whose
 * failing path has never executed is a gate reporting green about nothing.
 *
 * ## Why the cases stage a fake workspace
 *
 * The real one is correct, and making it incorrect to watch the check notice
 * would mean editing seven manifests in a repository four days from a cut.
 * So the failures are staged: a workspace with its own root, its own
 * `packages/`, and a `pnpm pack` that answers from a fixture.
 *
 * The stub is deliberately dumb — it writes a tarball with exactly the files a
 * case asks for. A double that reproduced pnpm's LICENSE-copying would be
 * asserting that my model of pnpm is my model of pnpm, and the whole reason
 * this check exists is that my model of pnpm was wrong in the obvious
 * direction. What pnpm really does is pinned by the real run in `verify`.
 */

const SCRIPT = fileURLToPath(
  new URL("./every-package-ships-its-license.mjs", import.meta.url),
);

const MIT = "MIT License\n\nCopyright (c) 2026 Somebody\n";

/**
 * A workspace whose `pnpm` is a stub.
 *
 * `packages` maps a package name to the files its tarball will contain, so a
 * case says "this one ships no LICENSE" by leaving it out.
 */
const workspace = (packages, options = {}) => {
  const root = mkdtempSync(join(tmpdir(), "ships-license-case-"));
  if (options.license !== null)
    writeFileSync(join(root, "LICENSE"), options.license ?? MIT);
  mkdirSync(join(root, "packages"));
  const fixtures = join(root, ".fixtures");
  mkdirSync(fixtures);

  for (const [name, files] of Object.entries(packages)) {
    const dir = join(root, "packages", name.replace(/^@[^/]+\//u, ""));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name, version: "1.0.0", license: "MIT" }),
    );
    /* Build the tarball the stub will hand back for this package. */
    const staged = join(fixtures, name.replace(/[@/]/gu, "_"));
    mkdirSync(join(staged, "package"), { recursive: true });
    for (const [path, body] of Object.entries(files))
      writeFileSync(join(staged, "package", path), body);
    execFileSync("tar", ["czf", `${staged}.tgz`, "-C", staged, "package"]);
    rmSync(staged, { recursive: true, force: true });
  }

  /* A `pnpm` that copies the right fixture into --pack-destination. */
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "pnpm"),
    `#!/usr/bin/env bash\n` +
      `name=""; dest=""\n` +
      `while [ $# -gt 0 ]; do\n` +
      `  case "$1" in --filter) name="$2"; shift 2;; --pack-destination) dest="$2"; shift 2;; *) shift;; esac\n` +
      `done\n` +
      `key=$(printf '%s' "$name" | tr '@/' '__')\n` +
      `cp ${JSON.stringify(fixtures)}/"$key".tgz "$dest"/"$key".tgz\n`,
    "utf8",
  );
  chmodSync(join(bin, "pnpm"), 0o755);
  return { root, bin };
};

const run = ({ root, bin }) => {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [SCRIPT], {
        encoding: "utf8",
        env: {
          ...process.env,
          LICENSE_CHECK_ROOT: root,
          PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        },
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

const three = (extra = {}) => ({
  "@x/one": { LICENSE: MIT, "README.md": "one" },
  "@x/two": { LICENSE: MIT, "README.md": "two" },
  "@x/three": { LICENSE: MIT, "README.md": "three" },
  ...extra,
});

describe("a package that would publish a claim with no grant", () => {
  it("is named, and the check fails", () => {
    const { code, out } = run(
      workspace(three({ "@x/four": { "README.md": "no licence here" } })),
    );
    expect(code).toBe(1);
    expect(out).toContain("NO LICENSE");
    expect(out).toContain("@x/four");
  });

  it("is caught even when every other package is fine", () => {
    /* The direction that matters: one silent package among six correct ones
       is exactly how this would really happen. */
    const { out } = run(workspace(three({ "@x/four": { "README.md": "x" } })));
    expect(out).toContain("ships MIT   @x/one");
    expect(out).toContain("NO LICENSE  @x/four");
  });
});

describe("a package that ships a DIFFERENT licence", () => {
  it("is refused, because presence is not agreement", () => {
    /**
     * The half a "does the file exist" check cannot make. A package that grew
     * its own LICENSE — a fork's, an older year's, a different grant — passes
     * presence perfectly while publishing terms the other six do not.
     */
    const { code, out } = run(
      workspace(
        three({
          "@x/four": { LICENSE: "Apache License 2.0\n", "README.md": "x" },
        }),
      ),
    );
    expect(code).toBe(1);
    expect(out).toContain("DIFFERENT");
    expect(out).toContain("@x/four");
  });
});

describe("the refusals to pass nothing", () => {
  it("refuses a workspace with no root LICENSE", () => {
    const { code, out } = run(workspace(three(), { license: null }));
    expect(code).toBe(1);
    expect(out).toContain("no LICENSE at the repository root");
  });

  it("refuses when it can barely find any packages", () => {
    /* Zero of zero packages are wrong is a perfect green about a workspace
       whose layout moved. Exit 2 is "I could not ask". */
    const { code, out } = run(workspace({ "@x/one": { LICENSE: MIT } }));
    expect(code).toBe(2);
    expect(out).toContain("layout moved");
  });
});

describe("what it correctly lets through", () => {
  it("passes when every package carries the root licence", () => {
    const { code, out } = run(workspace(three()));
    expect(code).toBe(0);
    expect(out).toContain("All 3 publishable packages");
  });

  it("accepts the other spellings npm treats as a licence", () => {
    /**
     * A mutation found this untested. Narrowing the pattern to `LICENSE`
     * exactly passed every case above, because every fixture happened to spell
     * it that way — generality that is asserted in a regex and exercised by
     * nothing.
     *
     * It is worth keeping rather than narrowing: npm treats `LICENCE` and a
     * `.md` suffix as the same file, so a package spelling it either way would
     * be reported as shipping NO grant while shipping one. That is the
     * false-alarm direction, and an alarm nobody believes is removed.
     */
    const { code, out } = run(
      workspace({
        "@x/one": { "LICENCE.md": MIT, "README.md": "one" },
        "@x/two": { LICENSE: MIT, "README.md": "two" },
        "@x/three": { "LICENSE.md": MIT, "README.md": "three" },
      }),
    );
    expect(code).toBe(0);
    expect(out).not.toContain("NO LICENSE");
  });

  it("does not ask a private package to ship anything", () => {
    /* `private: true` never reaches a registry, so requiring a grant in its
       tarball would be a rule about a file nobody receives. */
    const w = workspace(three());
    const dir = join(w.root, "packages", "secret");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "@x/secret", version: "1.0.0", private: true }),
    );
    const { code, out } = run(w);
    expect(code).toBe(0);
    expect(out).not.toContain("@x/secret");
  });
});
