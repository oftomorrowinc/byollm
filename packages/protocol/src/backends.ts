import { z } from "zod";

/**
 * How a backend reaches its model — the taxonomy introduced in byollm_001
 * Rev 1 §A, because the two classes have different threat surfaces.
 *
 * - `http`: an OpenAI-compatible HTTP server (Ollama, `mlx_lm.server`,
 *   llama.cpp server, vLLM, and every hosted provider that speaks the same
 *   wire format). Spawns nothing, so byollm_004 §2's argv, stdin, env and
 *   sandbox requirements are not applicable by construction. Its threat
 *   surface is SSRF-shaped and bounded by {@link MUSTS.HTTP_BASE_URL_SAFE}.
 * - `process`: spawns a binary (`claude` CLI today, `mlx_lm.lora` for a
 *   future `train.*` kind). All of byollm_004 §2 is mandatory here.
 */
export const BackendClass = z.enum(["http", "process"]);
export type BackendClass = z.infer<typeof BackendClass>;

/**
 * Who pays, and how — byollm_007.
 *
 * This replaced a two-valued `account` field that conflated two unrelated
 * constraints and, in doing so, left a hole: `openai-http` was "open", but it
 * accepts an API key, so an owner could point it at a paid endpoint, offer it
 * `public`, and donate their credit balance to strangers. The community
 * budgets cap job *count*, not spend.
 *
 * - `free` — local compute. Costs electricity, not money. Shareable.
 * - `metered` — per-token billing against the owner's account. Legal to
 *   share and ruinous to share by accident.
 * - `subscription` — a vendor account whose terms forbid third-party work.
 *   Sharing is a terms violation, not merely expensive.
 */
export const BackendCost = z.enum(["free", "metered", "subscription"]);
export type BackendCost = z.infer<typeof BackendCost>;

/** The immutable facts about a backend that the protocol reasons over. */
export interface BackendDescriptor {
  /** Stable backend id, as written in `byollm.config.json`. */
  readonly id: string;
  /** Human-readable name for the trust UI. */
  readonly label: string;
  /** Determines which isolation requirements apply. */
  readonly class: BackendClass;
  /**
   * Who pays. Fixed here for every named provider and **not overridable by
   * configuration** ({@link MUSTS.COST_NOT_CONFIGURABLE}) — `openai` is
   * metered because it is, and no setting changes that.
   *
   * `null` only for the generic {@link BACKENDS."openai-http"} entry, whose
   * cost is inferred from its base URL instead
   * ({@link MUSTS.REMOTE_IS_NEVER_FREE}).
   */
  readonly cost: BackendCost | null;
  /**
   * Which adversarial corpus byollm_004 §5 runs against this backend. A
   * backend cannot be registered without one — the coverage check in the
   * adversarial suite enforces it.
   */
  readonly adversarialCorpus: "process" | "http";
  /**
   * Where this provider lives, when that is knowable. Owner config may
   * override it; a provider with no default requires one to be given.
   */
  readonly defaultBaseUrl?: string;
}

const backend = (b: BackendDescriptor): BackendDescriptor => Object.freeze(b);

/**
 * The backend registry.
 *
 * **Providers are entries, not implementations.** Every HTTP-class provider
 * below shares the single `openai-http` transport, because they all speak
 * OpenAI-compatible `/v1/chat/completions`. An entry adds a stable id, a cost
 * class the owner cannot override, and a default base URL. Adding a provider
 * is therefore one line and no new code — which is why the adversarial corpus
 * still covers all of them, and why a PR adding one is reviewable at a glance.
 */
export const BACKENDS = Object.freeze({
  // -- free: local compute, costs electricity ------------------------------
  ollama: backend({
    id: "ollama",
    label: "Ollama (local)",
    class: "http",
    cost: "free",
    adversarialCorpus: "http",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
  }),
  mlx: backend({
    id: "mlx",
    label: "MLX (mlx_lm.server, local)",
    class: "http",
    cost: "free",
    adversarialCorpus: "http",
    defaultBaseUrl: "http://127.0.0.1:8080/v1",
  }),
  llamacpp: backend({
    id: "llamacpp",
    label: "llama.cpp server (local)",
    class: "http",
    cost: "free",
    adversarialCorpus: "http",
    defaultBaseUrl: "http://127.0.0.1:8080/v1",
  }),
  vllm: backend({
    id: "vllm",
    label: "vLLM (local)",
    class: "http",
    cost: "free",
    adversarialCorpus: "http",
    defaultBaseUrl: "http://127.0.0.1:8000/v1",
  }),
  lmstudio: backend({
    id: "lmstudio",
    label: "LM Studio (local)",
    class: "http",
    cost: "free",
    adversarialCorpus: "http",
    defaultBaseUrl: "http://127.0.0.1:1234/v1",
  }),
  jan: backend({
    id: "jan",
    label: "Jan (local)",
    class: "http",
    cost: "free",
    adversarialCorpus: "http",
    defaultBaseUrl: "http://127.0.0.1:1337/v1",
  }),
  localai: backend({
    id: "localai",
    label: "LocalAI (local)",
    class: "http",
    cost: "free",
    adversarialCorpus: "http",
    defaultBaseUrl: "http://127.0.0.1:8080/v1",
  }),

  // -- metered: the owner's money, per token -------------------------------
  openai: backend({
    id: "openai",
    label: "OpenAI (your API key)",
    class: "http",
    cost: "metered",
    adversarialCorpus: "http",
    defaultBaseUrl: "https://api.openai.com/v1",
  }),
  gemini: backend({
    id: "gemini",
    label: "Google Gemini (your API key)",
    class: "http",
    cost: "metered",
    adversarialCorpus: "http",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  }),
  grok: backend({
    id: "grok",
    label: "xAI Grok (your API key)",
    class: "http",
    cost: "metered",
    adversarialCorpus: "http",
    defaultBaseUrl: "https://api.x.ai/v1",
  }),
  groq: backend({
    id: "groq",
    label: "Groq (your API key)",
    class: "http",
    cost: "metered",
    adversarialCorpus: "http",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
  }),
  openrouter: backend({
    id: "openrouter",
    label: "OpenRouter (your API key)",
    class: "http",
    cost: "metered",
    adversarialCorpus: "http",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
  }),
  together: backend({
    id: "together",
    label: "Together AI (your API key)",
    class: "http",
    cost: "metered",
    adversarialCorpus: "http",
    defaultBaseUrl: "https://api.together.xyz/v1",
  }),
  deepseek: backend({
    id: "deepseek",
    label: "DeepSeek (your API key)",
    class: "http",
    cost: "metered",
    adversarialCorpus: "http",
    defaultBaseUrl: "https://api.deepseek.com/v1",
  }),
  mistral: backend({
    id: "mistral",
    label: "Mistral (your API key)",
    class: "http",
    cost: "metered",
    adversarialCorpus: "http",
    defaultBaseUrl: "https://api.mistral.ai/v1",
  }),

  // -- the escape hatch ----------------------------------------------------
  "openai-http": backend({
    id: "openai-http",
    label: "Any OpenAI-compatible server",
    class: "http",
    // Unknown until the base URL is known: local means free, remote means
    // metered, and the owner does not get to say otherwise
    // ({@link MUSTS.REMOTE_IS_NEVER_FREE}).
    cost: null,
    adversarialCorpus: "http",
  }),

  // -- subscription: someone else's terms ----------------------------------
  "claude-cli": backend({
    id: "claude-cli",
    label: "Claude CLI (your subscription)",
    class: "process",
    cost: "subscription",
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

/**
 * Is this host local enough that compute there is free?
 *
 * Loopback and the private ranges only. This is the rule that makes
 * {@link MUSTS.REMOTE_IS_NEVER_FREE} enforceable rather than a promise: an
 * owner cannot reach a paid API through the generic backend and call it free,
 * because "free" is derived from where the request goes, not from what the
 * config claims.
 */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  if (host.startsWith("127.")) return true;
  if (host.startsWith("10.")) return true;
  if (host.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  // Unique local addresses (fc00::/7).
  if (/^f[cd]/.test(host)) return true;
  return false;
}

/**
 * The cost class of a configured backend instance.
 *
 * For every named provider this is whatever the registry says, full stop
 * ({@link MUSTS.COST_NOT_CONFIGURABLE}). For the generic `openai-http` entry
 * it is inferred from the base URL, and a base URL that cannot be parsed is
 * treated as `metered` — the expensive side, because guessing "free" wrong
 * costs the owner money.
 */
export function resolveCost(
  id: BackendId,
  baseUrl: string | undefined,
): BackendCost {
  const declared = BACKENDS[id].cost;
  if (declared !== null) return declared;
  if (baseUrl === undefined) return "metered";
  try {
    return isLocalHost(new URL(baseUrl).hostname) ? "free" : "metered";
  } catch {
    return "metered";
  }
}
