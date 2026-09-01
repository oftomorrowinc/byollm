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

export type BackendResult =
  | { readonly ok: true; readonly text: string; readonly durationMs: number }
  | {
      readonly ok: false;
      readonly code: BackendErrorCode;
      readonly message: string;
      readonly retryable: boolean;
      readonly durationMs: number;
    };

/**
 * Why a backend call failed.
 *
 * Distinct codes because byollm_002 requires that different truths never
 * share a message: an owner whose model server is down needs a different
 * sentence from one whose job hit its timeout.
 */
export type BackendErrorCode =
  | "backend-unreachable"
  | "backend-error"
  | "model-not-found"
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
