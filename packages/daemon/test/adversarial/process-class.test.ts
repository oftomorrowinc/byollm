import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ClaudeCliBackend, claudeArgv } from "../../src/backends/claude-cli.js";
import { PROCESS_CORPUS } from "./corpus.js";

/**
 * byollm_004 §5 — the process-class corpus.
 *
 * The claim under test is exact: **the payload reached the model verbatim and
 * changed nothing else.** Asserting that requires seeing what actually crossed
 * the spawn boundary, so these tests run a probe binary that reports its own
 * argv, environment, cwd and stdin instead of the real CLI.
 *
 * A failure here blocks publish.
 */

const PROBE = fileURLToPath(new URL("./probe-backend.mjs", import.meta.url));
const MODEL = "claude-opus-5";

/** Exactly what {@link childEnv} sets. */
const ALLOWED_ENV = new Set([
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "CI",
]);

/**
 * Variables the operating system injects into every child regardless of the
 * environment we hand to `spawn`.
 *
 * byollm_004 §2 says to drop further "where the OS allows" and to document
 * rather than make a false promise where it cannot. macOS adds
 * `__CF_USER_TEXT_ENCODING` at the CoreFoundation layer, below anything a
 * process can control. It carries a uid and a locale, no secret, and it is
 * listed here — and in `docs/security.md` — rather than quietly filtered out
 * of the assertion.
 */
const OS_INJECTED = new Set(["__CF_USER_TEXT_ENCODING"]);

interface ProbeReport {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: string;
}

async function run(
  prompt: string,
  options: {
    maxOutputBytes?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<
  | { ok: true; report: ProbeReport }
  | { ok: false; code: string; message: string }
> {
  await chmod(PROBE, 0o755);
  const backend = new ClaudeCliBackend(PROBE);
  const result = await backend.execute({
    prompt,
    model: MODEL,
    timeoutMs: options.timeoutMs ?? 20_000,
    maxOutputBytes: options.maxOutputBytes ?? 4 * 1024 * 1024,
    signal: options.signal ?? new AbortController().signal,
  });
  if (!result.ok)
    return { ok: false, code: result.code, message: result.message };
  return { ok: true, report: JSON.parse(result.text) as ProbeReport };
}

describe("process-class corpus [NO_SHELL_INTERPOLATION, NO_PAYLOAD_ROUTING]", () => {
  for (const hostile of PROCESS_CORPUS) {
    // Size rows are asserted separately — a 1 MB payload through a JSON
    // round-trip is slow enough to be worth isolating.
    if (hostile.id.startsWith("SIZE_")) continue;

    it(`${hostile.id}: ${hostile.threat} — reaches the model verbatim, changes nothing`, async () => {
      const result = await run(hostile.prompt);
      expect(result.ok, result.ok ? "" : result.message).toBe(true);
      if (!result.ok) return;
      const { report } = result;

      // 1. The payload arrived on stdin, byte for byte.
      expect(report.stdin).toBe(hostile.prompt);

      // 2. The argv is *exactly* the fixed one — same elements, same order,
      //    same length. That equality is the whole proof: if no element of
      //    the payload can add, remove or alter an argument, then payload
      //    text cannot reach a command line at all.
      //
      //    (Deliberately not "no argv element appears in the payload": a
      //    payload is free to contain the string "--print", and finding it
      //    there says nothing about whether it was passed as an argument.)
      expect(report.argv).toEqual([...claudeArgv(MODEL)]);

      // 3. The model is the one the owner configured, whatever the payload
      //    tried to say about it.
      expect(report.argv[report.argv.indexOf("--model") + 1]).toBe(MODEL);

      // 4. Tools are off and MCP is empty, whatever the payload asked for.
      expect(report.argv[report.argv.indexOf("--tools") + 1]).toBe("");
      expect(report.argv).toContain("--strict-mcp-config");
      expect(report.argv[report.argv.indexOf("--mcp-config") + 1]).toBe(
        '{"mcpServers":{}}',
      );
      expect(report.argv).not.toContain("--dangerously-skip-permissions");
      expect(report.argv).not.toContain("--add-dir");
      expect(report.argv).not.toContain("--settings");

      // 5. The environment holds the allowlist and nothing else we control.
      expect(report.env["ANTHROPIC_API_KEY"]).toBeUndefined();
      expect(report.env["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
      const unexpected = Object.keys(report.env).filter(
        (name) => !ALLOWED_ENV.has(name) && !OS_INJECTED.has(name),
      );
      expect(unexpected).toEqual([]);

      // 6. The working directory is a scratch dir, not the daemon's and not
      //    anything the payload named.
      expect(report.cwd).not.toBe(process.cwd());
      expect(report.cwd).toMatch(/byollm-job-/);
    });
  }

  it("SIZE_LARGE_PAYLOAD: 1 MB of junk arrives intact and changes nothing", async () => {
    const prompt = "A".repeat(1_000_000);
    const result = await run(prompt);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.stdin).toHaveLength(1_000_000);
    expect(result.report.argv).toEqual([...claudeArgv(MODEL)]);
  });

  it("SIZE_MANY_NEWLINES: newline-heavy input does not split into arguments", async () => {
    const prompt = `start\n${"\n".repeat(100_000)}end`;
    const result = await run(prompt);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.stdin).toBe(prompt);
    expect(result.report.argv).toHaveLength(claudeArgv(MODEL).length);
  });
});

describe("process-class resource ceilings [STRIPPED_CHILD_ENV]", () => {
  it("kills a child whose output exceeds the cap", async () => {
    // byollm_004 §5's zip-bomb row: a hostile or simply broken local model
    // must not be able to exhaust the machine's memory. The cap is enforced
    // on the stream, so nothing past it is ever buffered.
    const result = await run("hello", { maxOutputBytes: 8 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("output-too-large");
  });

  it("kills a child that exceeds its wall-clock budget", async () => {
    // A hung child must not be able to hold a lease open indefinitely.
    const backend = new ClaudeCliBackend(
      fileURLToPath(new URL("./probe-hang.mjs", import.meta.url)),
    );
    const result = await backend.execute({
      prompt: "hello",
      model: MODEL,
      timeoutMs: 1_000,
      maxOutputBytes: 1024,
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("timeout");
  });

  it("aborts in flight when the job is canceled [CANCEL_HONORED]", async () => {
    const backend = new ClaudeCliBackend(
      fileURLToPath(new URL("./probe-hang.mjs", import.meta.url)),
    );
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 200);

    const result = await backend.execute({
      prompt: "hello",
      model: MODEL,
      timeoutMs: 30_000,
      maxOutputBytes: 1024,
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("canceled");
  });

  it("reports a missing binary rather than throwing", async () => {
    const backend = new ClaudeCliBackend("/nonexistent/byollm-not-a-binary");
    const result = await backend.execute({
      prompt: "hello",
      model: MODEL,
      timeoutMs: 5_000,
      maxOutputBytes: 1024,
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("backend-unreachable");
  });
});
