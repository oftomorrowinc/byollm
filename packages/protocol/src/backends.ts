import { isIP } from "node:net";
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

/**
 * Its members, for anything that has to report what it accepts.
 *
 * Derived from the enum for the reason `JOB_KINDS` and `OFFER_SCOPES` are: a
 * second list of the same words is a second thing to keep in step, and this
 * one is read by the promotion gate to compare a deployed hub against a
 * version about to be promoted.
 */
export const BACKEND_CLASSES = Object.freeze(BackendClass.options);
export type BackendClass = z.infer<typeof BackendClass>;

/**
 * Who pays, and how — byollm_007.
 *
 * This replaced a two-valued `account` field that conflated two unrelated
 * constraints and, in doing so, left a hole: `openai-http` was "open", but it
 * accepts an API key, so an owner could point it at a paid endpoint, share it,
 * and donate their credit balance to strangers. The community budgets cap job
 * *count*, not spend.
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
  /**
   * Note the pair: `anthropic` and {@link BACKENDS."claude-cli"} reach the
   * same vendor and land in different cost classes. That is not an
   * inconsistency — it is the axis working. One bills a key per token, the
   * other runs under a personal plan whose terms cover one person's work. Who
   * pays and under what terms is the question; which company is not.
   */
  anthropic: backend({
    id: "anthropic",
    label: "Anthropic (your API key)",
    class: "http",
    cost: "metered",
    adversarialCorpus: "http",
    defaultBaseUrl: "https://api.anthropic.com/v1",
  }),
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
  /**
   * OpenAI's Codex CLI, on a ChatGPT plan — byollm_016 stage 3.
   *
   * `subscription`, so `SUBSCRIPTION_SELF_LOCK` pins it to its owner's own
   * work whatever the config says. That is load-bearing here in a way it is
   * not for `claude-cli`: Codex is an *agent*, and its default feature set
   * includes a shell tool, browser control and computer use. The daemon
   * disables every one of them, verified against the shipped binary rather
   * than assumed — see `codex-cli.ts` — but the self-lock is the floor under
   * that verification rather than a duplicate of it.
   */
  "codex-cli": backend({
    id: "codex-cli",
    label: "Codex CLI (your ChatGPT plan)",
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
 * because "free" is derived from the address, not from what the config claims.
 *
 * **What this cannot see.** The address is all it reads. A proxy on
 * `127.0.0.1` forwarding to a paid API classes as `free` and nothing
 * downstream will contradict it. That is deliberate: standing up a relay is
 * an act by the machine's owner against their own account, and the threat
 * model here is a hostile *job*, not an owner routing around a rule that
 * exists to protect them. What this catches is the accident — a remote paid
 * endpoint offered to a team because nobody thought about the bill. See
 * `docs/security.md` §4a.
 */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  // RFC 6761 reserves `localhost` and everything under it for the loopback
  // interface. The only names that are local; every other name is a name.
  if (host === "localhost" || host.endsWith(".localhost")) return true;

  // Everything below is a prefix test on an address, so it only runs on an
  // address — cloud_008 §0.5.
  //
  // These used to run on the raw string. `startsWith("10.")` matched
  // `10.example.com`, `startsWith("192.168.")` matched `192.168.example.com`,
  // and `/^f[cd]/` — meant for `fc00::/7` — matched **any hostname beginning
  // with the letters f-c or f-d**: `fdapi.example.com`, `fchat.ai`,
  // `fc-inference.io`. A paid remote endpoint at such a name resolved to
  // `free`, which is `REMOTE_IS_NEVER_FREE` inverted: no ceiling, no metering,
  // and eligible to be shared. The worst of them needs no attacker and
  // no unusual config — just a vendor whose domain happens to start with two
  // particular letters.
  //
  // `isIP` is `node:net`'s, the same guard `checkBaseUrl` uses. Two questions,
  // one technique: that file asks whether an address is a forbidden
  // destination, this one asks whether it is on the owner's own machine or
  // LAN. Neither reuses the other's *rule* — cloud_007 §2 said it did, which
  // was never true — but nothing hand-parses an address in either.
  const version = isIP(host);

  // A DNS name is remote. It might resolve to loopback, and this deliberately
  // does not find out: the alternative is a DNS lookup inside a cost decision,
  // where the answer can change between the check and the request. Metered is
  // the safe side of being wrong — it costs a local user a ceiling they did
  // not need, where the other direction costs a remote user money.
  if (version === 0) return false;

  if (version === 6) {
    if (host === "::1") return true;
    // Unique local addresses (fc00::/7), now that this can only see an
    // address. An IPv4-mapped form like `::ffff:127.0.0.1` is not matched and
    // classes as metered — the safe side again, and rare enough that guessing
    // at it would add more surface than it removes.
    return /^f[cd]/.test(host);
  }

  if (host.startsWith("127.")) return true;
  if (host.startsWith("10.")) return true;
  if (host.startsWith("192.168.")) return true;
  return /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

/**
 * Is this model name a hosted one billed by its vendor?
 *
 * Ollama serves cloud models through the same local endpoint as local ones,
 * so the address says "free" about a model somebody is being charged for. The
 * only thing that distinguishes them is the name, and the distinguishing part
 * is the **tag** — everything after the last colon.
 *
 * End-anchored on the tag, which is what makes it decidable rather than a
 * guess about substrings:
 *
 * - `glm-5.2:cloud` → cloud
 * - `deepseek-v4-flash:0731-cloud` → cloud
 * - `x:cloudless` → not cloud, the tag ends in "less"
 * - `cloudmodel:7b` → not cloud, the tag is "7b"
 * - `llama3.2` → not cloud, there is no tag at all
 *
 * An oddball like `:xcloud` classifies as cloud, and that is the **only
 * permitted failure direction**: calling a free model metered narrows what an
 * owner may share and costs nobody money, while the reverse hands somebody
 * else's bill to a stranger.
 */
export function isCloudTaggedModel(model: string): boolean {
  return /:[^:]*cloud$/.test(model);
}

/**
 * The cost class of a configured service.
 *
 * For every named provider this is whatever the registry says, full stop
 * ({@link MUSTS.COST_NOT_CONFIGURABLE}). For the generic `openai-http` entry
 * it is inferred from the base URL, and a base URL that cannot be parsed is
 * treated as `metered` — the expensive side, because guessing "free" wrong
 * costs the owner money.
 *
 * The model has the last word in one direction only. A local address with a
 * cloud-tagged model is `metered`: Ollama proxies hosted models through
 * `127.0.0.1`, so the endpoint is local and the bill is not. Read from the
 * **configured value**, never from what the server lists — the owner's config
 * is the thing they chose, and a server's catalogue is not theirs to be
 * classified by.
 */
export function resolveCost(
  id: BackendId,
  baseUrl: string | undefined,
  /**
   * **Required, and that is the fix.**
   *
   * This was optional, and the no-re-derivation law was breached through the
   * gap rather than by anybody copying the logic. `byollm offer` passed two of
   * three arguments and `resolveConfig` passed three, so the same service was
   * free to one and metered to the other: `glm-5.2:cloud` on a loopback
   * address looks local until you read the tag. The command wrote a share the
   * daemon then refused, and told its owner to run the command they had just
   * run.
   *
   * A shared rule's signature admits no partial askers. `undefined` is still a
   * legal *value* — a service genuinely without a model — but it has to be
   * passed, so choosing to omit the model is a decision at the call site
   * rather than a default nobody notices.
   */
  model: string | undefined,
): BackendCost {
  return classifyCost(id, baseUrl, model).cost;
}

/**
 * Why a service costs what it costs — the same decision, said out loud.
 *
 * Consent has to name the rule that fired. The offer ceremony read
 * "Any OpenAI-compatible server ... bills your account per token", which is
 * false about the type — an owner's local qwen is `openai-http` and costs
 * nothing but electricity — and so it gave a reason that its reader could
 * check and find wrong. The thing that bills is the `:cloud` tag on one
 * model, not the transport that carries it.
 *
 * One function decides and one function explains, and the second calls the
 * first, so a message can never describe a classification the code did not
 * make. Splitting them would be the same defect this signature was just
 * hardened against, arriving as prose.
 */
/**
 * The product's name alone, without the parenthetical that classifies it.
 *
 * Every label in this registry does two jobs: it names a product and says what
 * that product means for the person paying — "Claude CLI (your subscription)",
 * "Ollama (local)". That is right for a list, where the parenthetical is the
 * only classification on screen.
 *
 * It is wrong inside a sentence that states the classification itself, which
 * then stutters: "my-claude runs on Claude CLI (your subscription), a
 * subscription whose terms…". Prose wants the name; the sentence around it is
 * already carrying the meaning.
 *
 * One definition rather than a regex at each call site — and the place to
 * change if the registry ever splits the two facts into two fields, which is
 * the better shape and not worth a migration today.
 */
export function backendName(id: BackendId): string {
  return BACKENDS[id].label.replace(/\s*\([^)]*\)$/, "");
}

export interface CostReason {
  readonly cost: BackendCost;
  /** The rule, in the words a person consenting needs. */
  readonly because: string;
}

export function classifyCost(
  id: BackendId,
  baseUrl: string | undefined,
  model: string | undefined,
): CostReason {
  const declared = BACKENDS[id].cost;
  if (declared !== null) {
    // A named provider's cost is the registry's word and nothing else
    // [COST_NOT_CONFIGURABLE], so here — and only here — the provider's own
    // name is the honest reason. Each class gets its own sentence: a free
    // provider described as billing per token is the same defect as a cloud
    // model described as a generic endpoint.
    const label = BACKENDS[id].label;
    return {
      cost: declared,
      because: {
        subscription: `${label} runs on an account you subscribe to`,
        metered: `${label} bills per token`,
        free: `${label} runs on this machine`,
      }[declared],
    };
  }
  if (model !== undefined && isCloudTaggedModel(model)) {
    return {
      cost: "metered",
      because:
        `its model tag ends in \`:cloud\`, so the work runs on your ` +
        `provider's cloud account rather than on this machine`,
    };
  }
  if (baseUrl === undefined) {
    return {
      cost: "metered",
      because: "it has no address, so where the work runs cannot be checked",
    };
  }
  try {
    return isLocalHost(new URL(baseUrl).hostname)
      ? { cost: "free", because: "it runs on this machine" }
      : {
          cost: "metered",
          because: "its address is not on this machine, so the work leaves it",
        };
  } catch {
    return {
      cost: "metered",
      because: "its address cannot be read, so where the work runs is unknown",
    };
  }
}
