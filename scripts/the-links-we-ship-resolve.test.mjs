import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The link checker, against a fixture world.
 *
 * It found two live dead links on its first run — the README byline's
 * `oftomorrow.dev`, which has no A record, and `@byollm/agreements` on six
 * published package pages. What the suite proves is the reasoning, above all
 * the two states that are NOT failures: `npmjs.com` answers 403 to anything
 * unbrowsery, and a checker that called our own npm links dead would be gone
 * within a day.
 */

const SCRIPT = fileURLToPath(
  new URL("./the-links-we-ship-resolve.mjs", import.meta.url),
);

const stage = (files, world) => {
  const root = mkdtempSync(join(tmpdir(), "link-check-"));
  for (const [path, body_] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body_, "utf8");
  }
  const fixture = join(root, "world.json");
  writeFileSync(fixture, JSON.stringify(world));
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
          LINK_CHECK_ROOT: root,
          LINK_CHECK_FIXTURE: fixture,
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

describe("which links are claims", () => {
  /**
   * Asked through the script rather than through an import: `scripts/*.mjs`
   * are standalone executables by this repository's own eslint note — "not
   * modules the project imports" — so behaviour is the only surface a test
   * gets, and a test that imported one would be testing something the design
   * says does not exist.
   */
  const reported = (markdown, world) =>
    run(stage({ "README.md": markdown, "CONTRIBUTING.md": "hi\n" }, world));

  it("follows a URL written in prose", () => {
    const { code, out } = reported(
      "See [us](https://example.org/a) for more.\n",
      {
        "https://example.org/a": { status: 404 },
      },
    );
    expect(code).toBe(1);
    expect(out).toContain("https://example.org/a");
  });

  it("ignores a URL inside a fenced block, because that is an example", () => {
    /**
     * The whole trick. A README is full of URLs nobody should visit —
     * `https://your-app.com`, `http://127.0.0.1:11434/v1`. A checker that
     * reported those would be reporting the documentation for doing its job,
     * and the discriminator is NOT a list of placeholder domains, which would
     * go stale and would have to guess.
     *
     * Both placeholders are given a 404 in the fixture, so a check that read
     * them at all would fail here.
     */
    const md = [
      "Real: https://example.org/real",
      "",
      "```json",
      '{ "baseUrl": "https://your-app.com", "relay": "https://your-relay.example" }',
      "```",
      "",
      "Also `https://inline-example.test` in a code span.",
    ].join("\n");
    const { code, out } = reported(md, {
      "https://example.org/real": { status: 200 },
      "https://your-app.com": { status: 404 },
      "https://your-relay.example": { status: 404 },
      "https://inline-example.test": { status: 404 },
    });
    expect(code).toBe(0);
    expect(out).toContain("1 link(s)");
  });

  it("strips fences before inline spans, not after", () => {
    /**
     * Order matters and the wrong one leaks. A single backtick inside a fenced
     * block would cut the fence in half if inline spans went first, and the
     * rest of the block would come back out as prose — which is exactly where
     * example URLs live.
     */
    const md = [
      "```bash",
      "# it's a shell comment with an apostrophe",
      "curl https://leaked.example/from-a-fence",
      "```",
      "",
      "Real: https://example.org/kept",
    ].join("\n");
    const { code, out } = reported(md, {
      "https://example.org/kept": { status: 200 },
      "https://leaked.example/from-a-fence": { status: 404 },
    });
    expect(code).toBe(0);
    expect(out).toContain("1 link(s)");
  });

  it("does not keep trailing punctuation as part of the link", () => {
    /* A fixture answering only for the clean URL: if the trailing comma
       survived, the lookup misses and the 404 never arrives. */
    const { code } = reported("Go to https://example.org/a, then stop.\n", {
      "https://example.org/a": { status: 404 },
    });
    expect(code).toBe(1);
  });

  it("reports one link once however often it appears", () => {
    const { out } = reported(
      "https://example.org/a and again https://example.org/a\n",
      { "https://example.org/a": { status: 200 } },
    );
    expect(out).toContain("1 link(s)");
  });
});

describe("what question to ask, which is not always the link", () => {
  /**
   * A mutation found this untested. The fixture is keyed by what is ASKED, so
   * these go green only if the npm→registry translation happened — the same
   * seam-hides-the-live-path gap the first-publish script had one script
   * earlier, closed through behaviour rather than by exporting from an
   * executable.
   *
   * Not cosmetic: asking `npmjs.com` put eight of thirteen real links in
   * "could not judge", and asking the registry both answered seven of them
   * and found the dead `@byollm/agreements` link the website's 403 was hiding.
   */
  it("asks the registry about an npm package page", () => {
    const { code, out } = run(
      stage(
        {
          "README.md": "See https://www.npmjs.com/package/@byollm/gone\n",
          "CONTRIBUTING.md": "hi\n",
        },
        { "https://registry.npmjs.org/@byollm/gone": { status: 404 } },
      ),
    );
    expect(code).toBe(1);
    /* Reported as the link the reader clicks, not as the question asked. */
    expect(out).toContain("https://www.npmjs.com/package/@byollm/gone");
    expect(out).not.toContain("registry.npmjs.org");
  });

  it("leaves an npm URL that is not a package page alone", () => {
    /* `npmjs.com/org/byollm` has no registry equivalent. Rewriting it would
       404 and report our own org link as dead — the false alarm invented by
       the fix for the false alarm. */
    const { code } = run(
      stage(
        {
          "README.md": "See https://www.npmjs.com/org/byollm\n",
          "CONTRIBUTING.md": "hi\n",
        },
        { "https://www.npmjs.com/org/byollm": { status: 403 } },
      ),
    );
    expect(code).toBe(0);
  });

  it("does not mistake a lookalike host for npm", () => {
    /* `notnpmjs.com` is a different host. An anchored pattern is the
       difference between a translation and a redirection somebody else
       controls — and here the 404 only lands if the URL was left alone. */
    const { code } = run(
      stage(
        {
          "README.md": "See https://notnpmjs.com/package/x\n",
          "CONTRIBUTING.md": "hi\n",
        },
        { "https://notnpmjs.com/package/x": { status: 404 } },
      ),
    );
    expect(code).toBe(1);
  });
});

const README = (body_) => ({
  "README.md": body_,
  "CONTRIBUTING.md": "hello\n",
});

describe("a link a reader cannot follow", () => {
  it("is reported when the name does not resolve", () => {
    const { code, out } = run(
      stage(README("Built by [Of Tomorrow](https://gone.example/)\n"), {
        "https://gone.example/": { dns: false },
      }),
    );
    expect(code).toBe(1);
    expect(out).toContain("DEAD");
    expect(out).toContain("does not resolve");
  });

  it("is reported when the server says 404", () => {
    const { code, out } = run(
      stage(README("See https://example.org/missing\n"), {
        "https://example.org/missing": { status: 404 },
      }),
    );
    expect(code).toBe(1);
    expect(out).toContain("HTTP 404");
  });

  it("names every file that ships it", () => {
    /* Six package READMEs carried the same dead npm link. A report naming one
       sends somebody to fix one. */
    const { out } = run(
      stage(
        {
          "README.md": "x https://example.org/missing\n",
          "CONTRIBUTING.md": "y https://example.org/missing\n",
          "packages/a/README.md": "z https://example.org/missing\n",
        },
        { "https://example.org/missing": { status: 404 } },
      ),
    );
    expect(out).toContain("README.md");
    expect(out).toContain("CONTRIBUTING.md");
    expect(out).toContain("packages/a/README.md");
  });
});

describe("the states that are not failures", () => {
  it("does not call a 403 dead", () => {
    /**
     * `npmjs.com` answers 403 to anything that does not look like a browser.
     * Eight of thirteen links landed here before the registry question was
     * added, and calling them dead would have been a checker reporting its own
     * user agent.
     */
    const { code, out } = run(
      stage(README("See https://www.npmjs.com/org/byollm\n"), {
        "https://www.npmjs.com/org/byollm": { status: 403 },
      }),
    );
    expect(code).toBe(0);
    expect(out).toContain("could not judge");
    expect(out).not.toContain("DEAD");
  });

  it("does not call an unreachable request dead", () => {
    const { code, out } = run(
      stage(README("See https://slow.example/x\n"), {
        "https://slow.example/x": { unreachable: true },
      }),
    );
    expect(code).toBe(0);
    expect(out).toContain("could not judge");
  });

  it("passes a page that answers", () => {
    const { code, out } = run(
      stage(README("See https://example.org/fine\n"), {
        "https://example.org/fine": { status: 200 },
      }),
    );
    expect(code).toBe(0);
    expect(out).toContain("Every link");
  });
});

describe("the refusals to pass nothing", () => {
  it("refuses a tree with almost no shipped markdown", () => {
    const { code, out } = run(stage({ "README.md": "hi\n" }, {}));
    expect(code).toBe(2);
    expect(out).toContain("layout moved");
  });

  it("refuses when it found no links at all", () => {
    /* Zero of zero links are dead is a perfect green about a reader who was
       never invited anywhere — and it is what a broken extractor produces. */
    const { code, out } = run(
      stage(
        { "README.md": "no links here\n", "CONTRIBUTING.md": "nor here\n" },
        {},
      ),
    );
    expect(code).toBe(2);
    expect(out).toContain("found nothing");
  });
});
