# byollm_007 — Cost class, and the built-in provider registry

**The hole this closes.** `BackendDescriptor.account` has two values,
`open` and `subscription`, and `openai-http` is `open`. But
`openai-http` also accepts `apiKeyEnv`. So an owner can point it at
`https://api.openai.com/v1` with their billing key, set
`offer: "public"`, and **donate their credit balance to strangers**.
The community budgets cap job *count*, not spend. Nothing in the
protocol notices.

The mistake is that `account` conflates two unrelated constraints:

- **Terms**: a subscription account may only run its owner's work,
  because the provider's terms say so. Sharing is a ToS violation.
- **Money**: a metered key spends the owner's money per token. Sharing
  is legal and ruinous.

`open` currently means "neither of the above", which is true of a local
Ollama and false of a paid API reached through the same backend.

## 1. The cost axis

`account` is replaced by `cost`, with three values:

| `cost` | Means | Examples |
|---|---|---|
| `free` | Local compute. Costs electricity, not money. | Ollama, MLX, llama.cpp, vLLM, LM Studio |
| `metered` | Per-token billing against the owner's account. | OpenAI, Gemini, Grok, Groq, OpenRouter |
| `subscription` | A vendor account whose terms forbid third-party work. | `claude` CLI |

### Offer scope by cost class

| `cost` | May offer |
|---|---|
| `free` | `self` → `named` → `public`, freely. The folding@home posture. |
| `metered` | **`self` by default.** Widening requires an explicit spend acknowledgment *and* a spend ceiling. |
| `subscription` | `self`, always. Unchanged, still a hard protocol MUST. |

`metered` is the new middle. It is not forbidden — lending a paid key
to a named colleague is a legitimate thing to want — but it must be
impossible to do *by accident*, and it must be bounded.

## 2. Where `cost` comes from, and why it can't be lied about

**Built-in providers**: `cost` is fixed in the protocol registry and is
**not overridable by config**. `openai` is `metered` because it is;
no setting changes that.

**The generic `openai-http` backend**: `cost` is **inferred from the
base URL**, and the inference is the enforcement:

- base URL resolves to loopback or a private range → `free`
- anything else → `metered`

An owner therefore **cannot declare a remote endpoint free**. This is
checkable, cheap, and closes the obvious bypass — reaching a paid API
through the generic backend to escape the metered rules. It reuses the
locality logic already in `checkBaseUrl` (byollm_004 Rev 1), which
allows loopback and RFC1918 precisely because that is the product's
main path.

The daemon is the enforcing side, as always. The server applies the
same rule as defence in depth, from the capability matrix.

## 3. The built-in provider registry

Providers are **registry entries, not implementations**. Every
HTTP-class provider shares the one `openai-http` transport; a registry
entry adds a stable id, a cost class, and a default base URL. Adding a
provider is one line and no new code — which is the point, and the
reason the adversarial corpus still covers all of them.

**Free (local):** `ollama`, `mlx`, `llamacpp`, `vllm`, `lmstudio`,
`jan`, `localai`

**Metered (remote):** `anthropic`, `openai`, `gemini`, `grok`, `groq`,
`openrouter`, `together`, `deepseek`, `mistral`

`anthropic` and `claude-cli` reach one vendor in two cost classes. The
axis asks who pays and under what terms, not which company.

**Generic:** `openai-http` — any OpenAI-compatible endpoint, cost
inferred per §2. The escape hatch for anything not listed.

**Subscription (process):** `claude-cli`

Defaults are overridable; a self-hosted vLLM behind a company domain is
still `metered` under §2, which is the safe direction — the owner can
widen it deliberately with a ceiling.

## 4. MUSTs

- `METERED_DEFAULTS_SELF` — a `metered` backend's effective offer scope
  MUST be `self` unless the owner has recorded an explicit spend
  acknowledgment for that backend.
- `METERED_REQUIRES_CEILING` — a widened `metered` backend MUST carry a
  spend ceiling, and the daemon MUST refuse community work once it is
  reached.
- `COST_NOT_CONFIGURABLE` — a built-in provider's cost class MUST NOT
  be overridable by configuration.
- `REMOTE_IS_NEVER_FREE` — a generic HTTP backend whose base URL is not
  loopback or private MUST be treated as `metered`.
- `SUBSCRIPTION_SELF_LOCK` — unchanged.

## 5. What this breaks

A breaking protocol change, taken deliberately while the protocol is
v0 and says it will change without a deprecation path.

- Configs naming `openai-http` with a **local** base URL: unchanged
  behaviour (`free`).
- Configs naming `openai-http` with a **remote** base URL and an offer
  scope wider than `self`: **narrowed to `self`** until the owner adds
  a spend acknowledgment. This is the bug being fixed, so the narrowing
  is the point, and `byollm status` says so in words rather than
  silently.
- `BackendDescriptor.account` is gone. Anything reading it moves to
  `cost`.

## 6. The trust surface

`byollm backends` shows the cost class per route, and `byollm status`
shows spend against the ceiling next to the existing job counters —
zero and unknown must not look alike, so a backend with no ceiling set
reads as "not shared", not as "0 spent".

The widening confirmation gains a sentence naming the money, in the
same plain-language register as the existing one: widening a `metered`
backend spends the owner's money on someone else's work, and the
sentence has to say that before the prompt is accepted.

## Done when

**Status: implemented.** `C017_METERED_DEFAULTS_SELF` and
`C018_METERED_CEILING` cover the four new MUSTs; the audience matrix runs
27 ways (three cost classes × three audiences × three offer scopes);
`byollm offer <backend> <scope> [--cap <cents>]` is the command the
config error names, and the widening question names the money.

Every MUST above has a conformance check; the nine-way audience matrix
is extended across the three cost classes; a remote base URL cannot be
declared `free` (tested); the built-in providers resolve to working
config with only an id and an API key env var; `docs/security.md` and
the landing page carry the cost table; and the adversarial coverage
check still refuses a backend without hostile-payload rows.
