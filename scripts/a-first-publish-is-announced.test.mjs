import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The first-publish announcement, against a fixture registry.
 *
 * The live registry is exercised by the script doing its actual job before a
 * cut. What the suite proves is the reasoning — above all the **third state**,
 * which is the half that cannot be checked by running it: an unreachable
 * registry must not be reported as "never published", because that would
 * announce seven first publishes on a train and teach the reader to ignore
 * this file forever after.
 */

const SCRIPT = fileURLToPath(
  new URL("./a-first-publish-is-announced.mjs", import.meta.url),
);

/** A workspace of packages, and a registry that answers for them. */
const stage = (packages, registry) => {
  const root = mkdtempSync(join(tmpdir(), "first-publish-"));
  mkdirSync(join(root, "packages"));
  for (const [name, manifest] of Object.entries(packages)) {
    const dir = join(root, "packages", name.replace(/^@[^/]+\//u, ""));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name, version: "1.0.0", ...manifest }),
    );
  }
  const fixture = join(root, "registry.json");
  writeFileSync(fixture, JSON.stringify(registry));
  return { root, fixture };
};

const run = ({ root, fixture }) => {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [SCRIPT], {
        encoding: "utf8",
        env: {
          ...process.env,
          FIRST_PUBLISH_ROOT: root,
          FIRST_PUBLISH_FIXTURE: fixture,
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

/**
 * These cases shadow a real binary by writing a shell script onto `PATH`, and
 * that is a Unix-shaped trick.
 *
 * On Windows an extensionless shell script is not executable, and the obvious
 * fix — a `.cmd` launcher — cannot be spawned by `execFileSync` without
 * `shell: true`, which `byollm_004 §2` bans outright and which this script
 * therefore does not use.
 *
 * So the HARNESS is platform-bound, not the property. It runs on Linux and
 * macOS, which is two of the three platforms CI runs, and the alternative was
 * a shim fighting Node's own restriction in the file whose subject is a
 * release. Named rather than silently skipped: a suite that quietly asserts
 * less on one platform is how `byollm_010 §2` gets broken.
 */
const shadowable = process.platform !== "win32";

const four = { "@x/a": {}, "@x/b": {}, "@x/c": {}, "@x/d": {} };
const allPublished = {
  "@x/a": { versions: ["1.0.0"] },
  "@x/b": { versions: ["1.0.0"] },
  "@x/c": { versions: ["1.0.0"] },
  "@x/d": { versions: ["1.0.0"] },
};

describe("a name the registry has never served", () => {
  it("is announced, and the exit says there is something to read", () => {
    const { code, out } = run(
      stage(four, { ...allPublished, "@x/d": { versions: [] } }),
    );
    expect(code).toBe(1);
    expect(out).toContain("FIRST time");
    expect(out).toContain("@x/d");
  });

  it("is announced even when every sibling is long published", () => {
    /* The real shape: one new package among six that have shipped a hundred
       times. A check that only noticed a wholly-new workspace would miss it. */
    const { out } = run(
      stage(four, {
        ...allPublished,
        "@x/a": {
          versions: Array.from(
            { length: 102 },
            (_, i) => `0.1.0-alpha.${String(i)}`,
          ),
        },
        "@x/d": { versions: [] },
      }),
    );
    expect(out).toContain("@x/d");
    expect(out).not.toContain("@x/a\n");
  });

  it("names the remedy, which is the manifest and not this script", () => {
    const { out } = run(
      stage(four, { ...allPublished, "@x/d": { versions: [] } }),
    );
    expect(out).toMatch(/private.*true/u);
  });
});

describe("what it correctly says nothing about", () => {
  it("is quiet when every package already exists", () => {
    const { code, out } = run(stage(four, allPublished));
    expect(code).toBe(0);
    expect(out).toContain("publishes no new name");
  });

  it("ignores a private package, because the release does", () => {
    /**
     * The workflow's rule is `private !== true` ships. A private package that
     * has never published is not a pending first publish — it is a package
     * that does not ship, and announcing it would be the false alarm that
     * gets this deleted.
     */
    const { code, out } = run(
      stage(
        { ...four, "@x/secret": { private: true } },
        { ...allPublished, "@x/secret": { versions: [] } },
      ),
    );
    expect(code).toBe(0);
    expect(out).not.toContain("@x/secret");
  });
});

describe("the third state, which is the point", () => {
  it("refuses to call an unreachable registry an unpublished name", () => {
    /**
     * The failure this file is really for. Reported as "could not ask"
     * rather than as an answer: an offline run that said "never published"
     * would announce every package at once, and the reader who saw that once
     * would never read this output again.
     */
    const { code, out } = run(
      stage(four, { ...allPublished, "@x/c": { unreachable: true } }),
    );
    expect(code).toBe(2);
    expect(out).toContain("could not ask");
    expect(out).toContain("@x/c");
    expect(out).not.toContain("FIRST time");
  });

  it("does not let an unreachable name hide behind a real finding", () => {
    /* Both at once: one genuinely unpublished, one unaskable. Answering
       "one first publish" would be a confident half-truth, and the half it
       dropped is the one nobody would go looking for. */
    const { code, out } = run(
      stage(four, {
        ...allPublished,
        "@x/c": { unreachable: true },
        "@x/d": { versions: [] },
      }),
    );
    expect(code).toBe(2);
    expect(out).toContain("could not ask");
  });
});

describe("the refusal to pass nothing", () => {
  it("refuses a workspace it can barely read", () => {
    const { code, out } = run(
      stage({ "@x/a": {} }, { "@x/a": { versions: [] } }),
    );
    expect(code).toBe(2);
    expect(out).toContain("layout moved");
  });
});

describe.runIf(shadowable)(
  "the live registry path, which the fixture seam skips entirely",
  () => {
    /**
     * A mutation found this untested: deleting the `E404` branch — the line
     * that turns npm's "no such package" into the answer *never published* —
     * failed nothing, because every case above replaces the npm calls.
     *
     * That branch is what makes the real run correct, so it is exercised
     * against a fake `npm` on `PATH` rather than against the network. The fake
     * is deliberately dumb: it answers one name the way npm answers a name it
     * has never served, and the others with a version list.
     */
    const withFakeNpm = (root, script) => {
      const bin = join(root, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "npm"), script, "utf8");
      chmodSync(join(bin, "npm"), 0o755);
      try {
        return {
          code: 0,
          out: execFileSync(process.execPath, [SCRIPT], {
            encoding: "utf8",
            env: {
              ...process.env,
              FIRST_PUBLISH_ROOT: root,
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

    it("reads npm's E404 as an answer: the name has never been served", () => {
      const { root } = stage(four, {});
      const { code, out } = withFakeNpm(
        root,
        `#!/usr/bin/env bash\n` +
          `for a in "$@"; do if [ "$a" = "@x/d" ]; then\n` +
          `  echo "npm error code E404" >&2\n` +
          `  echo "npm error 404 Not Found - GET https://registry.npmjs.org/@x%2fd" >&2\n` +
          `  exit 1\n` +
          `fi; done\n` +
          `echo '["1.0.0"]'\n`,
      );
      expect(code).toBe(1);
      expect(out).toContain("FIRST time");
      expect(out).toContain("@x/d");
    });

    it("does not read any other npm failure as an answer", () => {
      /* A timeout, a proxy, an auth failure. Same non-zero exit, and the
       opposite meaning — this is the distinction the E404 branch exists to
       make, and reading it the other way announces a first publish that is
       not happening. */
      const { root } = stage(four, {});
      const { code, out } = withFakeNpm(
        root,
        `#!/usr/bin/env bash\necho "npm error network request to https://registry.npmjs.org failed" >&2\nexit 1\n`,
      );
      expect(code).toBe(2);
      expect(out).toContain("could not ask");
    });
  },
);
