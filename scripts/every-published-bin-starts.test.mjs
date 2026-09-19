import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every published bin starts, from somewhere that is not us — B243.
 *
 * ## Why this file exists rather than four files
 *
 * B243 was one bin: `byollm-certify` could not load a relative path, and
 * nothing in this workspace had ever run it. `certify()` is tested directly,
 * which is right for an engine — and that is exactly what left the argv path
 * proven by nobody.
 *
 * The obvious next question was whether the other three had the same seam. Two
 * did, in a smaller way: `byollm-audit-deployment` treated `--help` as a URL
 * and exited 1 after a failed scan of the flag, and every published invocation
 * of `keygen` used the ambiguous `npx <package> <bin>` form.
 *
 * **So the gate is the set, derived from the manifests.** A hand-written list
 * of four bins is this repository's most-repeated defect — `@byollm/relay` has
 * gone missing from one twice — and a bin added tomorrow gets checked here
 * without anybody remembering this file.
 *
 * ## What it asserts, and why `--help`
 *
 * `--help` is what a person types before anything else, and it is the flag
 * B243 found broken on two bins out of two that had one. The universal
 * property is narrower than "prints usage", because not every bin must
 * implement it: **whatever it does, it must not fail by unwinding through our
 * own code.** A Node stack trace naming `@byollm/...` is the misattribution
 * this whole row is about — the reader concludes our package is broken, and
 * nothing in the trace says otherwise.
 *
 * Run from a temp directory, because relative resolution against `dist/`
 * happens to find things when you are standing next to `dist/`.
 */
const PACKAGES = "packages";

/** Every bin we publish, with the file it points at — derived. */
function publishedBins() {
  const found = [];
  for (const dir of readdirSync(PACKAGES)) {
    const manifest = join(PACKAGES, dir, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    if (pkg.private === true) continue;
    for (const [bin, target] of Object.entries(pkg.bin ?? {})) {
      found.push({ bin, pkg: pkg.name, path: resolve(PACKAGES, dir, target) });
    }
  }
  return found;
}

const BINS = publishedBins();

function run(path, args) {
  const cwd = mkdtempSync(join(tmpdir(), "bin-"));
  try {
    const out = execFileSync(process.execPath, [path, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out, err: "" };
  } catch (error) {
    return {
      code: error.status ?? -1,
      out: error.stdout ?? "",
      err: error.stderr ?? "",
    };
  }
}

describe("every bin we publish", () => {
  it("is found, and there is more than one", () => {
    /* The control. "No bin misbehaves" is satisfied perfectly by finding no
       bins, and this set is discovered rather than written down. */
    expect(BINS.length).toBeGreaterThan(2);
  });

  it("exists on disk where the manifest says", () => {
    /**
     * A `bin` pointing at a file the package does not ship installs cleanly
     * and fails at the moment somebody runs it — which is the same shape as
     * B243 and even quieter, because `npm install` says nothing.
     */
    for (const { bin, path } of BINS) {
      expect(existsSync(path), `${bin} -> ${path}`).toBe(true);
    }
  });

  it("starts when asked for help, without unwinding through our code", () => {
    for (const { bin, pkg, path } of BINS) {
      const ran = run(path, ["--help"]);

      expect(ran.code, `${bin} did not start at all`).not.toBe(-1);
      const said = `${ran.out}${ran.err}`;
      expect(said, `${bin} could not load its own modules`).not.toContain(
        "ERR_MODULE_NOT_FOUND",
      );
      /* The trace is the misattribution: a reader seeing node unwind through
         our package concludes the package is broken, and there is no second
         reading available to them. */
      expect(said, `${bin} printed a Node stack trace`).not.toContain(
        "node:internal",
      );
      expect(said, `${bin} printed a stack frame`).not.toMatch(/\n\s+at /u);
      expect(said, `${bin} is silent about ${pkg}`).not.toBe("");
    }
  });

  it("does not treat --help as data", () => {
    /**
     * `byollm-audit-deployment` did: it read `--help` as the URL to audit and
     * exited 1 after failing to scan the flag. A flag answered with a failed
     * attempt at itself is worse than an unrecognised one — it reads as the
     * tool having tried, and as the deployment being broken.
     *
     * Asserted as an absence of the flag in the output, which is what "it was
     * used as a value" looks like from outside.
     */
    for (const { bin, path } of BINS) {
      const said = run(path, ["--help"]);
      expect(
        `${said.out}${said.err}`,
        `${bin} echoed --help back, which is what using it as a value looks like`,
      ).not.toMatch(/—\s*--help|audit.*--help|posture.*--help/u);
    }
  });
});

/**
 * …and is inside the tarball a stranger installs — B294.
 *
 * The cases above run each bin from a temp directory, *"because relative
 * resolution against `dist/` happens to find things when you are standing next
 * to `dist/`"*. That instinct is right and stops one step short: they run the
 * **working tree's** copy. What npm hands a stranger is whatever `files`
 * admits, and the two are different documents.
 *
 * The quietest failure this package has available is an entry point outside
 * `files`: `npm install` succeeds, nothing warns, and the reader meets it only
 * when they import or run the thing — B243's shape again, moved from argv into
 * the packing list.
 *
 * **It is not symmetric, and measuring said so.** Dropping `dist` from
 * `@byollm/protocol`'s `files` breaks its `types` and `exports` immediately.
 * Dropping `bin` from `@byollm/server`'s changes nothing, because npm ships
 * bin targets unconditionally — so the bin case below is a check on npm's
 * guarantee rather than on our packing list, and says so where it sits.
 *
 * Derived from the manifests and from `npm pack` itself, so neither side is a
 * list somebody maintains. ~1.8s for all six packages.
 */
/**
 * **`undefined` when npm cannot be spawned at all — B315.**
 *
 * On Windows `npm` is `npm.cmd`, and Node refuses to spawn a `.cmd` from
 * `execFileSync` without `shell: true`, which `byollm_004 §2` bans outright.
 * So this threw `spawnSync npm ENOENT` and a stack trace: a check crashing
 * rather than reporting, on the one platform its author cannot run.
 *
 * It was red on `windows-latest` for nine consecutive pushes to main — three
 * and a half hours — and took the Release run for `v0.1.0-alpha.103` down with
 * it at the CI gate. Nothing published; the gate did its job. My local
 * `pnpm verify` is macOS and was green throughout, which is exactly why the
 * other two OSes exist in CI and exactly why a push is not done until they are
 * read.
 *
 * `every-package-ships-its-license.mjs` met this first and settled it: an
 * unreachable tool is *"I could not ask"*, not an answer about the subject,
 * and reporting it as one is the false alarm that gets a gate deleted. This is
 * the same third state, in a file that has cases instead of an exit code.
 *
 * Narrow on purpose — ENOENT only. A packing failure that npm actually
 * produced is a real answer and still throws.
 */
const packed = (dir) => {
  let out;
  try {
    out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (/** @type {{code?: string}} */ (error).code !== "ENOENT") throw error;
    return undefined;
  }
  return new Set(JSON.parse(out)[0].files.map((f) => f.path));
};

/**
 * Said once, where somebody reading a green run will see it.
 *
 * A skip that prints nothing is how a platform quietly stops being tested —
 * and this file's whole subject is what a stranger receives, so a silent gap
 * on one OS is the wrong kind of quiet.
 */
const cannotPack = () => {
  console.warn(
    "every-published-bin-starts: `npm` could not be spawned here, so the " +
      "packing cases did not run. On Windows it is `npm.cmd`, which " +
      "execFileSync will not run without a shell, and byollm_004 §2 bans " +
      "shell-invoking APIs. NOT an answer about any package's files.",
  );
};

/** Every publishable package directory, with its manifest. */
const publishable = () =>
  readdirSync(PACKAGES)
    .map((dir) => ({
      dir: join(PACKAGES, dir),
      file: join(PACKAGES, dir, "package.json"),
    }))
    .filter(({ file }) => existsSync(file))
    .map(({ dir, file }) => ({
      dir,
      pkg: JSON.parse(readFileSync(file, "utf8")),
    }))
    .filter(({ pkg }) => pkg.private !== true);

describe("what npm actually hands a stranger", () => {
  it("has packages to look at, or every loop below runs over nothing", () => {
    /**
     * A mutation made `publishable()` return `[]` and all three cases passed —
     * vacuously, because each is a loop. I had guarded the pack listing being
     * empty and not the package set being empty, which is the same fail-open
     * one level out, in the file whose docstring warns about it.
     */
    expect(publishable().length).toBeGreaterThan(4);
  });

  it("is a listing with files in it, or this compares nothing", () => {
    /* `npm pack` answering an empty set would make every assertion below pass
       about a package that ships nothing — the fail-open this repository keeps
       finding in its own checks. */
    for (const { dir, pkg } of publishable()) {
      const files = packed(dir);
      if (files === undefined) return cannotPack();
      expect(files.size, pkg.name).toBeGreaterThan(2);
    }
  });

  it("contains every bin, because npm ships them whatever `files` says", () => {
    /**
     * **This is a check on somebody else's control, and it says so** — CW's
     * law of 2026-09-19: a justification pointing at a system we do not own
     * must name the control and verify it once, by looking.
     *
     * I wrote it as a check on OUR `files` field and a mutation showed it
     * could not fail that way. Measured 2026-09-18: with `bin` removed from
     * `@byollm/server`'s `files`, `bin/keygen.mjs` is **still in the
     * tarball** — npm includes bin targets unconditionally.
     *
     * So a mutation dropping a bin directory from `files` survives this, by
     * design, and that is not a gap to be closed. What this asserts is the
     * guarantee itself: if npm ever stops doing it, the quietest failure this
     * package has available — install succeeds, `.bin` symlink dangles, the
     * reader meets it only on running — arrives here instead of there.
     *
     * It still catches one thing of ours: a `bin` pointing at a file that is
     * not on disk ships nothing, whatever the guarantee says.
     */
    for (const { dir, pkg } of publishable()) {
      const files = packed(dir);
      if (files === undefined) return cannotPack();
      for (const [bin, target] of Object.entries(pkg.bin ?? {}))
        expect(
          files.has(target.replace(/^\.\//u, "")),
          `${pkg.name}'s \`${bin}\` (${target}) is not in the tarball — ` +
            "either the file is not on disk, or npm has stopped including " +
            "bin targets unconditionally, which this package relies on",
        ).toBe(true);
    }
  });

  it("contains every entry point the manifest points at", () => {
    /**
     * `main`, `types`, `module` and every leaf of `exports`. A missing
     * `types` is quieter still than a missing bin: the package imports fine
     * and the consumer simply gets `any`, which looks like our types being
     * poor rather than absent.
     */
    const leaves = (node, path, into) => {
      if (typeof node === "string") into.push([`exports${path}`, node]);
      else if (node !== null && typeof node === "object")
        for (const [k, v] of Object.entries(node))
          leaves(v, `${path}.${k}`, into);
    };
    for (const { dir, pkg } of publishable()) {
      const files = packed(dir);
      if (files === undefined) return cannotPack();
      const targets = [];
      for (const field of ["main", "types", "module"])
        if (typeof pkg[field] === "string") targets.push([field, pkg[field]]);
      leaves(pkg.exports, "", targets);
      for (const [field, target] of targets)
        expect(
          files.has(target.replace(/^\.\//u, "")),
          `${pkg.name}'s \`${field}\` points at ${target}, which \`files\` ` +
            "does not admit",
        ).toBe(true);
    }
  });
});

describe("what this file does where npm cannot be spawned — B315", () => {
  /**
   * It threw `spawnSync npm ENOENT` and a stack trace on `windows-latest` for
   * **nine consecutive pushes to main**, and took the Release run for
   * `v0.1.0-alpha.103` down with it at the CI gate. Nothing published; the
   * gate did its job.
   *
   * On Windows `npm` is `npm.cmd`, and Node refuses to spawn a `.cmd` from
   * `execFileSync` without `shell: true`, which `byollm_004 §2` bans.
   * `every-package-ships-its-license.mjs` met this first and settled it: an
   * unreachable tool is "I could not ask", not an answer about the subject.
   *
   * ## Why these are source assertions
   *
   * The condition cannot be produced here. Stripping `npm` from `PATH` gives
   * the identical `ENOENT` to a bare `execFileSync` — checked — but vitest
   * hands its workers a `PATH` that finds npm again, so the file cannot be run
   * against its own failure locally. The end-to-end proof is the Windows job,
   * which is the thing that was not being read.
   *
   * So what is pinned here is the shape: the guard is narrow, and every case
   * that packs handles not being able to.
   */
  const source = readFileSync(
    fileURLToPath(
      new URL("./every-published-bin-starts.test.mjs", import.meta.url),
    ),
    "utf8",
  );

  it("treats an unspawnable npm as unasked, not as an answer", () => {
    expect(source).toContain('.code !== "ENOENT") throw error;');
    expect(source).toMatch(/return undefined;/u);
  });

  it("does not swallow a failure npm actually produced", () => {
    /* Narrow on purpose. A packing error npm reported is a real answer about
       a real package, and hiding it here would be the false all-clear this
       file exists to prevent.

       Asserted as ORDER inside the catch, not as the absence of a pattern —
       my first version forbade `return undefined` near a `catch` and failed on
       the correct code, which is a rule written from the defect's silhouette
       rather than from the property. */
    /* Anchored to `packed`, because this file has another `catch (error)`
       that builds a result object — the unanchored version found that one and
       reported the guard missing. */
    const fn = source.slice(
      source.indexOf("const packed = (dir) => {"),
      source.indexOf("const cannotPack"),
    );
    const body = /catch \(error\) \{([\s\S]*?)\n {2}\}/u.exec(fn)?.[1] ?? "";
    /* `"pack", "--dry-run"` — the argv, which is what is actually written.
       I first asserted `"npm pack"`, a phrase that appears nowhere: the
       command and its first argument are separate strings. Third rule in this
       one case written from what I pictured rather than from the file. */
    expect(fn, "packed() has moved or gone").toContain('"pack", "--dry-run"');
    expect(body, "packed()'s catch has moved or gone").toContain(
      "throw error;",
    );
    expect(
      body.indexOf("throw error;") < body.indexOf("return undefined;"),
      "the catch returns before it rethrows, so a real npm failure is hidden",
    ).toBe(true);
  });

  it("handles it at every case that packs, not at some of them", () => {
    /**
     * The structural one, and the reason it is here: a fourth case that calls
     * `packed()` and forgets the guard puts Windows back to a stack trace, and
     * nothing else would notice until CI — which is exactly how the nine runs
     * happened.
     */
    const calls = source.match(/const files = packed\(dir\);/gu) ?? [];
    const guards =
      source.match(/if \(files === undefined\) return cannotPack\(\);/gu) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(
      guards.length,
      "a case packs without handling not being able to",
    ).toBe(calls.length);
  });

  it("says so rather than skipping in silence", () => {
    /**
     * A platform that quietly stops being tested is worse than one that fails,
     * and this file's subject is what a stranger receives.
     *
     * **Scoped to `cannotPack`'s body, because the whole source contains this
     * assertion.** The first version read `source` for the sentence and passed
     * a mutation that deleted the sentence — the phrase was still there, in
     * the expectation looking for it. A file that reads itself will find
     * whatever its own test says, which is the one-source comparison this
     * project keeps catching in other people's checks and has now caught in
     * mine.
     */
    const fn = source.slice(
      source.indexOf("const cannotPack"),
      source.indexOf("/** Every publishable package"),
    );
    expect(fn, "cannotPack has moved or gone").toContain("console.warn");
    expect(fn).toContain("NOT an answer");
  });
});
