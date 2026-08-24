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

- base URL's host **is** a loopback or private-range address, or is
  `localhost` (RFC 6761) → `free`
- anything else, including every other name → `metered`

An owner therefore **cannot declare a remote endpoint free**. This is
checkable, cheap, and closes the obvious bypass — reaching a paid API
through the generic backend to escape the metered rules.

It does not resolve the name, on purpose: DNS can answer differently
between the check and the request, and a cost decision that depends on
a lookup is a cost decision an attacker can move. A name that is not
`localhost` is metered whatever it points at. Metered is the safe side
of being wrong here — it costs a local owner a ceiling they did not
need, where the other direction costs a remote owner money.

**Correction (cloud_008 §0.5).** This section used to say the rule
"reuses the locality logic already in `checkBaseUrl`". It never did,
and the sentence hid a live bug for as long as it stood: `isLocalHost`
ran its prefix tests against the raw hostname, so `10.example.com` was
private, and `/^f[cd]/` — written for `fc00::/7` — matched **any name
beginning with the letters f-c or f-d**. `fchat.ai` was free compute.
`checkBaseUrl` had guarded its own prefix tests with `isIP` from the
start, which is exactly why a reviewer reading this paragraph would
not have gone looking.

The two functions answer different questions — `checkBaseUrl` asks
whether an address is a forbidden destination, `isLocalHost` asks
whether it is on the owner's own machine or LAN — and they are not
merged, because merging them would mean one rule serving two purposes.
What they share is the guard: neither hand-parses an address, and both
decide `isIP` first and match prefixes second.

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


### The registry index

Every MUST this spec adjudicates, by id, with the section that decides it.
Added by cloud_008 Tier 4 §1.3b: byollm_009 was the only spec with a table,
so the registry was the sole enumerated home for 34 of 38 MUSTs and nothing
could compare the two. `musts-match-specs.test.ts` reads these tables.

**An index, not a restatement.** The statement lives in `MUSTS` and the
reasoning lives in the sections named below; a table that repeated either
would be a third copy to drift. What a reader gets here is the set, and what
the check gets is a list it can compare against the registry.

| MUST | Adjudicated in |
|---|---|
| `COST_NOT_CONFIGURABLE` | §2 |
| `METERED_DEFAULTS_SELF` | §4 |
| `METERED_REQUIRES_CEILING` | §4 |
| `REMOTE_IS_NEVER_FREE` | §2 |

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

---

## Landmine filed 2026-08-24: cloud-proxied models pierce URL locality

Ollama's cloud models (`<model>:cloud`) are served through the *local*
ollama endpoint — a loopback URL proxying to remote, metered compute
billed to the owner's account. `REMOTE_IS_NEVER_FREE` infers cost
from URL locality, so such a service would classify free-class,
be offerable `named`/`public` without spend acknowledgment, and let
an audience quietly spend the owner's cloud quota — the donated-
credit-balance hole this spec closed for API keys, reopened through a
proxy. Cost is a property of the *model being served*, not only of
the endpoint's address.

Until the registry can see through the proxy (e.g. treating
`:cloud`-suffixed models, or any model the local server reports as
remote, as `metered`), the rule is: a cloud-proxied model configured
as a service MUST be treated as metered — `self` by default, spend
acknowledgment + ceiling to widen. Needs its own detection story and
corpus rows when byollm_016 Phase A touches per-service detection.
Filed from the field: press is testing glm-5.1 via ollama cloud
tonight; the moment it wins a bake-off, someone will want to share it.
