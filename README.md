<div align="center">

# BYOLLM

**Bring Your Own LLM.** Let your app's users run its AI on *their* models and *their* subscriptions — their Ollama box, their MLX machine, their `claude` CLI — through a tiny daemon they run and control.

`npx byollm connect https://your-app.com`

[![npm](https://img.shields.io/badge/npm-%40byollm-cb3837)](https://www.npmjs.com/org/byollm) · [![license](https://img.shields.io/badge/license-MIT-blue)](#license) · [![status](https://img.shields.io/badge/status-pre--release-orange)](#status)

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
     (@byollm/daemon)                                    │
                                                   Ollama · MLX · claude CLI
```

The daemon only ever connects **out**. There is nothing to open on the user's network. Jobs are **typed data, never code** — a server can hand the daemon a prompt, never a command.

## Quick start

### For app developers

Mount the handler, point it at a store, and enqueue.

```ts
// app/api/byollm/[...route]/route.ts
import { createHandler } from "@byollm/server";
import { supabaseStore } from "@byollm/server/supabase";

export const { GET, POST } = createHandler({ store: supabaseStore(env) });
```

```ts
// anywhere in your app
import { enqueue } from "@byollm/server";

const job = await enqueue(store, {
  kind: "llm.generate",
  audience: "self",            // this user's machine only
  owner: userId,
  payload: { prompt: "Summarize this transcript:\n\n" + transcript },
});

// resolves via your delivery channel (webhook / Realtime / poll),
// with a timeout and a noRunnerAvailable path — never a bare await
const { text } = await job.result({ onNoRunner: promptUserToConnect });
```

That's the whole integration: **one route, one store, one `enqueue`.** If no daemon is online, you get a `noRunnerAvailable` signal (fall back to a hosted model, or prompt the user to connect) — never a promise that hangs forever.

### For users

```bash
npx byollm connect https://your-app.com     # opens a browser to pair — one click
byollm status                                # what's connected, what's running
```

Point it at your models:

```jsonc
// byollm.config.json
{
  "backends": {
    "ollama":  { "scope": "self" },                 // or "named" / "public" for open models
    "claude":  { "scope": "self" }                  // subscription CLIs are locked to "self"
  },
  "routes": {
    "llm.generate": "ollama:qwen3-14b",
    "llm.chat":     "claude:cli"
  }
}
```

```bash
byollm log            # every prompt that ran here, ever
byollm pause          # stop claiming work
```

## The audience model — sharing, safely

Every job carries an **audience** and every backend an **offer scope**. A job runs on a machine only when both agree.

| Backend | Can offer | Why |
|---|---|---|
| **Ollama, MLX, llama.cpp** (open models) | `self` → `named` (friends) → `public` (anyone) | Donated compute for open models — the folding@home posture. No provider terms in play. |
| **claude CLI & other subscription accounts** | `self` **only, enforced** | One account runs one person's work. This is a protocol MUST, not a setting. |

Want to lend your GPU to the open-source community, or let your friends' jobs run overnight on your machine? Flip an open backend to `public` or `named`. Your subscription is never part of that.

## Security

The daemon runs prompts on the owner's machine, so **every payload is treated as hostile input**. Breakout is made *structurally impossible*, not merely detected:

- Payload text can **never become a command line**. HTTP-class backends (Ollama, MLX server, vLLM) receive it as a request body; process-class backends (`claude` CLI) receive it on **stdin with a fixed argv**. Shell metacharacters, `--flags`, `$(…)` are just characters the model reads.
- Model, backend, and flags come from the **owner's local config only** — a job can never name a model, path, URL, or flag.
- Backends spawn with a stripped environment, an empty scratch dir, no inherited file descriptors, and hard timeout/output caps.
- The daemon exposes **no tools, no retrieval, no MCP** to the model. Output is inert bytes — never eval'd, never written to a payload-named path.

A named **adversarial test corpus** (command injection, argv injection, path traversal, env exfiltration, oversized/unicode payloads) runs as a blocking CI gate, and every backend must ship its own hostile-payload suite before it can be added. See [`docs/security.md`](docs/security.md).

We're precise about the boundary: BYOLLM makes **breakout** impossible; **prompt injection** (steering the model's *words*) is the model's problem, bounded here because the model has no tools and the output is inert. We don't promise more than we can keep.

## Packages

| Package | What it is |
|---|---|
| [`@byollm/protocol`](packages/protocol) | The wire contract — types, schemas, the normative spec. |
| [`@byollm/daemon`](packages/daemon) | What users run (`npx byollm`). Backends, routing, the trust log. |
| [`@byollm/server`](packages/server) | Drop-in handlers + a Supabase adapter for your backend. |
| [`@byollm/conformance`](packages/conformance) | The compatibility contract — certify any server with one command. |

A server is **byollm-compatible** when the conformance kit passes against it. That sentence is the whole versioning story — no framework version to chase.

## Status

Pre-release, built in the open. The protocol is at v0 and the audience model is settled; the daemon ships `self`-only first with `named`/`public` as a fast follow. Not yet published to npm — watch this repo.

## Contributing

The bar is CI-enforced, not review-vigilance: strict TypeScript, ≥90% coverage on the protocol and server, zero-warning lint, no dead code, and docs whose examples execute in CI so they can't rot. See [`docs/standards.md`](docs/standards.md) and the specs in [`specs/`](specs).

## License

MIT.

<div align="center"><sub>Built by <a href="https://oftomorrow.dev">Of Tomorrow</a> — the pattern behind our own apps, opened up.</sub></div>
