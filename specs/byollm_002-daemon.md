# byollm_002 — The daemon (`byollm` / `@byollm/daemon`)

**What end-users run**: `npx byollm connect https://app.example.com`
→ browser pairing → polling loop. macOS/Linux v1.

## Behavior

- **Backends v1**: Ollama first (health check, model list), claude
  CLI second (auth check; ANTHROPIC_API_KEY stripped from child env
  so billing can't silently move — port our existing wrapper's
  discipline and its thinking-field-is-an-error rule for models that
  emit reasoning preambles).
- **Routing**: `byollm.config.json` maps job kinds → backend+model
  (`"llm.generate": "ollama:qwen3-14b"`). The capability matrix sent
  on heartbeat is derived from config ∩ detected reality — never
  advertise what isn't installed and healthy.
- **Offer scopes** per backend per the protocol: subscription-class
  locked `self`; open backends may be set `self`/`named`/`public`.
  Widening scope requires an explicit interactive confirmation that
  names what it means ("jobs from anyone may run on this machine").
- **Loop**: heartbeat (~10s, jitter) → claim ≤concurrency → execute
  → result. Resumable, idempotent by job id; leases released on
  SIGINT; a wedged job's lease simply expires server-side.
- **Trust surface**: append-only **ingress log** (timestamp, app,
  job id, kind, backend/model, prompt hash + full prompt in a local
  file the owner can read); `byollm log`, `byollm stop`,
  `byollm status` commands; per-app counters. The meter is the
  product — it gets the same care as the loop.
- Errors: transient 5xx/backoff with Retry-After honored; 404-class
  never retried; the daemon's own failure output distinguishes
  "server unreachable", "revoked", "no matching work", and "backend
  down" — four different truths that must never share a message.


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
| `CAPABILITY_IS_DETECTED` | §Routing |

## Done when

A stranger with Ollama installed goes from `npx byollm connect` to a
completed job in under five minutes against the reference server;
kill -9 mid-job loses nothing (lease reclaim proven in tests);
subscription backend refuses a `named` job in a test; ingress log
shows every prompt; coverage and lint gates green.

---

## Rev 1 — CC review adjudication (2026-08-08)

- **HTTP-class backend is v1's primary (review #5).** A single
  `openai-http` backend covers Ollama, `mlx_lm.server`, llama.cpp
  server and vLLM — config is `{ backend: "openai-http", baseUrl,
  model }`. No spawn; base URL is owner-config only and validated
  against SSRF ranges. This is what makes **MLX inference available
  in v1** so the first consumer can prove the whole path. `claude` CLI
  is the one
  process-class backend at v1; `mlx_lm.lora` training is a later
  process-class `train.*` kind.
- **Local `named` allowlist (review #1).** The daemon owns a file of
  `(server origin, user-id)` pairs and checks `named` jobs against it
  itself — `byollm allow <server> <user>`, `byollm allow --list`,
  `byollm revoke …`. One place to see everyone who can use this
  machine, across every app it's paired to. A `named` job whose owner
  isn't locally allowed is refused regardless of server assertion.
- **Cancel (review #3).** Heartbeat response may carry
  `cancel:[jobId]`; the daemon aborts those backends' in-flight calls
  (HTTP abort / process kill) and reports `canceled`.
- **Ingress retention (review #7).** `named`/`public` prompts kept
  full for 7 days (configurable) then hash-only; `self` kept per
  owner default. Surfaced in `byollm status`.
