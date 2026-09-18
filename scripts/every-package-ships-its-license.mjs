#!/usr/bin/env node
/**
 * Every package we publish carries the licence it claims — B224.
 *
 *     node scripts/every-package-ships-its-license.mjs
 *
 * Seven packages declare `"license": "MIT"` and **not one of them has a
 * LICENSE file in its own directory.** The text reaches consumers anyway,
 * because pnpm copies the workspace root's LICENSE into each tarball at pack
 * and publish time.
 *
 * That is a fact about a tool's behaviour, it is written down nowhere, and it
 * is the entire licence story of a repository whose launch IS those seven
 * packages. A consumer who unpacks `@byollm/protocol` and finds no licence has
 * code with a permission claim in a metadata field and no grant beside it.
 *
 * ## Why this is a check and not a note
 *
 * I got it wrong in the obvious direction first: the `files` array names
 * `["dist", "README.md"]` and no LICENSE, so I concluded nothing shipped. The
 * published tarball proved otherwise. **The next person will get it wrong in
 * the other direction** — assume it ships, and be right until somebody adds a
 * `files` entry, switches publish tooling, or upgrades pnpm past the
 * behaviour. Neither of us would find out from the repository.
 *
 * ## What it actually asks, and what that is a proxy for
 *
 * `pnpm pack` each publishable package and read the tarball. Pack is a proxy
 * for publish, and the proxy was checked rather than assumed.
 *
 * **Checked for ALL SIX published packages, not extrapolated from one.** The
 * first version compared `@byollm/protocol`'s registry tarball against its
 * local pack and asserted the rest by mechanism — which is a claim about six
 * things verified for one, and this week has cost enough for exactly that
 * shape. So on 2026-09-18 every published tarball was pulled from the registry
 * (`npm pack <name>@alpha`) and its `package/LICENSE` diffed against the
 * repository's: `byollm`, `@byollm/protocol`, `@byollm/server`,
 * `@byollm/relay`, `@byollm/conformance`, `@byollm/control-plane` — six of
 * six present, six of six byte-identical.
 *
 * `@byollm/agreements` is the seventh and has never been published, so there
 * is nothing to compare; it is exactly what `a-first-publish-is-announced.mjs`
 * is about.
 *
 * It compares CONTENT, not presence: a package that grows its own LICENSE file
 * saying something else would otherwise pass while shipping a different grant
 * than the six beside it.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.env["LICENSE_CHECK_ROOT"] ?? join(HERE, ".."));

/** Every package the workspace would publish, derived rather than listed. */
const publishable = (root) => {
  const dir = join(root, "packages");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => existsSync(join(path, "package.json")))
    .map((path) => ({
      path,
      manifest: JSON.parse(readFileSync(join(path, "package.json"), "utf8")),
    }))
    .filter(({ manifest }) => manifest.private !== true)
    .sort((a, b) => (a.manifest.name < b.manifest.name ? -1 : 1));
};

/** The files inside a tarball, as npm lays them out under `package/`. */
const contents = (tarball) =>
  execFileSync("tar", ["tzf", tarball], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "");

/** One file's bytes out of a tarball, without unpacking the rest. */
const fileFrom = (tarball, path) =>
  execFileSync("tar", ["xzOf", tarball, path], { encoding: "utf8" });

const main = () => {
  const license = join(ROOT, "LICENSE");
  if (!existsSync(license)) {
    console.error(
      "no LICENSE at the repository root.\n" +
        "Every package's manifest claims a licence and pnpm copies THIS file\n" +
        "into each tarball, so without it seven packages publish a claim with\n" +
        "no grant under it.",
    );
    return 1;
  }
  const expected = readFileSync(license, "utf8");

  const packages = publishable(ROOT);
  /* A reader that found no packages would report every one of them correct. */
  if (packages.length < 3) {
    console.error(
      `only ${String(packages.length)} publishable package(s) found — the workspace layout moved`,
    );
    return 2;
  }

  const out = mkdtempSync(join(tmpdir(), "ships-license-"));
  let bad = 0;
  try {
    for (const { manifest } of packages) {
      try {
        execFileSync(
          "pnpm",
          ["--filter", manifest.name, "pack", "--pack-destination", out],
          { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );
      } catch (error) {
        /**
         * Could not pack — which is not an answer about the licence.
         *
         * On Windows `pnpm` is `pnpm.cmd`, and Node refuses to spawn a `.cmd`
         * from `execFileSync` without `shell: true` — which `byollm_004 §2`
         * bans outright. So this gate cannot run there at all, and before
         * this branch it did not say so: it threw `spawnSync pnpm ENOENT` and
         * a stack trace, which is a gate crashing rather than reporting.
         *
         * Exit 2 is "I could not ask", the same third state the registry
         * checks use. An unreachable tool is not a package shipping no
         * licence, and reporting it as one would be the false alarm that gets
         * a gate deleted.
         */
        if (String(/** @type {{code?: string}} */ (error).code) === "ENOENT") {
          console.error(
            "cannot pack: `pnpm` could not be spawned here.\n" +
              "  On Windows it is `pnpm.cmd`, which execFileSync will not run " +
              "without a shell,\n  and byollm_004 §2 bans shell-invoking APIs. " +
              "This gate runs on POSIX; CI\n  asks it on ubuntu.\n\n" +
              "  Not an answer about any package's licence.",
          );
          return 2;
        }
        throw error;
      }
      const tarball = readdirSync(out)
        .filter((name) => name.endsWith(".tgz"))
        .map((name) => join(out, name))
        .at(-1);
      if (tarball === undefined) {
        console.log(`  NO TARBALL  ${manifest.name}`);
        bad += 1;
        continue;
      }
      const inside = contents(tarball).filter((path) =>
        /^package\/LICEN[CS]E(\.\w+)?$/u.test(path),
      );
      if (inside.length === 0) {
        console.log(
          `  NO LICENSE  ${manifest.name} — claims "${String(manifest.license)}" and ships no grant`,
        );
        bad += 1;
        continue;
      }
      const shipped = fileFrom(tarball, inside[0] ?? "");
      if (shipped !== expected) {
        console.log(
          `  DIFFERENT   ${manifest.name} — ships a LICENSE that is not the repository's`,
        );
        bad += 1;
        continue;
      }
      console.log(`  ships MIT   ${manifest.name}`);
      rmSync(tarball);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }

  if (bad > 0) {
    console.error(
      `\n${String(bad)} package(s) would publish a licence claim with no text under it.\n` +
        "pnpm copies the root LICENSE into each tarball; if that stopped, this\n" +
        "is where it shows. Adding a LICENSE to the package's own directory\n" +
        "also works — it must be the same one.",
    );
    return 1;
  }
  console.log(
    `\nAll ${String(packages.length)} publishable packages carry the root LICENSE.\n` +
      "Asked of `pnpm pack`, which is a proxy for publish: both were compared\n" +
      "against the real registry tarball for @byollm/protocol and agree.",
  );
  return 0;
};

/* `realpathSync`, not `resolve`: `import.meta.url` reports the REAL path and
   `process.argv[1]` does not, so under a symlinked checkout the two never
   match and the gate exits 0 having checked nothing. Three gates in this
   portfolio shipped that fail-open before it was noticed. */
if (realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  process.exit(main());
