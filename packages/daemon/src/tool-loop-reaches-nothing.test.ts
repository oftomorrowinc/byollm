import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The tool loop has no way out of the process but the two it is handed —
 * TOOLS_RUN_AT_SITE, by the shape of the module (#7055).
 *
 * `tool-loop.ts` says its only exits are the backend (the owner's model
 * server) and the transport (the upstream the job came from). That is a claim
 * about imports, so it is checked on the imports: a later edit that reaches
 * for `node:child_process`, `node:fs`, `node:net` or a bare `fetch` to "help"
 * a declared tool along would have to get past this first.
 *
 * C034 checks the running daemon — no spawn, no socket but the model's. This
 * checks the module that would have to change for that to stop being true.
 */
const source = readFileSync(new URL("./tool-loop.ts", import.meta.url), "utf8");
const code = source
  .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
  .replaceAll(/^\s*\/\/.*$/gmu, "");

describe("the tool loop reaches nothing", () => {
  it("imports only randomness, the protocol and the backend's types", () => {
    const imports = [...code.matchAll(/from\s+"([^"]+)"/gu)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(new Set(imports)).toEqual(
      new Set(["node:crypto", "@byollm/protocol", "./backends/types.js"]),
    );
    // Types only from the backend module: no implementation comes with it.
    expect(code).toMatch(
      /import type \{[^}]*\} from "\.\/backends\/types\.js"/u,
    );
  });

  it("names no process, file, socket or network API", () => {
    for (const reach of [
      /\bfetch\s*\(/u,
      /\bspawn\w*\s*\(/u,
      /\bexec\w*\s*\(/u,
      /\bimport\s*\(/u,
      /\brequire\s*\(/u,
      /\bprocess\./u,
      /\bglobalThis\b/u,
      /\beval\s*\(/u,
      /\bnew Function\b/u,
    ]) {
      expect(code, String(reach)).not.toMatch(reach);
    }
  });
});
