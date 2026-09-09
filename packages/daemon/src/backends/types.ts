import { z } from "zod";
import type { BackendClass, BackendId } from "@byollm/protocol";

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

/**
 * The closed set, as a schema — so the values exist once.
 *
 * A bare union would mean anything that has to VALIDATE a stop reason (the
 * ingress log, and the wire when step 4 lands) retyping the four strings
 * beside it. Instruction 9: one definition, both ends, and where a consumer
 * needs a runtime check the definition has to be one it can run.
 *
 * The type below is inferred from this rather than written twice, so the
 * compiler and the validator cannot disagree about what a stop reason is.
 */
export const StopReasonSchema = z.enum([
  "end",
  "length",
  "stop-sequence",
  "unknown",
]);

export type StopReason =
  /** The model finished on its own. */
  | "end"
  /** The model stopped at its own output ceiling. */
  | "length"
  /** A configured stop token ended it. */
  | "stop-sequence"
  /**
   * The adapter cannot tell, and says so.
   *
   * **The default, and never `"end"`.** An adapter nobody has updated — or
   * one somebody adds next year — must not be able to claim completion by
   * saying nothing. If absence meant "end", every un-updated adapter would go
   * on telling exactly the lie this exists to fix, and every new adapter
   * would inherit it in silence.
   *
   * It is the opposite-boolean rule this codebase keeps arriving at: when you
   * cannot tell, guess toward silence rather than toward a claim. "We do not
   * know" is a thing a site can act on; "it finished" when it did not is not.
   */
  | "unknown";
/* Asserted rather than assumed: the hand-written union above carries the
   documentation and this keeps it identical to the schema. If somebody adds a
   fifth reason to one and not the other, this line stops compiling. */
type _StopReasonsAgree = [
  z.infer<typeof StopReasonSchema> extends StopReason ? true : never,
  StopReason extends z.infer<typeof StopReasonSchema> ? true : never,
];

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

export type BackendResult =
  | {
      readonly ok: true;
      readonly text: string;
      readonly durationMs: number;
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
  | "unauthorized";

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
}

/** Everything a backend instance needs from the owner's config. */
export interface BackendInit {
  /** HTTP-class only. Already validated by {@link checkBaseUrl}. */
  readonly baseUrl?: string | undefined;
  /** Name of the env var holding an API key, if the server needs one. */
  readonly apiKeyEnv?: string | undefined;
}
