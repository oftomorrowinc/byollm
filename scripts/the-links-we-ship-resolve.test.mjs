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

describe("the manifests npm turns into a page", () => {
  /**
   * `homepage`, `bugs.url` and `repository.url` are rendered by npm in the
   * sidebar of every published package's page — six public pages today — and
   * **nothing read them**. This file's subject is *"the links this repository
   * ships to strangers"*, and an npm page is the most strangerly surface the
   * project has.
   *
   * Not hypothetical: `@byollm/agreements` 404'd from six live npm pages for
   * days, and was found only when this checker learned to read package
   * READMEs. The same defect, one field over, with nothing looking.
   */
  const MANIFEST = (extra) =>
    JSON.stringify({ name: "@x/a", version: "1.0.0", ...extra });

  it("reports a dead homepage, and names the manifest", () => {
    /* The case that makes the reader load-bearing. Without it the collector
       could return nothing and every other case here would still pass — a
       feature nobody consumes is dead code wearing an API. */
    const { code, out } = run(
      stage(
        {
          "README.md": "a link https://example.org/ok\n",
          "CONTRIBUTING.md": "more\n",
          "packages/a/package.json": MANIFEST({
            homepage: "https://gone.example/",
          }),
        },
        {
          "https://example.org/ok": { status: 200 },
          "https://gone.example/": { dns: false },
        },
      ),
    );
    expect(code).toBe(1);
    expect(out).toContain("DEAD");
    expect(out).toContain("packages/a/package.json");
  });

  it("reads bugs.url and repository.url too, not only homepage", () => {
    /* Three fields render, so checking one would leave two unread — the
       partial-coverage shape this repository keeps finding. */
    for (const field of [
      { bugs: { url: "https://gone.example/" } },
      { repository: { type: "git", url: "https://gone.example/" } },
    ]) {
      const { code, out } = run(
        stage(
          {
            "README.md": "a link https://example.org/ok\n",
            "CONTRIBUTING.md": "more\n",
            "packages/a/package.json": MANIFEST(field),
          },
          {
            "https://example.org/ok": { status: 200 },
            "https://gone.example/": { dns: false },
          },
        ),
      );
      expect(code, JSON.stringify(field)).toBe(1);
      expect(out, JSON.stringify(field)).toContain("DEAD");
    }
  });

  it("strips npm's git+ prefix and .git suffix before asking", () => {
    /**
     * `repository.url` is addressing for a clone, not a link: npm writes
     * `git+https://…/repo.git` and renders `https://…/repo`.
     *
     * **The first version of this case could not fail, and two mutations
     * proved it.** It answered only the stripped form and asserted exit 0 — but
     * a reader that did not strip asks about `git+https://…/repo.git`, which is
     * `unjudged` rather than dead, and unjudged is not a failure. So "strips"
     * and "does not strip" both exited 0.
     *
     * Inverted: the STRIPPED form is the dead one. A reader that strips finds
     * it and reports the URL a person would visit; a reader that does not asks
     * about a string nobody visits, learns nothing, and exits 0 — which now
     * fails this case instead of satisfying it.
     */
    const { code, out } = run(
      stage(
        {
          "README.md": "a link https://example.org/ok\n",
          "CONTRIBUTING.md": "more\n",
          "packages/a/package.json": MANIFEST({
            repository: {
              type: "git",
              url: "git+https://gone.example/repo.git",
            },
          }),
        },
        {
          "https://example.org/ok": { status: 200 },
          "https://gone.example/repo": { dns: false },
        },
      ),
    );
    expect(code, "the stripped URL was never asked about").toBe(1);
    expect(out).toContain("https://gone.example/repo");
    /* And the decorations are gone from what a person is shown to fix. */
    expect(out).not.toContain("git+");
    expect(out).not.toContain("repo.git");
  });

  it("leaves a private manifest alone, because npm never renders it", () => {
    /* The root manifest is private. Checking its links would report a dead
       URL on a page that does not exist, which is the false-alarm direction
       on a checker whose whole value is that its findings are real. */
    const { code } = run(
      stage(
        {
          "README.md": "a link https://example.org/ok\n",
          "CONTRIBUTING.md": "more\n",
          "packages/a/package.json": MANIFEST({
            private: true,
            homepage: "https://gone.example/",
          }),
        },
        {
          "https://example.org/ok": { status: 200 },
          "https://gone.example/": { dns: false },
        },
      ),
    );
    expect(code).toBe(0);
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

describe("our own hostnames in shipped source", () => {
  /**
   * A different surface from the markdown above, and the one Kevin was bitten
   * by: `CloudLaneOptions.relayOrigin`'s doc comment named
   * `relay.byollm.cloud`, which has no DNS record, and that comment ships in
   * the published `.d.ts`. His team put it in every app's `.env.example`.
   *
   * These cases stage a `packages/` tree, because every case above stages a
   * workspace WITHOUT one — so two mutations on this scan survived until this
   * describe existed, which is the seam hiding the live path yet again.
   */
  const withSource = (files, world) => {
    /* The markdown half needs a link of its own: the emptiness guard is a
       claim about the prose reader, and a workspace with no prose links at
       all is the "the reader found nothing" third state, not a pass. */
    const { root, fixture } = stage(
      {
        "README.md": "see [the site](https://byo-llm.com)\n",
        "CONTRIBUTING.md": "nothing here\n",
      },
      { "https://byo-llm.com": { status: 200 }, ...world },
    );
    for (const [path, body] of Object.entries(files)) {
      const full = join(root, "packages", path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, body, "utf8");
    }
    return { root, fixture };
  };

  it("reports one of ours that does not resolve", () => {
    const { code, out } = run(
      withSource(
        {
          "server/src/cloud.ts": "/** e.g. `https://relay.byollm.cloud`. */\n",
        },
        { "https://relay.byollm.cloud": { dns: false } },
      ),
    );
    expect(code).toBe(1);
    expect(out).toContain("https://relay.byollm.cloud");
    expect(out).toContain("server/src/cloud.ts");
  });

  it("does not call an API host dead for answering 404 at its root", () => {
    /**
     * The false alarm this nearly shipped with. `hub.byollm.cloud` has no
     * index page — it answers `/readyz` and the endpoints a daemon calls, and
     * `404` at `/` is correct. Judging source hosts by STATUS reported it
     * dead in five files at once.
     *
     * A hostname in a type's example is something you configure, not a page
     * you visit, so "does this name exist" is the whole question.
     */
    const { code, out } = run(
      withSource(
        { "server/src/cloud.ts": "// https://hub.byollm.cloud\n" },
        { "https://hub.byollm.cloud": { status: 404 } },
      ),
    );
    expect(code).toBe(0);
    expect(out).not.toContain("DEAD");
  });

  it("ignores example hosts that are not ours", () => {
    /* Source is full of URLs that must not resolve. The code-fence rule that
       separates them in markdown has no equivalent here, so the narrowing to
       our own domains is what makes this safe to run on source at all. */
    const { code } = run(
      withSource(
        {
          "server/src/x.ts":
            "// https://your-app.com and https://your-relay.example\n",
        },
        {
          "https://your-app.com": { dns: false },
          "https://your-relay.example": { dns: false },
        },
      ),
    );
    expect(code).toBe(0);
  });

  it("does not let the source scan stand in for a broken prose reader", () => {
    /**
     * The emptiness guard says "the reader found nothing", and until this case
     * existed it counted the source scan too — so a mutation restoring that
     * spelling survived. A tree whose markdown extractor had broken would
     * report a clean run on the strength of an unrelated scan finding hosts in
     * `.ts` files. An unreadable answer is not a positive answer.
     */
    const { code, out } = run(
      (() => {
        const { root, fixture } = stage(
          { "README.md": "no links at all\n", "CONTRIBUTING.md": "nor here\n" },
          { "https://hub.byollm.cloud": { status: 200 } },
        );
        const full = join(root, "packages", "server", "src", "cloud.ts");
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, "// https://hub.byollm.cloud\n", "utf8");
        return { root, fixture };
      })(),
    );
    expect(code).toBe(2);
    expect(out).toContain("the reader found nothing");
  });

  it("does not read built output or tests, which are copies", () => {
    const { code } = run(
      withSource(
        {
          "server/dist/index.d.ts": "// https://gone.byollm.cloud\n",
          "server/src/a.test.ts": "// https://gone.byollm.cloud\n",
        },
        { "https://gone.byollm.cloud": { dns: false } },
      ),
    );
    expect(code).toBe(0);
  });
});

describe("whether the resolver is worth believing", () => {
  /**
   * Driven through the CLI with staged lookups, which is this directory's
   * shape — `bump-version.test.mjs` takes it and this file's own header says
   * so. The rule cannot be exported: `explicit-module-boundary-types` wants
   * TypeScript annotations a `.mjs` cannot carry, and JSDoc does not satisfy
   * it. So the fixture supplies what each probe did and the script runs its
   * real `observe` and `resolverVerdict` over it.
   *
   * The first version short-circuited in the fixture before both, and a
   * mutation trusting a resolver that invents names survived every case. The
   * seam hid the live path for the third time in this file.
   */
  const page =
    "# t\n\nsee [a](https://example.org/a) and [b](https://gone.example)\n";
  const world = (probes) => ({
    "https://example.org/a": { status: 200 },
    "https://gone.example": { dns: false },
    __resolver: probes,
  });
  const verdict = (probes) =>
    run(stage({ "README.md": page, "CONTRIBUTING.md": "x\n" }, world(probes)));

  it("believes a resolver that answers and admits what it cannot find", () => {
    const { code, out } = verdict({ good: ["1.1.1.1"], bogus: "ENOTFOUND" });
    expect(code).toBe(1);
    expect(out).toContain("DEAD");
  });

  it("does not believe one that cannot resolve a name it should know", () => {
    /* No DNS at all, or an allowlist excluding even the control. Its
       not-founds are about the network, not about anybody's links. */
    for (const good of ["ENOTFOUND", "ETIMEDOUT"]) {
      const { out } = verdict({ good, bogus: "ENOTFOUND" });
      expect(out, `trusted a resolver whose control ${good}`).not.toContain(
        "DEAD",
      );
    }
  });

  it("does not believe one that answers for a name that cannot exist", () => {
    /**
     * A sinkhole or a wildcard, and the case the old fixture could never
     * reach: such a resolver never says not-found, so every link reads as
     * alive. The checker goes quiet rather than loud, which is the failure
     * nobody notices.
     */
    const { out } = verdict({ good: ["1.1.1.1"], bogus: ["10.0.0.1"] });
    expect(out).not.toContain("DEAD");
    expect(out).toMatch(/NOT ANSWERING FAITHFULLY/u);
  });

  it("does not read a timeout as an admission", () => {
    /* A timeout on the bogus probe is not a not-found. Treating it as one
       would trust a resolver that had told us nothing. */
    const { out } = verdict({ good: ["1.1.1.1"], bogus: "ETIMEDOUT" });
    expect(out).not.toContain("DEAD");
  });

  it("does not read an empty answer as an address", () => {
    /* `resolve4` can return an empty array. That names nothing and is not an
       error, and reading it as an answer would trust a mute resolver. */
    const { out } = verdict({ good: [], bogus: "ENOTFOUND" });
    expect(out).not.toContain("DEAD");
  });
});

describe("the instrument, before the finding", () => {
  /**
   * **Every dead-name verdict here is a claim about the world made from inside
   * one machine's network**, and CW was right to say so.
   *
   * I reported `oftomorrow.press` as having no records an hour after two
   * people had loaded it in a browser. My control was that another domain
   * resolved through the same resolver — which proves *some* names resolve,
   * not that none are being withheld. A resolver behind an allowlist looks
   * exactly like a dead name, and this script would have printed the same
   * sentence either way.
   *
   * So a dead verdict is now gated on the resolver answering faithfully: a
   * known-good name resolves, and a name that cannot exist does not. Fail
   * either and nothing is called dead — the instrument is what is broken, and
   * "unproven" is a third state rather than a synonym for "fine".
   *
   * It does not prove the resolver is unfiltered; a filter that faithfully
   * proxied a zone and hid one record type would pass. It rules out the
   * ordinary shapes, and what is left is said in the output rather than
   * hidden.
   */
  const world = (over) => ({
    "https://example.org/a": { status: 200 },
    "https://gone.example": { dns: false },
    ...over,
  });

  const page =
    "# t\n\nsee [a](https://example.org/a) and [b](https://gone.example)\n";

  it("reports a dead name when the resolver is sound", () => {
    /* The control, and the one that matters: the gate must not swallow real
       findings. Without this the whole thing could hard-code "unjudged". */
    const { code, out } = run(
      stage({ "README.md": page, "CONTRIBUTING.md": "x\n" }, world()),
    );
    expect(code).toBe(1);
    expect(out).toContain("https://gone.example");
    expect(out).toContain("DEAD");
  });

  it("calls nothing dead when the resolver is not answering faithfully", () => {
    const { code, out } = run(
      stage(
        { "README.md": page, "CONTRIBUTING.md": "x\n" },
        world({ __resolver: "broken" }),
      ),
    );
    expect(code).not.toBe(1);
    expect(out).not.toContain("DEAD");
  });

  it("says the instrument is why, rather than saying nothing", () => {
    /**
     * A run that quietly reported no dead links would be worse than one that
     * reported the wrong ones: the person reading it concludes the tree is
     * clean. The sentence has to name the resolver and say where to go next.
     */
    const { out } = run(
      stage(
        { "README.md": page, "CONTRIBUTING.md": "x\n" },
        world({ __resolver: "broken" }),
      ),
    );
    expect(out).toMatch(/NOT ANSWERING FAITHFULLY/u);
    expect(out).toMatch(/Run it somewhere else/u);
  });

  it("still names the links it could not judge", () => {
    /* Demoted, not dropped. A name that would have been called dead is still
       listed — as unjudged, with the reason — so nobody has to diff two runs
       to find out what changed. */
    const { out } = run(
      stage(
        { "README.md": page, "CONTRIBUTING.md": "x\n" },
        world({ __resolver: "broken" }),
      ),
    );
    expect(out).toContain("https://gone.example");
    expect(out).toMatch(/not answering faithfully/u);
  });
});
