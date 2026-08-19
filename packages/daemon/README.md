> [!WARNING]
> **Alpha (`0.1.0-alpha.19`) — under active development. Don't use this yet.**
>
> Install it deliberately: `npx byollm@alpha`, or `npm install byollm@alpha`.
>
> The protocol is v0 and **will** change without a deprecation path, this has
> never run outside its own test suite, and nothing here has production miles.
> Read it, take the ideas, tell us what's wrong — but don't put it in front of
> your users.
>
> npm assigns `latest` on a first publish and won't let it be removed, so a
> bare install resolves here too. This notice is the only guard — deliberately
> not an npm deprecation, which would read as *abandoned* rather than *early*.
> Ask for `@alpha` explicitly so your lockfile records that you meant to.>
> **`alpha.15` is a breaking wire change, and it breaks daemons and relays —
> not app authors.** If you call `app.enqueue(...)` and read results, nothing
> in your code changes. If you run a daemon or an upstream, every package must
> move together: a mixed pair refuses on both sides, because both ends parse
> `.strict()`.
>
> What moved, all of it reconciling the frozen `byollm_009` with its code:
> `JobStub` gains `site` (the site's identity key id) and loses
> `audienceAllow`; `ResultRequest` gains `leaseId`; `HeartbeatResponse` loses
> `leases`, which nothing read; `WireErrorCode` gains `not-ready`,
> `clock-skew` and `forbidden`, and `403` is `forbidden` rather than
> `unauthorized`. `RESULT_PROVENANCE` is superseded by
> `PROVENANCE_NAMES_DEVICE`. See `byollm_009` Amendment A.>
> **`alpha.16` is a breaking wire change — daemons and relays again, not app
> authors.** `app.enqueue(...)` and reading results are unchanged. All five
> packages move together: both ends parse `.strict()`, so a mixed pair
> refuses.
>
> What moved, all of it Tier 2 of `cloud_008`: `model`, `backendClass` and
> `durationMs` come off `ResultRequest` and are sealed **inside** the result
> envelope as `SealedOutcome = { outcome, ran }` — so a daemon can no longer
> declare a model it did not sign, and a relay carries neither.
> `HeartbeatResponse` loses `leases` (nothing read it) and now reports real
> cancellations instead of an empty list. `WireErrorCode` gains `forbidden`
> for 403, leaving `unauthorized` at exactly 401. The relay gained a
> site-plane `cancel` endpoint, honours `stub.deadlineAt`, honours
> `stub.audience`, and remembers a refusal.>
> **`alpha.17` is additive** — no wire change. It exports `ReleaseReason`,
> which `RoutingStore.releaseLeases` names and the package did not export, so
> the interface was unimplementable outside this repo.>
> **`alpha.18` is a breaking wire change — daemons and relays, not app
> authors.** `app.enqueue(...)` and reading results are unchanged. All five
> packages move together.
>
> The **bearer token is gone**: off `PairPollResponse`, off the runner row,
> off the daemon's pairings file, out of the adapter's schema. It was minted,
> hashed and stored on two disks and never sent, looked up or compared —
> `REQUESTS_SIGNED_NOT_BEARER` was enforced by signatures the whole time. If
> you run the Supabase adapter, apply
> `20260819000000_drop_runner_token.sql`; `byollm_approve_pairing` now takes
> one argument. A pairings file written by an older daemon still loads.
>
> `model`, `backendClass` and `durationMs` moved **inside** the sealed result
> (`SealedOutcome = { outcome, ran }`), so a daemon cannot declare a model it
> did not sign and a relay carries none of them. Writing a `RoutingStore`?
> `releaseLeases` takes an optional `reason` and `complete` requires
> `leaseId`, and **an implementation that ignores either still typechecks** —
> run the store contract tests.>
> **`alpha.19` is additive on the wire and a behaviour change in every
> store.** `ResultResponse` gains an optional `duplicate`. Nothing is removed,
> so an older daemon keeps working — but the *order* two rules are checked in
> has changed, and a `RoutingStore` implementation must change with it.
>
> `complete` now checks **terminal state before holder**, scoped to the device
> that finished the job: a replay from that device is answered `duplicate:
> true` with a 2xx, and anyone else gets exactly the refusal they would get
> for a job that is not terminal. Previously `RESULT_IDEMPOTENT` held only
> because the lease is nulled on success, so the holder check tripped first —
> deleting the idempotency branch failed no test. Run the store contract
> tests; the compiler cannot see this.
>
> **`alpha.3` is a breaking change.** A config naming `openai-http` with a
> remote base URL and an offer scope wider than `self` is narrowed to `self`
> until you acknowledge the spend and set a daily ceiling:
> `byollm offer <backend> public --cap <cents>`. Local base URLs are
> unaffected. `byollm backends` shows the cost class per route.

# `byollm`

What end users run. Connects **outbound** to an app you trust, claims only the
jobs you have agreed to run, and executes them on your own models.

```bash
npx byollm@alpha connect https://your-app.com
```

There is nothing to open on your network. The daemon never listens.

## Five minutes, start to finish

You need a model server. Ollama is the usual one:

```bash
ollama serve            # http://127.0.0.1:11434
ollama pull gemma3:12b
```

Then:

```bash
npx byollm@alpha connect https://your-app.com
```

```
  Open:  https://your-app.com/settings/runners
  Code:  KRTZ-9F2Q      (expires in 10m)

  waiting for approval… ✓ paired as you@example.com
```

You approve inside the app's own login session — the daemon never asks for a
password and never accepts a pasted secret.

## Configuration

`~/.byollm/config.json`. Everything the daemon will ever do is in this file.

```jsonc
{
  "backends": {
    // One HTTP backend covers Ollama, MLX, llama.cpp and vLLM — they all
    // speak OpenAI-compatible /v1/chat/completions.
    "local": {
      "backend": "openai-http",
      "baseUrl": "http://127.0.0.1:11434/v1",
    },
    "mlx": { "backend": "openai-http", "baseUrl": "http://127.0.0.1:8080/v1" },
    "claude": { "backend": "claude-cli" },
  },
  "routes": {
    "llm.generate": { "backend": "local", "model": "gemma3:12b" },
    "llm.chat": { "backend": "claude", "model": "claude-opus-5" },
  },
  "concurrency": 2,
}
```

A job's `kind` selects a route **you defined**. A job can never name a model, a
URL, a path or a flag — there is no field on the wire for any of them.

`byollm backends` shows what is configured, what is healthy, and what is
therefore advertised. A backend that is down is never advertised, so you never
get work you cannot run.

## The trust surface

The meter is the product, and it gets the same care as the loop.

```bash
byollm status         # what's connected, what's running, what you've done for others
byollm log            # every prompt that has ever run here
byollm log --full     # the whole text, not the first line
byollm pause          # stop claiming work
byollm resume
```

Every prompt is appended to `~/.byollm/ingress.log` **before** it executes, so
a job that wedges the machine still leaves a record of what it was. The file is
JSONL, `0600`, and yours to read, grep and delete.

## Lending your machine to other people

Off by default. A fresh daemon runs your work and nobody else's.

```bash
byollm allow https://your-app.com alice   # asks you to confirm, in plain words
byollm allow --list                       # everyone who can use this machine
byollm offer openai public --cap 250      # share a paid backend, with a ceiling
byollm disallow https://your-app.com alice
```

The allowlist is **yours**, checked locally, keyed by `(app, user)`. An app
saying "this runner is allowed" is not enough — your daemon decides. Community
jobs are additionally rate-limited, capped daily, given a tighter resource
budget, and their prompts are reduced to hashes after 7 days so you are not
holding strangers' content indefinitely.

**Your subscription-backed models are never part of this.** `claude-cli` is
locked to your own work — a protocol rule, not a setting you can change.

## Security

Every payload is treated as hostile input. Breakout is structurally
impossible: process-class backends get a fixed argv with the prompt on stdin,
a stripped environment, an empty scratch directory and hard timeout/output
caps; HTTP-class backends spawn nothing at all. The model has no tools, no
retrieval and no MCP.

Prompt injection — steering what the model _says_ — is not prevented by
anything and we do not claim otherwise. It is bounded here because the model
has no tools and the output is inert.

Full threat model, including what the OS stops us dropping:
[`docs/security.md`](../../docs/security.md).

MIT
