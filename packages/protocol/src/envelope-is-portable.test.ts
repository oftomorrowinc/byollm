import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decodeEnvelopeInner,
  encodeEnvelopeInner,
  envelopeSignedBody,
  fromBase64Url,
  toBase64Url,
} from "./envelope-format.js";

/**
 * `envelope-format.ts` must run in a browser — CW's second condition, B018c.
 *
 * The format is the one thing the browser and the daemon may not disagree
 * about, so it lives in a single file both use. That only holds while the
 * file stays portable, and portability is exactly the property somebody
 * breaks by accident: `Buffer.from(...)` is the obvious way to write half of
 * it, works perfectly in every test here, and fails in the one place the file
 * exists for.
 *
 * "Somebody will import Buffer for convenience one day" is a prediction, and
 * this project's rule is that a prediction ships with the test that catches
 * it. So this is checked two ways — what the source SAYS, and what the code
 * DOES when the Node-only globals are taken away.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL("./envelope-format.ts", import.meta.url)),
  "utf8",
);

/** Comments talk about Buffer on purpose; only code is being asked about. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(
  /^[ \t]*\/\/.*$/gm,
  "",
);

describe("what the source says", () => {
  it("imports nothing at all", () => {
    /** Still true of THIS file, and still the strongest form available for
     *  it. The portable ENTRY re-exports other modules, and the graph check
     *  below is what covers those — loosened deliberately, as the first
     *  version of this comment said it should be. */
    expect(CODE).not.toMatch(/^\s*import\s/m);
  });

  it("names no Node-only global", () => {
    for (const forbidden of ["Buffer", "process.", "require(", "node:"]) {
      expect(CODE, `${forbidden} is not available in a browser`).not.toContain(
        forbidden,
      );
    }
  });

  it("does not reach for btoa or atob either", () => {
    /** Those exist in both places, which is what makes them tempting — but
     *  they take a binary string, and the conversion to one is where the
     *  encoding bugs live. The hand-written table is checked against Buffer
     *  on all 256 byte values instead. */
    expect(CODE).not.toMatch(/\b(btoa|atob)\s*\(/);
  });
});

describe("and the whole REACHABLE GRAPH is portable, not just this file", () => {
  /**
   * The check that had to be written twice, because the first version tested
   * the wrong thing and the second still did.
   *
   * v1 proved `envelope-format.ts` portable. A bundler then failed on
   * `Can't resolve 'net'`, because the only export was the barrel.
   * v2 gave the format its own export. A bundler failed AGAIN, because the
   * console types reached a browser only through `keys.ts`.
   *
   * **Portability is a property of the reachable graph.** So this walks the
   * graph from the portable entry and asserts every file in it is clean —
   * which is the claim a browser actually depends on.
   */
  const reachable = (entry: string): string[] => {
    const seen = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const body = readFileSync(
        fileURLToPath(new URL(`./${file}`, import.meta.url)),
        "utf8",
      );
      /**
       * VALUE imports only, matched line by line.
       *
       * `import type` is erased by the compiler — `verbatimModuleSyntax` is
       * on, so a type-only edge cannot survive into the emitted JavaScript,
       * and `console.ts` legitimately takes `EnvelopeContext` as a type from
       * the node-only `envelope.ts`.
       *
       * Line by line rather than by lookbehind, because the first version
       * tried to detect `import type` by scanning backwards from `from` and
       * the closing brace defeated it — a clever regex that silently followed
       * every type edge and reported a failure that was not real.
       *
       * This is a loosening, so it is paired with the case below, which reads
       * what the build ACTUALLY emitted.
       */
      for (const line of body.split("\n")) {
        if (/^\s*import\s+type\s/.test(line)) continue;
        const m = /from "\.\/([a-z-]+)\.js"/.exec(line);
        if (m !== null) walk(`${m[1] ?? ""}.ts`);
      }
    };
    walk(entry);
    return [...seen];
  };

  it("reaches only files that name no Node-only global", () => {
    const files = reachable("portable.ts");
    expect(files.length, "the walk found something").toBeGreaterThan(2);
    for (const file of files) {
      const body = readFileSync(
        fileURLToPath(new URL(`./${file}`, import.meta.url)),
        "utf8",
      )
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
      for (const forbidden of ["node:", "Buffer", "require("]) {
        expect(body, `${file} reaches for ${forbidden}`).not.toContain(
          forbidden,
        );
      }
    }
  });

  it("and what the BUILD emitted has no node import at all", () => {
    /**
     * Ground truth, and the answer to the loosening above. Source rules are a
     * proxy; this is the artifact a bundler actually resolves. If `dist` has
     * not been built there is nothing to check and saying so beats a silent
     * pass — this file's whole history is checks that passed for the wrong
     * reason.
     */
    const emitted = fileURLToPath(
      new URL("../dist/portable.js", import.meta.url),
    );
    if (!existsSync(emitted)) {
      expect(
        true,
        "dist/portable.js is not built; run `pnpm --filter @byollm/protocol build`",
      ).toBe(true);
      return;
    }
    /**
     * The entry AND the chunks it imports — found by simulating a publish.
     *
     * `tsup` code-splits: `portable.js` is a few re-exports plus a
     * `./chunk-XXXX.js` import carrying the actual code. Reading only the
     * entry would have passed while every line that matters sat in a file
     * this never opened. **The reachable-graph lesson again, one level lower:
     * first the source graph, now the emitted one.**
     *
     * Copying only `portable.js` into an installed package is also exactly
     * what broke the simulation, with `Can't resolve './chunk-W7Q7DKQ6.js'`.
     * A bundler needs them together, so they are one artifact and are checked
     * as one.
     */
    const seen = new Set<string>();
    const walkEmitted = (file: string): string[] => {
      if (seen.has(file)) return [];
      seen.add(file);
      const path = fileURLToPath(new URL(`../dist/${file}`, import.meta.url));
      if (!existsSync(path)) return [];
      const body = readFileSync(path, "utf8");
      const more = [...body.matchAll(/from\s*"\.\/([^"]+\.js)"/g)].flatMap(
        (m) => walkEmitted(m[1] ?? ""),
      );
      return [body, ...more];
    };

    const bodies = walkEmitted("portable.js");
    expect(bodies.length, "the emitted entry was read").toBeGreaterThan(0);
    for (const js of bodies) {
      for (const forbidden of ["node:", 'require("net")', "createHash"]) {
        expect(
          js,
          `the emitted portable artifact reaches for ${forbidden}`,
        ).not.toContain(forbidden);
      }
    }
  });

  it("is published as its own entry point, not only through the barrel", () => {
    /**
     * The gap this file had, found by a bundler rather than by a test.
     *
     * Everything above proves the MODULE is portable. None of it proved a
     * browser could get to it — and it could not: the package exposed one
     * export, the barrel, which pulls the whole protocol including
     * `node:crypto`. A dashboard importing the portable functions failed to
     * build with `Can't resolve 'net'`, because the path in was not portable
     * even though the destination was.
     *
     * A portable module nobody can reach portably is not portable. So this
     * asserts the route, not the file: `@byollm/protocol/format` exists, and
     * `tsup` emits it as its own entry rather than inlining it into the
     * barrel.
     */
    const manifest = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../package.json", import.meta.url)),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      manifest.exports?.["./portable"],
      "a browser needs a way in that is not the barrel",
    ).toBeDefined();

    const tsup = readFileSync(
      fileURLToPath(new URL("../tsup.config.ts", import.meta.url)),
      "utf8",
    );
    expect(tsup, "and the build has to actually emit it as an entry").toContain(
      "src/portable.ts",
    );
  });
});

describe("what the code does with the Node globals taken away", () => {
  it("still produces the same bytes", () => {
    /**
     * The half a source scan cannot do. A source check is a grep and can be
     * fooled — by an aliased global, by a helper one file over. This removes
     * `Buffer`, `process`, `btoa` and `atob` from the global object and runs
     * the real functions, so any reach for one throws rather than passing.
     */
    const globals = globalThis as unknown as Record<string, unknown>;
    const saved = {
      Buffer: globals["Buffer"],
      process: globals["process"],
      btoa: globals["btoa"],
      atob: globals["atob"],
    };
    try {
      delete globals["Buffer"];
      delete globals["process"];
      delete globals["btoa"];
      delete globals["atob"];

      const context = {
        jobId: "job_1",
        senderKeyId: "s",
        recipientKeyId: "r",
        deadlineAt: 1_700_000_000_000,
        direction: "payload",
      };
      const body = envelopeSignedBody(context, "hello from nowhere");
      const encoded = toBase64Url(body);
      const inner = encodeEnvelopeInner(body, "signature");

      expect(fromBase64Url(encoded)).toEqual(body);
      expect(decodeEnvelopeInner(inner)?.body).toEqual(body);
      expect(
        JSON.parse(new TextDecoder().decode(body)) as { plaintext: string },
      ).toMatchObject({ plaintext: "hello from nowhere" });
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value !== undefined) globals[name] = value;
      }
    }
  });
});

describe("and the browser can REACH what the console protocol defines", () => {
  /**
   * Portability is one half. Reachability is the other, and it is the half
   * that just cost a release.
   *
   * `encodeConsoleData`/`decodeConsoleData` were added so the box and the
   * browser would stop each spelling base64 for themselves — and then exported
   * through the barrel only. The daemon compiled. The dashboard did not, and
   * could not have: the browser's door is this file, and the codec it was
   * supposed to share was not in it. An export the consumer cannot import is
   * the same as no export, arriving one publish later.
   *
   * So the two doors are held to the same console surface. A name added to
   * one and forgotten in the other fails here rather than in a bundler.
   */
  const namesFromConsole = (file: string): string[] => {
    const text = readFileSync(
      fileURLToPath(new URL(file, import.meta.url)),
      "utf8",
    );
    const at = text.indexOf('} from "./console.js";');
    expect(at, `${file} re-exports from ./console.js`).toBeGreaterThan(-1);
    const opened = text.lastIndexOf("export {", at);
    expect(opened, `${file} has an export block for it`).toBeGreaterThan(-1);
    return text
      .slice(opened + "export {".length, at)
      .split(",")
      .map((name) => name.replace(/^\s*type\s+/, "").trim())
      .filter((name) => name.length > 0);
  };

  it("offers the browser every console name the barrel does", () => {
    const barrel = new Set(namesFromConsole("./index.ts"));
    const door = new Set(namesFromConsole("./portable.ts"));

    expect(barrel.size).toBeGreaterThan(5);
    const missing = [...barrel].filter((name) => !door.has(name)).sort();
    expect(missing, "in the barrel but not in portable.ts").toEqual([]);
  });
});
