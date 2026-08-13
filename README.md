> [!WARNING]
> **Alpha (`0.1.0-alpha.3`) — under active development. Don't use this yet.**
>
> Install it as `byollm@alpha`, deliberately. npm forces a `latest` tag onto a
> package's first publish and will not let it be removed, so a bare install
> resolves here too — this notice is the only guard, and that is on purpose:
> an npm deprecation would read as *abandoned* rather than *early*. The
> protocol is v0 and **will** change without a deprecation path,
> the packages have never run outside their own test suite, and nothing here
> has production miles. Read it, take the ideas, tell us what's wrong — but
> don't put it in front of your users.
>
> **`alpha.3` is a breaking change.** `BackendDescriptor.account` is gone;
> read `cost` instead (`free` / `metered` / `subscription`). A config naming
> `openai-http` with a **remote** base URL and an offer scope wider than
> `self` is now narrowed to `self` until the owner acknowledges the spend and
> sets a daily ceiling — that narrowing is the bug being fixed, and
> `byollm status` says so in words rather than doing it silently. Local base
> URLs are unaffected. See [byollm_007](specs/byollm_007-cost-class-and-providers.md).

<div align="center">

# BYOLLM

**Bring Your Own LLM.** Let your app's users run its AI on *their* models and *their* subscriptions — their Ollama box, their MLX machine, their `claude` CLI — through a tiny daemon they run and control.

`npx byollm@alpha connect https://your-app.com`

[![npm](https://img.shields.io/badge/npm-%40byollm-cb3837)](https://www.npmjs.com/org/byollm) · [![license](https://img.shields.io/badge/license-MIT-blue)](#license) · [![status](https://img.shields.io/badge/status-alpha-orange)](#status)

</div>

---

## Why

Every AI app eventually gets the same request: *"can I use my own model / my own key / my own GPU?"* Answering it usually means CORS headaches, tunnels into localhost, or shipping the user a fragile script.

BYOLLM makes it a three-line integration. Your app enqueues LLM jobs; the user runs a small **outbound** daemon that claims *only their own jobs* and executes them locally. No inbound ports, no tunnels, no keys leaving the machine. The browser app stays hosted; the compute comes from the user.

Two audiences, one design:

- **App developers** get a drop-in server adapter and a job queue. Enqueue `llm.generate`, get a result back — you never touch the user's model or credentials.
- **Users** get a daemon that is their **trust anchor**: every prompt that runs on their machine is logged, rate-limited, and pausable, and subscription-backed models are hard-locked to *their own work only*.

## How it works

```
   your web app  ──enqueue job──▶  your backend (@byollm/server)
                                          │
                                          │  jobs table (yours: Supabase, Postgres, memory…)
                                          ▼
   user's machine  ──outbound poll──▶  claim ─▶ run on local model ─▶ result
     (byollm)                                          │
                                                   Ollama · MLX · claude CLI
```

The daemon only ever connects **out**. There is nothing to open on the user's network. Jobs are **typed data, never code** — a server can hand the daemon a prompt, never a command.

## Quick start

### For app developers

Mount the handler, point it at a store, and enqueue.

```ts
// app/api/byollm/[...route]/route.ts
import { createHandler } from "@byollm/server/next";
import { store } from "@/lib/byollm";

export const { POST } = createHandler({
  store,
  verificationUrl: "https://your-app.com/settings/runners",
});
```

```ts
// lib/byollm.ts
import { ByollmApp, MemoryStore } from "@byollm/server";

export const store = new MemoryStore();
export const app = new ByollmApp({ store });
```

```ts
// anywhere in your app
const job = await app.enqueue({
  kind: "llm.generate",
  audience: "self",            // this user's machine only
  owner: userId,
  payload: { prompt: "Summarize this transcript:\n\n" + transcript },
});

// resolves via your delivery channel (webhook / Realtime / poll),
// with a timeout and a noRunnerAvailable path — never a bare await
const { outcome } = await job.result({ onNoRunner: promptUserToConnect });
```

That's the whole integration: **one route, one store, one `enqueue`.** If no daemon is online, you get a `noRunnerAvailable` signal (fall back to a hosted model, or prompt the user to connect) — never a promise that hangs forever.

### For users

```bash
npx byollm@alpha connect https://your-app.com   # opens a browser to pair — one click
byollm status                                # what's connected, what's running
```

Point it at your models:

```jsonc
// ~/.byollm/config.json
{
  "backends": {
    // One HTTP backend covers Ollama, MLX, llama.cpp and vLLM — they all speak
    // OpenAI-compatible /v1/chat/completions. Configure as many as you run.
    "local":  { "backend": "openai-http", "baseUrl": "http://127.0.0.1:11434/v1",
                "offer": "self" },                  // or "named" / "public" for open models
    "mlx":    { "backend": "openai-http", "baseUrl": "http://127.0.0.1:8080/v1" },
    "claude": { "backend": "claude-cli" }           // subscription CLIs are locked to "self"
  },
  "routes": {
    "llm.generate": { "backend": "local",  "model": "gemma3:12b" },
    "llm.chat":     { "backend": "claude", "model": "claude-opus-5" }
  }
}
```

```bash
byollm backends       # what's installed, healthy, and actually advertised
byollm log            # every prompt that ran here, ever
byollm pause          # stop claiming work
byollm allow --list   # everyone who can use this machine (empty by default)
byollm offer <backend> public --cap 250   # share a paid backend, deliberately
```

## The audience model — sharing, safely

Every job carries an **audience** and every backend an **offer scope**. A job runs on a machine only when both agree.

| Backend | Cost | Can offer | Why |
|---|---|---|---|
| **Ollama, MLX, llama.cpp, vLLM, LM Studio** | `free` | `self` → `named` (friends) → `public` (anyone) | Local compute. Costs electricity, not money — the folding@home posture. |
| **Anthropic, OpenAI, Gemini, Grok, Groq, OpenRouter…** | `metered` | `self` by default; wider only with an explicit spend acknowledgment **and** a daily ceiling | Your API key, your money, per token. Sharing it is legitimate and ruinous by accident. |
| **claude CLI & other subscription accounts** | `subscription` | `self` **only, enforced** | One account runs one person's work. A protocol MUST, not a setting. |

Cost class comes from the protocol registry and is **not yours to declare**. Point the generic `openai-http` backend at a remote endpoint and it is `metered` no matter what you call it — "free" is derived from the address the request is sent to, not from the config. That is the one rule that makes the rest enforceable.

Note the pair: `anthropic` and `claude-cli` reach one vendor in two different cost classes. A platform key bills per token; a Claude plan covers one person's work. The axis asks who pays and under what terms, not which company answers.

The derivation reads the address, not the destination — a localhost proxy forwarding to a paid API classes as `free`, and nothing downstream can see through it. That is a deliberate act by the machine's owner against their own account, and it is [outside the threat model](docs/security.md#4a-cost-class--whose-money-and-whose-terms); what the rule prevents is the *accident*.

Want to lend your GPU to the open-source community, or let your friends' jobs run overnight on your machine? `byollm offer <backend> public` flips an open backend over. Your subscription is never part of that.

Widening a **paid** backend is the one path that asks first, and the question names the money rather than asking whether you are sure:

```bash
$ byollm offer openai public --cap 250

This lets other people's jobs run on OpenAI (your API key), which bills
your account per token. You would be paying for their work, up to
$2.50 a day, every day, until you change it.
Spending stops at that ceiling and resumes the next day.

Offer openai to anyone? [y/N]
```

Sharing a metered backend without a ceiling is refused outright — an unlimited one is not something anyone means on purpose. Narrowing back to `self` withdraws the consent too, so widening again has to be agreed to again.

`named` is enforced by **your** daemon, not by the app: it keeps a local allowlist of `(app, user)` pairs — `byollm allow <app-url> <user-id>` — and refuses anything not on it, whatever the server claims. The list starts empty, so a fresh daemon runs your work and nobody else's until you say otherwise.

## Security

The daemon runs prompts on the owner's machine, so **every payload is treated as hostile input**. Breakout is made *structurally impossible*, not merely detected:

- Payload text can **never become a command line**. HTTP-class backends (Ollama, MLX server, vLLM) receive it as a request body; process-class backends (`claude` CLI) receive it on **stdin with a fixed argv**. Shell metacharacters, `--flags`, `$(…)` are just characters the model reads.
- Model, backend, and flags come from the **owner's local config only** — a job can never name a model, path, URL, or flag.
- Process-class backends spawn with a stripped environment (no `ANTHROPIC_API_KEY`), an empty scratch dir, no inherited file descriptors, and hard timeout/output caps. HTTP-class backends spawn nothing at all.
- The daemon exposes **no tools, no retrieval, no MCP** to the model. Output is inert bytes — never eval'd, never written to a payload-named path.

A named **adversarial test corpus** (command injection, argv injection, path traversal, env exfiltration, oversized/unicode payloads) runs as a blocking CI gate, and every backend must ship its own hostile-payload suite before it can be added. See [`docs/security.md`](docs/security.md).

We're precise about the boundary: BYOLLM makes **breakout** impossible; **prompt injection** (steering the model's *words*) is the model's problem, bounded here because the model has no tools and the output is inert. We don't promise more than we can keep.

## Packages

| Package | What it is |
|---|---|
| [`@byollm/protocol`](packages/protocol) | The wire contract — types, schemas, the normative spec. |
| [`byollm`](packages/daemon) | What users run (`npx byollm@alpha`). Backends, routing, the trust log. |
| [`@byollm/server`](packages/server) | Drop-in handlers + a Supabase adapter for your backend. |
| [`@byollm/conformance`](packages/conformance) | The compatibility contract — certify any server with one command. |

A server is **byollm-compatible** when the conformance kit passes against it. That sentence is the whole versioning story — no framework version to chase.

## Status

**Alpha, built in the open.** All four packages are published — `byollm`, `@byollm/protocol`, `@byollm/server` and `@byollm/conformance` — and you should ask for `@alpha` explicitly. npm assigns `latest` on a first publish and refuses to let it be removed, so a bare `npm install byollm` resolves here too; the warning at the top of this file is the guard, deliberately rather than an npm deprecation, which would say *abandoned* when the truth is *early*.

The protocol is at v0 and the audience model is settled, but v0 means what it says: it will change without a deprecation path. The daemon ships the full audience matrix with an **empty allowlist by default**, so it behaves as `self`-only until you widen it deliberately. Backends at v1: `openai-http` (Ollama, MLX, llama.cpp, vLLM) and `claude-cli`.

What exists: 421 tests, an adversarial corpus wired as a blocking CI gate, and a conformance kit green against both the in-memory reference and real Postgres. What does not exist: a single production mile. Wait for `latest`.

## Contributing

The bar is CI-enforced, not review-vigilance: strict TypeScript, ≥90% coverage on the server and ≥85% on the daemon, zero-warning lint, no dead code, and the conformance kit green against both the reference server and Supabase on every PR. `@byollm/protocol` is gated by the conformance kit rather than a line-coverage number, which on a types-and-schemas package is trivially met or gamed. The adversarial corpus is a separate blocking gate, and the demo in [`examples/`](examples) runs in CI so it can't rot. See [`docs/standards.md`](docs/standards.md) and the specs in [`specs/`](specs).

## License

MIT.

<div align="center"><sub>Built by <a href="https://oftomorrow.dev">Of Tomorrow</a> — the pattern behind our own apps, opened up.</sub></div>
