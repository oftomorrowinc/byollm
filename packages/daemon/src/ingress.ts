import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Audience } from "@byollm/protocol";
import { z } from "zod";

/**
 * A prompt about to be executed.
 *
 * Written *before* the backend is called
 * ({@link MUSTS.INGRESS_LOGGED_BEFORE_EXECUTION}), so a job that wedges or
 * crashes the machine still leaves a record of what it was.
 */
export const PromptEntry = z
  .object({
    type: z.literal("prompt"),
    at: z.number().int().positive(),
    /** Origin of the server that sent the job. */
    origin: z.string().min(1),
    jobId: z.string().min(1),
    /**
     * Which site sent it — V1-3.
     *
     * A job id belongs to a site, so the log's own primary fact was ambiguous
     * the moment a machine served two of them: two lines saying `job_1` were
     * two different prompts, and nothing on the line said so. Optional
     * because lines written before this existed are still readable, and a
     * reader that refused them would be a meter that stops working when it
     * changes.
     */
    site: z.string().min(1).optional(),
    kind: z.string().min(1),
    audience: z.string().min(1),
    /** Who this prompt is *for* — which, for community work, is not you. */
    owner: z.string().min(1),
    backendId: z.string().min(1),
    backendClass: z.string().min(1),
    model: z.string().min(1),
    /** Always present, including after retention drops the text. */
    promptHash: z.string().length(64),
    promptChars: z.number().int().nonnegative(),
    /**
     * The prompt itself. Absent means "not retained" — distinct from an empty
     * prompt, which the protocol forbids anyway. Zero and unknown never look
     * alike.
     */
    prompt: z.string().optional(),
  })
  .strict();
export type PromptEntry = z.infer<typeof PromptEntry>;

/** How a job ended. A separate line, so the prompt line is never rewritten. */
export const OutcomeEntry = z
  .object({
    type: z.literal("outcome"),
    at: z.number().int().positive(),
    jobId: z.string().min(1),
    /** Which site's job — V1-3, same reason as the prompt line. */
    site: z.string().min(1).optional(),
    outcome: z.enum(["ok", "error", "canceled", "refused"]),
    /** Present for a job that ran; absent for one refused before execution. */
    durationMs: z.number().int().nonnegative().optional(),
    outputChars: z.number().int().nonnegative().optional(),
    /** Why, for `error` and `refused`. */
    detail: z.string().optional(),
  })
  .strict();
export type OutcomeEntry = z.infer<typeof OutcomeEntry>;

export const IngressEntry = z.discriminatedUnion("type", [
  PromptEntry,
  OutcomeEntry,
]);
export type IngressEntry = z.infer<typeof IngressEntry>;

export interface IngressOptions {
  readonly path: string;
  /** Days to keep a community prompt in full before reducing it to its hash. */
  readonly communityPromptDays: number;
  /** Whether to record the owner's own prompts in full. */
  readonly keepSelfPrompts: boolean;
}

/**
 * The append-only record of every prompt that has run on this machine.
 *
 * byollm_002 calls the meter the product's soul. This is it: one JSONL file
 * the owner can read, grep and delete, written before execution rather than
 * after.
 */
export class IngressLog {
  readonly #options: IngressOptions;

  constructor(options: IngressOptions) {
    this.#options = options;
  }

  /** Record a prompt. Await this before starting the backend call. */
  async recordPrompt(input: {
    at: number;
    origin: string;
    jobId: string;
    site?: string;
    kind: string;
    audience: Audience;
    owner: string;
    backendId: string;
    backendClass: string;
    model: string;
    prompt: string;
  }): Promise<void> {
    // Community prompts are always kept initially — retention reduces them
    // later. Only the owner's own prompts can be opted out of up front.
    const keepText =
      input.audience === "private" ? this.#options.keepSelfPrompts : true;

    await this.#append({
      type: "prompt",
      at: input.at,
      origin: input.origin,
      jobId: input.jobId,
      ...(input.site === undefined ? {} : { site: input.site }),
      kind: input.kind,
      audience: input.audience,
      owner: input.owner,
      backendId: input.backendId,
      backendClass: input.backendClass,
      model: input.model,
      promptHash: hashText(input.prompt),
      promptChars: input.prompt.length,
      ...(keepText ? { prompt: input.prompt } : {}),
    });
  }

  /** Record how a job ended. */
  async recordOutcome(input: {
    at: number;
    jobId: string;
    site?: string;
    outcome: OutcomeEntry["outcome"];
    durationMs?: number;
    outputChars?: number;
    detail?: string;
  }): Promise<void> {
    await this.#append({
      type: "outcome",
      at: input.at,
      jobId: input.jobId,
      ...(input.site === undefined ? {} : { site: input.site }),
      outcome: input.outcome,
      ...(input.durationMs === undefined
        ? {}
        : { durationMs: input.durationMs }),
      ...(input.outputChars === undefined
        ? {}
        : { outputChars: input.outputChars }),
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    });
  }

  async #append(entry: IngressEntry): Promise<void> {
    await mkdir(dirname(this.#options.path), { recursive: true });
    // JSON.stringify escapes control characters, so a prompt containing ANSI
    // escapes or newlines cannot forge a log line or repaint the terminal of
    // whoever later reads the file ({@link MUSTS.OUTPUT_INERT}).
    await appendFile(this.#options.path, `${JSON.stringify(entry)}\n`, {
      mode: 0o600,
    });
  }

  /** Read the log, oldest first. Malformed lines are skipped, not fatal. */
  async read(): Promise<IngressEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.#options.path, "utf8");
    } catch {
      return [];
    }
    const entries: IngressEntry[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = IngressEntry.safeParse(JSON.parse(line));
        if (parsed.success) entries.push(parsed.data);
      } catch {
        // A truncated final line after a hard kill is expected, not an error.
      }
    }
    return entries;
  }

  /**
   * Apply retention: drop the text of community prompts older than the
   * window, keeping the hash, the metadata and the character count.
   *
   * byollm_004 Rev 1: a volunteer must not indefinitely retain strangers'
   * content. The hash stays, so the owner can still prove what ran.
   *
   * @returns how many entries were reduced.
   */
  async applyRetention(now: number): Promise<number> {
    const entries = await this.read();
    const cutoff = now - this.#options.communityPromptDays * 86_400_000;
    let reduced = 0;

    const kept = entries.map((entry) => {
      if (entry.type !== "prompt") return entry;
      /**
       * Not-private, rather than a list of the sharing scopes.
       *
       * The stored `audience` is `z.string()` on purpose, so this log keeps
       * reading entries written by older daemons — including `public`, a
       * scope removed on 2026-08-26. Enumerating the sharing scopes would
       * have made those legacy rows non-community overnight and kept
       * somebody else's prompts on this disk for ever.
       *
       * Stated this way an audience this version does not recognise is
       * retained *less*, never more, which is the safe direction for text
       * that belongs to somebody who is not the owner.
       */
      const isCommunity = entry.audience !== "private";
      if (!isCommunity || entry.prompt === undefined || entry.at >= cutoff) {
        return entry;
      }
      reduced += 1;
      const { prompt: _dropped, ...rest } = entry;
      return rest;
    });

    if (reduced > 0) {
      // The log is append-only in operation; retention is the one deliberate
      // exception, and it only ever removes text.
      await writeFile(
        this.#options.path,
        `${kept.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        { mode: 0o600 },
      );
    }
    return reduced;
  }
}

/** SHA-256 of a prompt, hex. */
export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Replace terminal control sequences before printing untrusted text.
 *
 * Model output and job payloads both reach the owner's terminal through
 * `byollm log` and `byollm status`. Text that can move the cursor or set
 * colours can forge output — the ANSI/log-injection row of byollm_004 §5's
 * corpus. Stored bytes stay verbatim; only the *display* is sanitised, so the
 * log remains an honest record of what actually arrived.
 *
 * Tab and newline are kept: they are legitimate content, not control.
 */
export function stripControlChars(text: string): string {
  // eslint-disable-next-line no-control-regex -- matching control characters is the entire purpose
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "\uFFFD");
}
