import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Seven packages, one set of promises — B224's second-sources dimension.
 *
 * The row's rule: *every fact stated in two places gets extracted to one
 * source or gains an agreement check.* A published manifest is the worst case
 * of that rule, because npm requires the fact in each package and there is
 * nowhere to extract it TO. So it gets the other branch, and this is it.
 *
 * ## It found four drifts on the day it was written
 *
 * `@byollm/control-plane` and `@byollm/relay` declared **no `engines` at
 * all** — so npm would install them onto Node 18 without a murmur and the
 * failure would arrive later, looking like something else. `docs/deps.md`
 * meanwhile states *"`engines` says ≥22.14"* as a fact about the project,
 * which was false for two of seven packages.
 *
 * `@byollm/conformance` and `@byollm/server` had no `homepage`, so their npm
 * pages pointed nowhere while five siblings pointed home.
 *
 * None of these is a bug in running code. All four are promises a stranger
 * reads before deciding whether to trust the project, which is what makes
 * them launch-blocking rather than tidy.
 *
 * **`@byollm/relay` was one of the two missing `engines`** — the same package
 * that was once absent from four hardcoded lists at once, and the same one
 * whose absence this repository keeps rediscovering. A set nothing enumerates
 * loses the same member twice.
 */
const PACKAGES = "packages";

/** Which packages ship — derived, the same rule the release workflow uses. */
function published() {
  const found = [];
  for (const dir of readdirSync(PACKAGES)) {
    const manifest = join(PACKAGES, dir, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    if (pkg.private === true) continue;
    found.push({ dir, pkg });
  }
  return found;
}

const all = published();

describe("every published package", () => {
  it("is found at all, or this compares nothing", () => {
    /* The control. Every assertion below is "each package does X", which an
       empty list satisfies perfectly — and a reader that silently found
       nothing is how this repository has shipped a green check about an
       unexamined set before. */
    expect(all.length).toBeGreaterThan(3);
  });

  it("declares a Node floor, and the same one", () => {
    /**
     * Two of seven declared none when this was written. A package with no
     * `engines` is a package that promises nothing about the runtime it needs:
     * npm installs it anywhere and the failure surfaces later, wearing the
     * shape of whatever broke first.
     *
     * The same floor across all of them, because they are installed together
     * and a family that disagrees about its runtime has one member deciding
     * for the rest, silently, by being the strictest.
     */
    const floors = new Set(all.map(({ pkg }) => pkg.engines?.node));
    for (const { pkg } of all) {
      expect(
        pkg.engines?.node,
        `${pkg.name} declares no Node floor`,
      ).toBeDefined();
    }
    expect(
      [...floors],
      `the family disagrees about its Node floor`,
    ).toHaveLength(1);
  });

  it("declares the floor `docs/deps.md` says it declares", () => {
    /**
     * The fact is in eight places — seven manifests and one paragraph — and
     * the paragraph is the one a contributor reads. It explains a deliberate
     * split (*"we build and test on Node 24 … but `engines` says ≥22.14"*),
     * and an explanation that names the wrong number is worse than none,
     * because it is the number somebody will act on.
     */
    const deps = readFileSync(join("docs", "deps.md"), "utf8");
    const stated = /`engines` says\s+≥\s*([0-9.]+)/u.exec(deps)?.[1];
    expect(
      stated,
      "docs/deps.md no longer states the floor it explains",
    ).toBeDefined();
    for (const { pkg } of all) {
      expect(
        pkg.engines?.node,
        `${pkg.name} does not declare the floor docs/deps.md explains`,
      ).toBe(`>=${stated}`);
    }
  });

  it("says who may use it, identically", () => {
    const licences = new Set(all.map(({ pkg }) => pkg.license));
    expect([...licences]).toEqual(["MIT"]);
  });

  it("publishes publicly on purpose", () => {
    /* `publishConfig.access` is what stops a scoped package defaulting to
       restricted and failing the publish half way through a release — the
       partial-publish state `release-check.mjs` exists to catch. */
    for (const { pkg } of all) {
      expect(pkg.publishConfig?.access, pkg.name).toBe("public");
    }
  });

  it("points a reader somewhere, from its npm page", () => {
    /**
     * Two of seven had no `homepage` when this was written. An npm page with
     * no link home is where a stranger's interest ends, and the OSS launch is
     * the week that matters most.
     */
    const homes = new Set(all.map(({ pkg }) => pkg.homepage));
    for (const { pkg } of all) {
      expect(pkg.homepage, `${pkg.name} has no homepage`).toBeDefined();
    }
    expect([...homes], "the family points at different homes").toHaveLength(1);
  });

  it("points at its own directory in this repository", () => {
    /**
     * `repository.directory` is what makes npm's "source" link land on the
     * package rather than the monorepo root. Wrong is worse than absent: it
     * sends somebody confidently to another package's code.
     */
    for (const { dir, pkg } of all) {
      expect(pkg.repository?.url, `${pkg.name} names no repository`).toContain(
        "oftomorrowinc/byollm",
      );
      expect(pkg.repository?.directory, pkg.name).toBe(`${PACKAGES}/${dir}`);
    }
  });

  it("ships a README, which is the page npm renders", () => {
    for (const { dir, pkg } of all) {
      expect(pkg.files, `${pkg.name} lists no files`).toContain("README.md");
      expect(
        existsSync(join(PACKAGES, dir, "README.md")),
        `${pkg.name} promises a README it does not have`,
      ).toBe(true);
    }
  });
});
