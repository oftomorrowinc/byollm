# byollm_002 — The daemon (`byollm` / `@byollm/daemon`)

**What end-users run**: `npx byollm connect https://app.example.com`
→ browser pairing → polling loop. macOS/Linux v1.

## Behavior

- **Backends v1**: Ollama first (health check, model list), claude
  CLI second (auth check; ANTHROPIC_API_KEY stripped from child env
  so billing can't silently move — port the press wrapper's
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
  file the owner can read); `byollm log`, `byollm pause`,
  `byollm status` commands; per-app counters. The meter is the
  product — it gets the same care as the loop.
- Errors: transient 5xx/backoff with Retry-After honored; 404-class
  never retried; the daemon's own failure output distinguishes
  "server unreachable", "revoked", "no matching work", and "backend
  down" — four different truths that must never share a message.

## Done when

A stranger with Ollama installed goes from `npx byollm connect` to a
completed job in under five minutes against the reference server;
kill -9 mid-job loses nothing (lease reclaim proven in tests);
subscription backend refuses a `named` job in a test; ingress log
shows every prompt; coverage and lint gates green.
