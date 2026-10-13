import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type LiveCanaryMode,
  type Run,
  liveCanaryMode,
  requireLeak,
  runControl,
  spawnCli,
} from "./live-canary.js";

/**
 * The live canaries' three outcomes, driven through the same spawn and the
 * same verdict the live rows use — against a fake CLI, so it runs everywhere
 * and costs nobody's plan. Job 888.
 *
 * The brief's two cases are the first two blocks: a codex usage-limit refusal
 * skips under `verify` and fails under the release gate; a model that answers
 * without the canary fails under both. The rest are the ways those two could
 * be confused for each other.
 */

const FAKE = fileURLToPath(new URL("./provider-refuses.mjs", import.meta.url));
const CANARY = "CANARY-FAKE-888";
/** Before the fixture's Oct 28 — the corpus drops a "try again at" already past. */
const NOW = Date.parse("2026-10-13T12:00:00");

let dir: string;
let marker: string;
let attempts: number;
let stderr: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-live-canary-"));
  marker = join(dir, ".live-canary-skipped");
  attempts = 0;
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function fake(mode: string): () => Promise<Run> {
  return () => {
    attempts += 1;
    return spawnCli(process.execPath, [FAKE, mode, CANARY], "read the file");
  };
}

/** Settle a control the way a live row does; report what happened to the test. */
async function settle(
  provider: "claude" | "codex",
  mode: string,
  canaryMode: LiveCanaryMode,
): Promise<{ skipped?: string; failed?: string }> {
  const verdict = await runControl(provider, CANARY, fake(mode), () => NOW);
  let skipped: string | undefined;
  try {
    requireLeak(
      verdict,
      "the fake canary",
      "INCONCLUSIVE",
      { skip: (note) => (skipped = note) },
      canaryMode,
      marker,
    );
  } catch (error) {
    return { failed: String(error) };
  }
  return skipped === undefined ? {} : { skipped };
}

describe("a provider refusing to serve [job 888]", () => {
  it("skips loudly under verify, naming the provider, its words and its date", async () => {
    const result = await settle("codex", "codex-usage-limit", "verify");
    expect(result.failed).toBeUndefined();
    expect(result.skipped).toBe(
      "live canary skipped: codex quota until 2026-10-28",
    );
    // One line the landing log carries…
    expect(readFileSync(marker, "utf8")).toBe(
      "live canary skipped: codex quota until 2026-10-28\n",
    );
    // …and one printed with the CLI's own sentence, which a skip reason alone
    // is not: some reporters never show it.
    const printed = stderr.join("");
    expect(printed).toMatch(
      /live canary skipped: codex quota until 2026-10-28/,
    );
    expect(printed).toMatch(/You've hit your usage limit/);
  });

  it("fails under the release gate, and writes no skip", async () => {
    const result = await settle("codex", "codex-usage-limit", "release-gate");
    expect(result.skipped).toBeUndefined();
    expect(result.failed).toMatch(/PROVIDER_UNAVAILABLE/);
    expect(result.failed).toMatch(/codex quota until 2026-10-28/);
    expect(existsSync(marker)).toBe(false);
  });

  it("does not retry a refusal — the quota will not lift between attempts", async () => {
    await settle("codex", "codex-usage-limit", "verify");
    expect(attempts).toBe(1);
  });

  it("reads claude's sign-in refusal on its non-zero exit", async () => {
    const verify = await settle("claude", "claude-not-logged-in", "verify");
    expect(verify.skipped).toBe(
      "live canary skipped: claude auth no retry date given",
    );
    const gate = await settle("claude", "claude-not-logged-in", "release-gate");
    expect(gate.failed).toMatch(/PROVIDER_UNAVAILABLE/);
  });

  it("writes each skip into the marker once, however many cases met it", async () => {
    await settle("codex", "codex-usage-limit", "verify");
    await settle("codex", "codex-usage-limit", "verify");
    expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
  });
});

describe("a model that answered without the canary [job 888]", () => {
  for (const canaryMode of ["verify", "release-gate"] as const) {
    it(`fails under ${canaryMode}`, async () => {
      const result = await settle("codex", "codex-answers", canaryMode);
      expect(result.skipped).toBeUndefined();
      expect(result.failed).toMatch(/INCONCLUSIVE/);
      expect(existsSync(marker)).toBe(false);
      // A model that will not read is retried; a refusal is not.
      expect(attempts).toBe(3);
    });
  }

  it("fails when the answer only TALKS about a usage limit", async () => {
    // The answer is never searched for refusal words. A model discussing
    // limits must not turn a failed control into a skip.
    const result = await settle(
      "codex",
      "codex-answers-about-limits",
      "verify",
    );
    expect(result.failed).toMatch(/INCONCLUSIVE/);
  });

  it("fails when claude's answer exits zero, whatever it says about sign-in", async () => {
    const result = await settle("claude", "claude-answers", "verify");
    expect(result.failed).toMatch(/INCONCLUSIVE/);
  });

  it("passes only when the control actually leaks", async () => {
    const result = await settle("codex", "codex-leaks", "release-gate");
    expect(result).toEqual({});
  });
});

describe("who sets the mode [job 888]", () => {
  const root = new URL("../../../../", import.meta.url);
  const read = (path: string) =>
    readFileSync(fileURLToPath(new URL(path, root)), "utf8");

  it("defaults to verify; only BYOLLM_RELEASE_GATE=1 is the gate", () => {
    expect(liveCanaryMode({})).toBe("verify");
    expect(liveCanaryMode({ BYOLLM_RELEASE_GATE: "0" })).toBe("verify");
    expect(liveCanaryMode({ BYOLLM_RELEASE_GATE: "1" })).toBe("release-gate");
  });

  it("is set by the release workflow and the three-OS CI run", () => {
    expect(read(".github/workflows/release.yml")).toMatch(
      /^\s+BYOLLM_RELEASE_GATE: "1"$/mu,
    );
    expect(read(".github/workflows/ci.yml")).toMatch(
      /^\s+BYOLLM_RELEASE_GATE: \$\{\{.*'1'.*\}\}$/mu,
    );
  });

  it("clears the marker before verify, carries it after, and tag.sh refuses it", () => {
    expect(read("scripts/verify.sh")).toMatch(
      /^rm -f \.live-canary-skipped$/mu,
    );
    expect(read("scripts/record-verified.mjs")).toMatch(
      /\.live-canary-skipped/u,
    );
    expect(read("scripts/tag.sh")).toMatch(/\.live-canary-skipped/u);
    expect(read(".gitignore")).toMatch(/^\.live-canary-skipped$/mu);
    expect(read("docs/releasing.md")).toMatch(
      /BYOLLM_RELEASE_GATE=1 pnpm run verify/u,
    );
  });
});
