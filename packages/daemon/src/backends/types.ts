import {
  StopReasonSchema,
  type StopReason,
  type BackendClass,
  type BackendId,
} from "@byollm/protocol";

/**
 * The text of one model call, already composed by the daemon.
 *
 * Note what a backend receives: a string and a model name. It gets no access
 * to the job, the payload object, or anything that could carry routing. By
 * the time execution reaches here, the payload has been reduced to the only
 * thing byollm_004 §1 permits a job to cause — text sent to a model.
 */
export interface BackendRequest {
  /** The composed prompt text. */
  readonly prompt: string;
  /** The model, from owner config only ({@link MUSTS.NO_PAYLOAD_ROUTING}). */
  readonly model: string;
  /** Hard wall-clock ceiling. */
  readonly timeoutMs: number;
  /** Hard output ceiling; output past this truncates and fails the job. */
  readonly maxOutputBytes: number;
  /** Aborts the in-flight call — how cancel and revocation take effect. */
  readonly signal: AbortSignal;
}

/**
 * Why a model stopped generating — byollm_021, and it is a closed set for the
 * same reason {@link BackendErrorCode} is.
 *
 * That union's own note says different truths must never share a message: an
 * owner whose model server is down needs a different sentence from one whose
 * job hit its timeout. **Truncation is a different truth, and until now it
 * shared the success message.** A model that hits its own `max_tokens`
 * returned an unfinished answer reported as a finished one — Kevin found the
 * wall by trial and error, because trial and error was the only instrument
 * we gave anybody.
 *
 * Sharper: this codebase already has `output-too-large`, which is OUR
 * ceiling. We gave our own truncation a distinct code and gave the model's
 * none, and the guard we built is what taught us we were covered.
 */
/**
 * An adapter's answer to "how do you know why the model stopped".
 *
 * Two shapes because there are two honest answers, and "I have not checked"
 * must not be able to masquerade as "there is nothing to check".
 */
export type StopReasonMapping =
  | {
      readonly kind: "declared";
      /** The vendor field this reads, named so a reviewer can go and look. */
      readonly from: string;
      /** That field's values, mapped onto ours. */
      readonly map: Readonly<Record<string, StopReason>>;
    }
  | {
      /**
       * Checked, and this adapter's output carries no such signal.
       *
       * Distinct from `unverified`, and the distinction is the same one this
       * codebase keeps arriving at: "nobody looked" and "we looked and there
       * is nothing" are different facts, and an owner surface that prints one
       * for the other is telling somebody to go and find something that does
       * not exist.
       */
      readonly kind: "unavailable";
      /** What was checked and what it did not carry. */
      readonly why: string;
    }
  | {
      readonly kind: "unverified";
      /** Why not, in words — this is said out loud on the owner surface. */
      readonly why: string;
    };

/* Re-exported so adapter code keeps importing one module, while the
   definition itself lives where the wire vocabulary lives — B064 step 4. */
export { StopReasonSchema, type StopReason };

/**
 * The stop reason a result actually carries, with absence resolved.
 *
 * Read through this rather than off the field, so an adapter that has not
 * been taught to report one cannot be mistaken for a model that ran to
 * completion.
 */
export function stopReasonOf(result: BackendResult): StopReason {
  return result.ok ? (result.stop ?? "unknown") : "unknown";
}

/**
 * Where a call's time went, as far as it can be seen from outside — B195.
 *
 * Todd, 09-14: *"I want to know how much of that is waiting on claude and gpt
 * vs resource utilization."* `durationMs` is one number covering spawn, the
 * vendor wait and reading the answer, because `started` is taken on the first
 * line of `execute()` and everything happens inside `runProcessJob`.
 *
 * These are the two boundaries a parent process can actually observe:
 *
 * - **`spawnMs`** — `started` to the child's `spawn` event. **This is the
 *   segment a starved box shows up in**: 50m of CPU and 269 MiB of 320 used
 *   (B122) is where a fork gets slow, and nothing about it is the vendor's.
 * - **`firstOutputMs`** — `started` to the first byte on stdout or stderr.
 *
 * **What the middle segment is NOT, said plainly:** `firstOutputMs - spawnMs`
 * is *the child's own startup plus its first vendor response*, and those two
 * are not separable from out here — a CLI that prints a banner before it calls
 * anybody makes the number small for a reason that has nothing to do with
 * latency. **It is a bound, not an attribution**, and it must be read as one.
 * Separating them further needs the CLI to say so, which is a vendor's choice
 * rather than ours.
 *
 * Optional on both variants because a call that never spawned has neither, and
 * reporting a zero there would be a measurement nobody made.
 */
/* Not exported: nothing outside this file names the type, and knip is right
   that an export nobody imports is a wider surface than the code needs. The
   shape travels on `BackendResult`, which is exported. */
interface BackendTiming {
  readonly spawnMs?: number;
  readonly firstOutputMs?: number;
}

export type BackendResult =
  | {
      readonly ok: true;
      readonly text: string;
      readonly durationMs: number;
      readonly timing?: BackendTiming;
      /**
       * Why generation ended — byollm_021.
       *
       * Optional on the type and NOT optional in practice: every registered
       * adapter must declare a mapping, and the adversarial coverage check
       * enforces that, the same way it enforces a hostile-payload corpus.
       * Absent resolves to `"unknown"` through {@link stopReasonOf}, which is
       * the honest reading and not `"end"`.
       */
      readonly stop?: StopReason;
    }
  | {
      readonly ok: false;
      readonly code: BackendErrorCode;
      readonly message: string;
      readonly durationMs: number;
      readonly timing?: BackendTiming;
      /**
       * When the backend expects to be usable again — byollm_019 §3.2.
       *
       * Epoch ms, and only when the CLI actually said so. Carried on the
       * result rather than looked up later because the sentence that names
       * the time is the failure diagnostic itself, and it is gone by the time
       * anything else could ask.
       *
       * **A reason without a clock turns "wait" into "give up."** Somebody
       * told their service is blocked, and not told for how long, cannot tell
       * an hour from a week and reaches for the remedy that always looks
       * available: turning it off.
       *
       * Owner-only, like every other diagnostic here. It never reaches a
       * site: a duration leaks which block was hit, and which block was hit
       * is a fact about how much somebody has been working today.
       */
      readonly until?: number | undefined;
    };

/*
 * `retryable` used to live on this shape and no longer does — ruled
 * 2026-09-04.
 *
 * Every adapter computed one, and after the retry decision moved to the
 * site-facing class table nothing read any of them. They had also drifted:
 * the same quota block reported `true` from Codex and `false` from Claude,
 * and the HTTP backend used a third rule again. A field that is computed
 * three inconsistent ways and read nowhere is not harmless — it is a leak
 * waiting for its first consumer, and the leak it waits for is the one the
 * class table was flattened to close.
 *
 * The wire's `retryable` is a different field on a different shape, is read,
 * and stays.
 */

/**
 * Why a backend call failed.
 *
 * Distinct codes because byollm_002 requires that different truths never
 * share a message: an owner whose model server is down needs a different
 * sentence from one whose job hit its timeout.
 */
export type BackendErrorCode =
  /**
   * This device does not have the memory to load a model right now — B080.
   *
   * Its own code because this union's own rule is that different truths must
   * never share a message. "The server is down" and "the server is fine and
   * this machine has no room" are different things to be told, and only one
   * of them is fixed by starting something.
   *
   * It reaches a site as `service_unavailable`, like every other fact about
   * somebody's machine — telling a site that this device is low on memory is
   * telling it about the device, which is what that mapping exists to stop.
   */
  | "insufficient-memory"
  | "backend-unreachable"
  | "backend-error"
  | "model-not-found"
  | "quota-exhausted"
  | "timeout"
  | "output-too-large"
  | "canceled"
  | "unauthorized"
  /**
   * The job's own images could not be used — byollm_021 §2–§4: a blob that
   * was larger or smaller than its reference, did not decrypt under this job,
   * failed its hash, or was not the type or size it declared. A fact about
   * what the SITE sent, so it is the one failure here a site is told
   * plainly; re-sending the same job will not change it.
   */
  | "image-refused";

/** Whether a backend is usable right now, and with which models. */
export interface BackendHealth {
  readonly healthy: boolean;
  /** Models the backend reports; empty when it could not be reached. */
  readonly models: readonly string[];
  /** Why it is unhealthy — shown verbatim in `byollm status`. */
  readonly detail?: string;
}

/**
 * A way of reaching a model.
 *
 * Implementations are registered in {@link BACKENDS} and must ship
 * adversarial-suite rows before they can be added — the coverage check in the
 * adversarial suite enforces that, so a new backend cannot arrive without its
 * hostile-payload corpus.
 */
export interface Backend {
  readonly id: BackendId;
  readonly class: BackendClass;

  /**
   * Can this backend serve work right now, and with what?
   *
   * The capability matrix is config ∩ *this*
   * ({@link MUSTS.CAPABILITY_IS_DETECTED}) — a configured but unreachable
   * backend must never be advertised.
   */
  health(): Promise<BackendHealth>;

  /**
   * Can it actually *do* the work — credentials and all?
   *
   * Optional, and implemented only where {@link Backend.health} cannot answer
   * the question. A subscription CLI passes `--version` without credentials,
   * so its health check reports healthy while every job fails "not signed in".
   * That gap cost a live cross-user test on 2026-08-25.
   *
   * A canary spends a real call, so **it never runs on the polling loop.**
   * Daemon start and enablement only: bounded, human-adjacent, cents on a
   * subscription. The runner enforces where it is called from; a backend just
   * answers honestly when asked.
   */
  canary?(model: string): Promise<BackendHealth>;

  /**
   * How somebody signs this backend in, in their own terminal.
   *
   * The remedy belongs to the backend because only the backend knows it:
   * `claude` wants the bare command and a browser, `codex` wants
   * `codex login`. A template that guessed would be wrong for one of them and
   * would go on being wrong as they change.
   *
   * Absent when the idea does not apply — an HTTP model server has a URL and a
   * key in the owner's config, not a sign-in, so it gets no sentence rather
   * than a sentence naming a command that does not exist.
   */
  readonly signIn?: string;

  /**
   * How this adapter reads its own vendor's stop signal — byollm_021.
   *
   * **Required, and that is Todd's ruling made structural**: "each service
   * adapter should state its truncated message output along with other
   * errors." A required field means an adapter cannot be added without
   * answering the question, the same way `BACKENDS` cannot be extended
   * without an adversarial corpus. A rule you have to remember holds until
   * somebody adds the next one.
   *
   * `unverified` is a legitimate answer and an honest one. The mappings here
   * are checked by running the thing, per the `login.ts` and
   * `startCommandFor` precedent — a guessed field name produces a gate that
   * silently never fires, which is this bug with extra steps.
   */
  readonly stopReasons: StopReasonMapping;

  /** Run one model call. The only thing a job is permitted to cause. */
  execute(request: BackendRequest): Promise<BackendResult>;

  /**
   * One turn of a function-calling conversation — byollm_012 §7.
   *
   * Present only on a backend that can carry a site's tool declarations to
   * its model, which is the `http` class: an `llm.tools` route on a backend
   * without it is never advertised. **It never runs a tool.** It hands the
   * model the declarations, and hands back whatever calls the model asked
   * for, as text; the daemon's loop seals each one to the site
   * ({@link MUSTS.TOOLS_RUN_AT_SITE}).
   */
  converse?(request: ConverseRequest): Promise<ConverseResult>;

  /**
   * One model call that reads images — byollm_021 `llm.vision`.
   *
   * Present only on a backend that can put image bytes in a request body,
   * which is the `http` class (§6). The bytes arrive already decrypted,
   * hash-checked and sniffed; the backend sends them and nothing else.
   */
  readImages?(request: VisionRequest): Promise<BackendResult>;

  /**
   * One image-generation call — byollm_021 `llm.image`.
   *
   * Returns image **bytes**. A backend that answers with a URL instead is an
   * error and the URL is never fetched ({@link MUSTS.IMAGE_BYTES_NOT_URLS}).
   */
  makeImages?(request: ImageRequest): Promise<ImageResult>;
}

/** A turn of an `llm.vision` call, as the backend sends it. */
export type VisionTurn =
  | { readonly role: "user" | "assistant" | "system"; readonly content: string }
  | {
      readonly role: "user";
      readonly content: readonly (
        | { readonly type: "text"; readonly text: string }
        | {
            readonly type: "image";
            readonly mediaType: string;
            readonly bytes: Uint8Array;
          }
      )[];
    };

export interface VisionRequest extends Omit<BackendRequest, "prompt"> {
  readonly messages: readonly VisionTurn[];
}

export interface ImageRequest {
  readonly prompt: string;
  readonly model: string;
  /** The owner's pixel size for the job's aspect, from config only. */
  readonly size: string;
  readonly count: number;
  readonly timeoutMs: number;
  /** Ceiling on the response body, which carries every image as base64. */
  readonly maxOutputBytes: number;
  readonly signal: AbortSignal;
}

export type ImageResult =
  | {
      readonly ok: true;
      readonly images: readonly Uint8Array[];
      /** The backend's revised prompt, where it returns one; else empty. */
      readonly text: string;
      readonly durationMs: number;
    }
  | (BackendResult & { readonly ok: false });

/** Everything a backend instance needs from the owner's config. */
export interface BackendInit {
  /** HTTP-class only. Already validated by {@link checkBaseUrl}. */
  readonly baseUrl?: string | undefined;
  /** Name of the env var holding an API key, if the server needs one. */
  readonly apiKeyEnv?: string | undefined;
}

/**
 * A call the model asked for, exactly as it wrote it.
 *
 * `arguments` is the model's text, unparsed: the loop parses and validates it
 * against the declaration (C036), because a backend adapter that "helped" by
 * coercing it would be deciding what the model meant.
 */
export interface ModelToolCall {
  /** The model server's id for the call, which its tool turn answers. */
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** A turn of the conversation the tool loop keeps — daemon-side only. */
export type ConverseMessage =
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls?: readonly ModelToolCall[];
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly content: string;
    };

/** A declaration as the model is shown it: the site's words, nothing more. */
export interface ConverseTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

export interface ConverseRequest extends Omit<BackendRequest, "prompt"> {
  readonly messages: readonly ConverseMessage[];
  /**
   * The tools offered on this turn. Absent offers none, which is how the
   * closing turn at the budget is asked (§8): "answer from what you have".
   */
  readonly tools?: readonly ConverseTool[];
}

export type ConverseResult =
  | {
      readonly ok: true;
      readonly text: string;
      /** Empty when the model answered rather than calling. */
      readonly toolCalls: readonly ModelToolCall[];
      readonly stop: StopReason;
      readonly durationMs: number;
    }
  | (BackendResult & { readonly ok: false });
