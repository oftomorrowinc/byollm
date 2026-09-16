import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAUDE_ALIASES, modelSuggestions } from "./cli-models.js";

/**
 * What each vendor CLI can tell us — B218, against fixtures shaped like the
 * real files read from Todd's Mac on 2026-09-16.
 */

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), "byollm-cli-models-"));
}

/** The real cache's shape, trimmed to the fields this reads. */
const cache = (models: unknown[]) =>
  JSON.stringify({
    fetched_at: "2026-09-14T23:38:09.678754Z",
    client_version: "0.149.1",
    models,
  });

const REAL = [
  {
    slug: "gpt-reserve",
    visibility: "hide",
    priority: 3,
    description: "Fast and affordable agentic coding model.",
  },
  {
    slug: "gpt-5.6-terra",
    visibility: "list",
    priority: 7,
    description: "Balanced agentic coding model for everyday work.",
  },
  {
    slug: "gpt-5.6-luna",
    visibility: "list",
    priority: 8,
    description: "Fast and affordable agentic coding model.",
  },
  {
    slug: "gpt-5.5",
    visibility: "list",
    priority: 12,
    description:
      "Proven previous-generation model for coding and general work.",
  },
  {
    slug: "codex-auto-review",
    visibility: "hide",
    priority: 43,
    description: "Automatic approval review model for Codex.",
  },
];

async function withCodex(models: unknown[]): Promise<string> {
  const dir = await home();
  await mkdir(join(dir, ".codex"), { recursive: true });
  await writeFile(
    join(dir, ".codex", "models_cache.json"),
    cache(models),
    "utf8",
  );
  return dir;
}

describe("codex, whose cache is a real list", () => {
  it("offers what the vendor marks visible, in the vendor's order", async () => {
    /**
     * The exact five from the machine. `gpt-5.6-terra` comes first — which is
     * the model Todd typed by hand while the file sat there saying so.
     */
    const dir = await withCodex(REAL);
    expect((await modelSuggestions("codex-cli", dir)).map((s) => s.id)).toEqual(
      ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
    );
  });

  it("hides what the vendor hides, rather than showing internals as choices", async () => {
    const dir = await withCodex(REAL);
    const ids = (await modelSuggestions("codex-cli", dir)).map((s) => s.id);
    expect(ids).not.toContain("codex-auto-review");
    expect(ids).not.toContain("gpt-reserve");
  });

  it("treats an UNKNOWN visibility as hide, not as show", async () => {
    /** A value we have never seen is not a yes. If the vendor adds
     *  `visibility: "beta"` tomorrow, a person should not meet it here
     *  first. */
    const dir = await withCodex([
      { slug: "surprise", visibility: "beta", priority: 1 },
      { slug: "gpt-5.5", visibility: "list", priority: 12 },
    ]);
    expect((await modelSuggestions("codex-cli", dir)).map((s) => s.id)).toEqual(
      ["gpt-5.5"],
    );
  });

  it("carries the vendor's own description through", async () => {
    const dir = await withCodex(REAL);
    const [first] = await modelSuggestions("codex-cli", dir);
    expect(first?.note).toBe(
      "Balanced agentic coding model for everyday work.",
    );
  });

  it("is EMPTY when there is no cache, which is a fresh install", async () => {
    /** Absence is normal and must not be an error — the caller falls through
     *  to the free-text prompt that existed before any of this. */
    expect(await modelSuggestions("codex-cli", await home())).toEqual([]);
  });

  it("is empty rather than throwing on a corrupt cache", async () => {
    const dir = await home();
    await mkdir(join(dir, ".codex"), { recursive: true });
    await writeFile(
      join(dir, ".codex", "models_cache.json"),
      "{not json",
      "utf8",
    );
    expect(await modelSuggestions("codex-cli", dir)).toEqual([]);
  });

  it("survives a cache whose shape moved under us", async () => {
    /** It is an undocumented internal file. It WILL change one day, and the
     *  prompt must degrade to free text rather than break. */
    const dir = await home();
    await mkdir(join(dir, ".codex"), { recursive: true });
    for (const body of [
      '{"models":"not an array"}',
      "{}",
      "[]",
      '{"models":[1,2]}',
    ]) {
      await writeFile(join(dir, ".codex", "models_cache.json"), body, "utf8");
      expect(await modelSuggestions("codex-cli", dir)).toEqual([]);
    }
  });
});

describe("claude, which has no list and should not get one", () => {
  it("offers the ALIASES, because an alias cannot go stale", async () => {
    /**
     * `--model`'s own help: "Provide an alias for the latest model (e.g.
     * 'fable', 'opus', or 'sonnet')". Building a versioned list for claude
     * would be re-creating the exact staleness B211 removed.
     */
    const ids = (await modelSuggestions("claude-cli", await home())).map(
      (s) => s.id,
    );
    expect(ids).toEqual(CLAUDE_ALIASES.map((a) => a.id));
  });

  it("puts the configured model first, marked as what claude uses", async () => {
    const dir = await home();
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ model: "opus[1m]" }),
      "utf8",
    );
    const suggestions = await modelSuggestions("claude-cli", dir);
    expect(suggestions[0]).toEqual({
      id: "opus[1m]",
      note: "what claude is set to use",
    });
  });

  it("does not offer the same alias twice when it IS the configured one", async () => {
    /** `opus[1m]` is `opus` with a suffix. Listing both would read as two
     *  different answers to one question. */
    const dir = await home();
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ model: "opus[1m]" }),
      "utf8",
    );
    const ids = (await modelSuggestions("claude-cli", dir)).map((s) => s.id);
    expect(ids).toEqual(["opus[1m]", "sonnet", "fable"]);
  });

  it("ignores a settings file with no model in it", async () => {
    const dir = await home();
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ somethingElse: true }),
      "utf8",
    );
    expect(
      (await modelSuggestions("claude-cli", dir)).map((s) => s.id),
    ).toEqual(CLAUDE_ALIASES.map((a) => a.id));
  });
});

describe("every other backend", () => {
  it("offers nothing, and says so by being empty", async () => {
    expect(await modelSuggestions("ollama", await home())).toEqual([]);
    expect(await modelSuggestions("anthropic", await home())).toEqual([]);
  });
});
