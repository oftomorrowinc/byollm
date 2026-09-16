import { readFileSync } from "node:fs";
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
    /** The strongest form available, and true today: this file has no
     *  imports. A future import of another portable module would be fine —
     *  loosen this then, deliberately, rather than discovering it is loose. */
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

describe("and it is REACHABLE portably, which is a different claim", () => {
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
      manifest.exports?.["./format"],
      "a browser needs a way in that is not the barrel",
    ).toBeDefined();

    const tsup = readFileSync(
      fileURLToPath(new URL("../tsup.config.ts", import.meta.url)),
      "utf8",
    );
    expect(tsup, "and the build has to actually emit it as an entry").toContain(
      "src/envelope-format.ts",
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
