import { z } from "zod";

/**
 * How a backend reaches its model — the taxonomy introduced in byollm_001
 * Rev 1 §A, because the two classes have different threat surfaces.
 *
 * - `http`: an OpenAI-compatible HTTP server (Ollama, `mlx_lm.server`,
 *   llama.cpp server, vLLM). Spawns nothing, so byollm_004 §2's argv, stdin,
 *   env and sandbox requirements are not applicable by construction. Its
 *   threat surface is SSRF-shaped and bounded by {@link MUSTS.HTTP_BASE_URL_SAFE}.
 * - `process`: spawns a binary (`claude` CLI today, `mlx_lm.lora` for a
 *   future `train.*` kind). All of byollm_004 §2 is mandatory here.
 */
export const BackendClass = z.enum(["http", "process"]);
export type BackendClass = z.infer<typeof BackendClass>;

/**
 * Whose account pays for the inference.
 *
 * `subscription` backends run against a vendor account belonging to the
 * machine's owner. They are hard-locked to an offer scope of `self`
 * ({@link MUSTS.SUBSCRIPTION_SELF_LOCK}) — one account executes one person's
 * work. This is orthogonal to {@link BackendClass}: `claude-cli` is both
 * process-class and subscription-class, while a future local `mlx_lm.lora`
 * backend would be process-class and open.
 */
export const BackendAccount = z.enum(["open", "subscription"]);
export type BackendAccount = z.infer<typeof BackendAccount>;

/** The immutable facts about a backend that the protocol reasons over. */
export interface BackendDescriptor {
  /** Stable backend id, as written in `byollm.config.json`. */
  readonly id: string;
  /** Human-readable name for the trust UI. */
  readonly label: string;
  /** Determines which isolation requirements apply. */
  readonly class: BackendClass;
  /** Determines whether the offer scope can be widened past `self`. */
  readonly account: BackendAccount;
  /**
   * Which adversarial corpus byollm_004 §5 runs against this backend. A
   * backend cannot be registered without one — the coverage check in the
   * adversarial suite enforces it.
   */
  readonly adversarialCorpus: "process" | "http";
}

const backend = (b: BackendDescriptor): BackendDescriptor => Object.freeze(b);

/**
 * The v1 backend registry.
 *
 * byollm_001 Rev 1 §A collapses four planned backends into one HTTP-class
 * entry: Ollama, `mlx_lm.server`, llama.cpp server and vLLM all speak
 * OpenAI-compatible `/v1/chat/completions`, so they are one backend with N
 * owner-configured base URLs rather than four adapters. That is what puts
 * MLX inference in v1.
 */
export const BACKENDS = Object.freeze({
  "openai-http": backend({
    id: "openai-http",
    label: "OpenAI-compatible HTTP server (Ollama, MLX, llama.cpp, vLLM)",
    class: "http",
    account: "open",
    adversarialCorpus: "http",
  }),
  "claude-cli": backend({
    id: "claude-cli",
    label: "Claude CLI (your subscription)",
    class: "process",
    account: "subscription",
    adversarialCorpus: "process",
  }),
} as const satisfies Record<string, BackendDescriptor>);

/** The id of a registered backend. */
export type BackendId = keyof typeof BACKENDS;

/** All registered backend ids — the adversarial coverage check iterates this. */
export const BACKEND_IDS = Object.freeze(Object.keys(BACKENDS) as BackendId[]);

export const BackendIdSchema = z.enum(
  BACKEND_IDS as [BackendId, ...BackendId[]],
);

/** Narrow an arbitrary string to a registered backend id. */
export function isBackendId(value: string): value is BackendId {
  return Object.hasOwn(BACKENDS, value);
}

/**
 * Look up a backend descriptor.
 *
 * @throws if the id is not registered — an unregistered backend has no
 * adversarial corpus, so refusing is the safe direction.
 */
export function backendDescriptor(id: BackendId): BackendDescriptor {
  return BACKENDS[id];
}
