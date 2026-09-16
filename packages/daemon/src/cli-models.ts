import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BackendId } from "@byollm/protocol";

/**
 * What a vendor CLI can tell us about the models it has — B218.
 *
 * Todd, on the real box, at B211's new prompt: *"I have no idea how to answer
 * since I don't know what codex has and it doesn't show me."* The prompt was
 * honest and still handed a person a question the machine was better placed
 * to answer — `gpt-5.6-terra` was sitting in a file on that disk the whole
 * time.
 *
 * ## Suggestions, never a validator
 *
 * Everything here is a hint for a picker. Free text stays, and an answer that
 * appears in no list is still accepted, because B211's whole lesson is that
 * the model namespace moves faster than our releases. A list that could
 * REFUSE a name would be the stale hardcoded offer again, wearing a nicer
 * coat.
 *
 * ## Reads files. Never runs a CLI.
 *
 * No inference (that spends), and no sub-invocation of a vendor binary (a
 * prompt inside a non-interactive context is a hang — B213). **Measured
 * hazard, 09-16:** `codex models`, `codex list` and `codex model` are not
 * subcommands, and codex answers an unknown one with *"options will be
 * forwarded to the interactive CLI"* — so a probe that guesses a verb starts
 * an interactive session. Read the file; never guess.
 *
 * ## The two CLIs are not symmetrical, and the difference is the point
 *
 * **codex** keeps `~/.codex/models_cache.json` — a real list, with
 * `visibility` ("list" or "hide") and `priority` already in it, so the picker
 * is the vendor's own idea of what to show and in what order.
 *
 * **claude** keeps no list at all, and that is the RIGHT answer rather than a
 * gap. Its `--model` help says: *"Provide an alias for the latest model (e.g.
 * 'fable', 'opus', or 'sonnet')"*. **An alias cannot go stale**, which is
 * exactly the failure B211 exists to stop — so we offer aliases and
 * deliberately do not build a versioned list we would have to chase.
 */

export interface ModelSuggestion {
  /** What gets written to the config if chosen. */
  readonly id: string;
  /** Shown beside it. The vendor's words where we have them. */
  readonly note?: string;
}

/** Claude's own documented aliases, which track the latest model. */
export const CLAUDE_ALIASES: readonly ModelSuggestion[] = [
  { id: "opus", note: "most capable" },
  { id: "sonnet", note: "balanced" },
  { id: "fable", note: "fastest" },
];

/** Read and parse, or undefined. Absence is normal and is not an error. */
async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    /* Missing, unreadable, or not JSON. A fresh install has no cache, a
       different account has no settings, and neither is worth a word on
       screen — the prompt below still works without us. */
    return undefined;
  }
}

/** The shape this reads out of codex's cache, and nothing more. */
interface CachedModel {
  readonly slug?: unknown;
  readonly display_name?: unknown;
  readonly description?: unknown;
  readonly visibility?: unknown;
  readonly priority?: unknown;
}

function codexSuggestions(cache: unknown): ModelSuggestion[] {
  if (typeof cache !== "object" || cache === null) return [];
  const models = (cache as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];

  const listed = models
    .filter((m): m is CachedModel => typeof m === "object" && m !== null)
    /* `visibility` is the vendor's own answer to "should a person see this".
       `gpt-reserve` and `codex-auto-review` are marked `hide`, and offering
       either would be us showing internals as choices. Anything not
       explicitly `list` is left out: an unknown value is not a yes. */
    .filter((m) => m.visibility === "list")
    .filter(
      (m): m is CachedModel & { slug: string } => typeof m.slug === "string",
    );

  /* The vendor's ordering, kept. Lower priority first — on the machine this
     was read from, that put `gpt-5.6-terra` at the top, which is the model
     Todd typed by hand. */
  listed.sort((a, b) => {
    const left =
      typeof a.priority === "number" ? a.priority : Number.MAX_SAFE_INTEGER;
    const right =
      typeof b.priority === "number" ? b.priority : Number.MAX_SAFE_INTEGER;
    return left - right;
  });

  return listed.map((m) => ({
    id: m.slug,
    ...(typeof m.description === "string" && m.description !== ""
      ? { note: m.description }
      : typeof m.display_name === "string"
        ? { note: m.display_name }
        : {}),
  }));
}

async function claudeSuggestions(home: string): Promise<ModelSuggestion[]> {
  const settings = await readJson(join(home, ".claude", "settings.json"));
  const configured =
    typeof settings === "object" && settings !== null
      ? (settings as { model?: unknown }).model
      : undefined;

  const out: ModelSuggestion[] = [];
  if (typeof configured === "string" && configured !== "") {
    out.push({ id: configured, note: "what claude is set to use" });
  }
  for (const alias of CLAUDE_ALIASES) {
    // The configured value may BE an alias, or an alias with a suffix
    // (`opus[1m]`). Either way it is already offered above, and offering it
    // twice would read as two different answers.
    if (out.some((s) => s.id === alias.id || s.id.startsWith(`${alias.id}[`))) {
      continue;
    }
    out.push(alias);
  }
  return out;
}

/**
 * What to offer for this CLI. Empty is a perfectly good answer — the caller
 * falls through to the free-text prompt that existed before any of this.
 */
export async function modelSuggestions(
  cli: BackendId,
  home: string = homedir(),
): Promise<readonly ModelSuggestion[]> {
  if (cli === "codex-cli") {
    return codexSuggestions(
      await readJson(join(home, ".codex", "models_cache.json")),
    );
  }
  if (cli === "claude-cli") return claudeSuggestions(home);
  return [];
}
