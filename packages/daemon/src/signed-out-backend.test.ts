import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ClaudeCliBackend } from "./backends/claude-cli.js";

/**
 * The wiring, not the predicate — 2026-08-25.
 *
 * `isAuthFailure` has its own corpus, and a mutation proved that corpus does
 * not cover the branch that *uses* it: replacing the call with `false` left
 * every test passing. A perfect predicate wired to nothing is the shape of
 * this week's other bugs, so the branch gets its own child process.
 *
 * The stand-in behaves the way the real CLI did on Todd's Mac: `--version`
 * succeeds without credentials — which is why the health check reported
 * healthy — and a real prompt prints prose on stdout and exits 1.
 */
const SIGNED_OUT = `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("1.2.3"); process.exit(0); }
process.stdout.write("Not logged in \\u00b7 Please run /login\\n");
process.exit(1);
`;

describe("a process backend whose credentials have gone", () => {
  it("reports unauthorized, while its health check still says healthy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "byollm-signedout-"));
    const binary = join(dir, "fake-claude.mjs");
    await writeFile(binary, SIGNED_OUT, "utf8");
    await chmod(binary, 0o755);

    const backend = new ClaudeCliBackend(binary);

    // The gap, stated: the probe cannot see this.
    expect((await backend.health()).healthy).toBe(true);

    const result = await backend.execute({
      model: "claude-opus-5",
      prompt: "say hi",
      timeoutMs: 20_000,
      maxOutputBytes: 4096,
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // `backend-error` is what this was before, and it is the code the runner
      // does nothing about.
      expect(result.code).toBe("unauthorized");
      expect(result.message).toContain("not signed in");
    }
  });
});
