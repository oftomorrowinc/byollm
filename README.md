> [!WARNING]
> **`0.1.0` — early.** The protocol is version 2 as of 0.1.0; the
> software is still early. These packages run one hosted service —
> byollm.cloud — and a small number of integrations; beyond that they
> have little mileage, and most of what we know about the failure modes
> we learned from the first people to try.
>
> **Formats change, and a change may require re-pairing.** On-disk shapes
> (the pairings file), wire fields and the routing store's keyspace are still
> moving, and while the only deployment is ours they move in **one** release
> rather than three: transitional code exists to protect a party who has not
> agreed to change, and today that party is us. The slow procedures —
> dual-read for a keyspace, N/N+1 for a wire field, three releases for an
> on-disk format — are written down and turn on with the first outside user.
> If an upgrade leaves a daemon saying it is paired with nothing, `byollm
> connect` is the answer and nothing else is lost.

<div align="center">

# BYOLLM

**Bring Your Own LLM.** Let your app's users run its AI on *their* models and *their* subscriptions — their Ollama box, their Mac running MLX, their `claude` CLI — through a tiny daemon they run and control.

`npx byollm@latest connect https://your-app.com`

[![npm](https://img.shields.io/badge/npm-%40byollm-cb3837)](https://www.npmjs.com/org/byollm) · [![license](https://img.shields.io/badge/license-MIT-blue)](#license) · [![status](https://img.shields.io/badge/status-early-orange)](#status)

</div>

---

## Why

Every AI app eventually gets the same request: *"can I use my own model / my own key / my own GPU?"* Answering it usually means CORS headaches, tunnels into localhost, or shipping the user a fragile script.

BYOLLM makes it a three-line integration. Your app enqueues LLM jobs; the user runs a small **outbound** daemon that claims *only their own jobs* and executes them locally. No inbound ports, no tunnels, no keys leaving the device. The browser app stays hosted; the compute comes from the user.

Two audiences, one design:

- **App developers** get a drop-in server adapter and a job queue. Enqueue `llm.generate`, get a result back — you never touch the user's model or credentials.
- **Users** get a daemon that is their **trust anchor**: every prompt that runs on their device is logged, rate-limited, and pausable, and subscription-backed models are hard-locked to *their own work only*.

## How it works

```
   your web app  ──enqueue job──▶  your backend (@byollm/server)
                                          │
                                          │  jobs table (yours: Supabase, Postgres, memory…)
                                          ▼
   user's device   ──outbound poll──▶  claim ─▶ run on local model ─▶ result
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
import { getConfig } from "@/lib/byollm";

// A function, not an object: `next build` imports this module with no secrets
// in the environment, and must not construct anything.
export const { POST } = createHandler(getConfig);
```

```ts
// lib/byollm.ts
import { ByollmApp, MemoryStore, siteKeysFromEnv } from "@byollm/server";

let shared: { store: MemoryStore; app: ByollmApp } | undefined;

function get() {
  if (!shared) {
    const store = new MemoryStore();
    // Generate once with `npx --package @byollm/server keygen` — never at startup,
    // or each instance gets a different identity and paired daemons break.
    const siteKeys = siteKeysFromEnv("BYOLLM_SITE_KEYS");
    shared = { store, app: new ByollmApp({ store, siteKeys }) };
  }
  return shared;
}

export const getApp = () => get().app;
export const getConfig = () => ({
  store: get().store,
  siteKeys: siteKeysFromEnv("BYOLLM_SITE_KEYS"),
  verificationUrl: "https://your-app.com/settings/runners",
});
```

```ts
// anywhere in your app
const job = await getApp().enqueue({
  kind: "llm.generate",
  audience: "private",         // this user's device only
  owner: userId,
  payload: { prompt: "Summarize this transcript:\n\n" + transcript },
});

// resolves via your delivery channel (webhook / Realtime / poll),
// with a timeout and a noRunnerAvailable path — never a bare await
const { outcome } = await job.result({
  // Return something and the wait resolves with it, labelled `fallback: true`.
  onNoRunner: (reason) => hostedModelAnswer(prompt, reason),
});
```

That's the whole integration: **one route, one store, one `enqueue`.** If no daemon is online you get a `noRunnerAvailable` signal — never a promise that hangs forever.

**`onNoRunner` decides which of two things happens.** Return a string (or a
full result) and the wait resolves with it, stamped `fallback: true` so a
hosted answer can never be reported as the user's own compute. Return nothing
— including from a handler that only prompts the person to connect — and
`NoRunnerAvailableError` is thrown instead, so catch it:

```ts
try {
  const { outcome } = await job.result({
    onNoRunner: async () => { await showConnectModal(); },
  });
} catch (error) {
  if (error instanceof NoRunnerAvailableError) return renderConnectPrompt();
  throw error;
}
```

### For users

```bash
npx byollm@latest connect https://your-app.com   # opens a browser to pair — one click
byollm status                                # what's connected, what's running
```

Point it at your models:

```json
{
  "services": {
    "local": {
      "type": "ollama",
      "baseUrl": "http://127.0.0.1:11434/v1",
      "model": "gemma3:12b",
      "kinds": ["llm.generate"],
      "offer": "private"
    },
    "claude": {
      "type": "claude-cli",
      "model": "claude-opus-5",
      "kinds": ["llm.chat"],
      "offer": "private"
    }
  }
}
```

That lives in `~/.byollm/config.json`, and `byollm services manage` writes it
for you if you would rather not. **To change which model a service uses, edit
its `model` and restart the daemon** — a running daemon reads this file once at
start, so an edit alone changes nothing. (On a hosted box you cannot do either:
the console runs a fixed list of commands. Hosted boxes run Opus.) `type` is the provider: name it and byollm can
start that server when a job needs it. `openai-http` is the generic transport
for a server byollm does not know by name — it works, and nothing can be
started for it. `offer` is `private` for your own work or `team` to share;
subscriptions are locked to `private` whatever the file says.

```bash
byollm services       # what's installed, healthy, advertised — and who each is offered to
byollm sites          # which sites this device serves, and which keys it holds
byollm log            # every prompt that ran here, ever
byollm stop           # stop claiming work — the off switch, always yours
byollm offer <service> team --cap 250     # share a paid service, deliberately
```

## The audience model — sharing, safely

Every job carries an **audience** and every backend an **offer scope**. A job runs on a device only when both agree.

| Backend | Cost | Can offer | Why |
|---|---|---|---|
| **Ollama, MLX, llama.cpp, vLLM, LM Studio** | `free` | `private` → `team` | Local compute. Costs electricity, not money. |
| **Anthropic, OpenAI, Gemini, Grok, Groq, OpenRouter…** | `metered` | `private` by default; `team` only with an explicit spend acknowledgment **and** a daily ceiling | Your API key, your money, per token. Sharing it is legitimate and ruinous by accident. |
| **claude CLI & other subscription accounts** | `subscription` | `private` **only, enforced** | One account runs one person's work. A protocol MUST, not a setting. |

Cost class comes from the protocol registry and is **not yours to declare**. Point the generic `openai-http` backend at a remote endpoint and it is `metered` no matter what you call it — "free" is derived from the address the request is sent to, not from the config. That is the one rule that makes the rest enforceable.

Note the pair: `anthropic` and `claude-cli` reach one vendor in two different cost classes. A platform key bills per token; a Claude plan covers one person's work. The axis asks who pays and under what terms, not which company answers.

The derivation reads the address, not the destination — a localhost proxy forwarding to a paid API classes as `free`, and nothing downstream can see through it. That is a deliberate act by the device's owner against their own account, and it is [outside the threat model](docs/security.md#4a-cost-class--whose-money-and-whose-terms); what the rule prevents is the *accident*.

Want your friends' jobs to run overnight on your computer? `byollm offer <service> team` flips an open service over to the people your relay admits. Your subscription is never part of that, and there is no scope that opens a device to people it cannot check.

Widening a **paid** backend is the one path that asks first, and the question names the money rather than asking whether you are sure:

```bash
$ byollm offer openai team --cap 250

This lets other people's jobs run on OpenAI (your API key), which bills
your account per token. You would be paying for their work, up to
$2.50 a day, every day, until you change it.
Spending stops at that ceiling and resumes the next day.

Offer openai to anyone? [y/N]
```

Sharing a metered backend without a ceiling is refused outright — an unlimited one is not something anyone means on purpose. Narrowing back to `self` withdraws the consent too, so widening again has to be agreed to again.

`team` is enforced by **your** daemon, not by the app. Every job arrives with a grant signed by the control plane your device pinned when it paired, naming the site, the person, the job and the service — and your device verifies that signature, checks the grant has not been used before, checks the service is one it actually offers to that person, and refuses outright if the service is `private`. A device with no relay paired serves its owner and nobody else, because nothing there could tell it who anybody else is.

## Security

The daemon runs prompts on the owner's computer, so **every payload is treated as hostile input**. Breakout is made *structurally impossible*, not merely detected:

- Payload text can **never become a command line**. HTTP-class backends (Ollama, MLX server, vLLM) receive it as a request body; process-class backends (`claude` CLI) receive it on **stdin with a fixed argv**. Shell metacharacters, `--flags`, `$(…)` are just characters the model reads.
- Model, backend, and flags come from the **owner's local config only** — a job can never name a model, path, URL, or flag.
- Process-class backends spawn with a stripped environment (no `ANTHROPIC_API_KEY`), an empty scratch dir, no inherited file descriptors, and hard timeout/output caps. HTTP-class backends spawn nothing at all.
- The daemon exposes **no tools, no retrieval, no MCP** to the model. Output is inert bytes — never eval'd, never written to a payload-named path.

A named **adversarial test corpus** (command injection, argv injection, path traversal, env exfiltration, oversized/unicode payloads) runs as a blocking CI gate, and every backend must ship its own hostile-payload suite before it can be added. See [`docs/security.md`](docs/security.md).

We're precise about the boundary: BYOLLM makes **breakout** impossible; **prompt injection** (steering the model's *words*) is the model's problem, bounded here because the model has no tools and the output is inert. We don't promise more than we can keep.

## Packages

<!-- packages:start -->

| Package | What it is |
|---|---|
| [`byollm`](packages/daemon) | The daemon — runs models on your own machine and answers for it. |
| [`@byollm/protocol`](packages/protocol) | The wire: envelopes, signatures and the closed vocabularies both ends validate against. |
| [`@byollm/server`](packages/server) | The SDK a site uses to ask a device for work. |
| [`@byollm/relay`](packages/relay) | The broker that holds jobs between a site and a device, and can read neither. |
| [`@byollm/control-plane`](packages/control-plane) | Who may ask whom, and the policy store behind it. |
| [`@byollm/conformance`](packages/conformance) | The kit that proves an implementation is one — including a posture audit that holds nothing but a URL. |

Six packages, versioned and released together.

### Where the rest lives

- [GitHub](https://github.com/oftomorrowinc/byollm) — the source, and where issues go
- [byo-llm.com](https://byo-llm.com) — what this is, and why
- [byollm.cloud](https://byollm.cloud) — the hosted relay — devices, consent and billing
- [docs.byollm.cloud](https://docs.byollm.cloud) — integrating a site, end to end

<!-- packages:end -->

A server is **byollm-compatible** when the conformance kit passes against it. That sentence is the whole versioning story — no framework version to chase.

## Status

**Early, built in the open.** The packages are listed above, and `npm install byollm` resolves to this release.

The protocol is at v0 and the audience model is settled, but v0 means what it says: it will change without a deprecation path. A device serves its owner alone until it is paired with a relay and its owner shares a service deliberately. Backends at v1: `openai-http` for any OpenAI-compatible server (Ollama, MLX, llama.cpp, vLLM, LM Studio and the rest), the CLI backends `claude-cli` and `codex-cli`, and named ids for the hosted vendors — the full set is `BACKEND_IDS` in `@byollm/protocol`.

What exists: a large test suite, an adversarial corpus wired as a blocking CI gate, and a conformance kit green against both the in-memory reference and real Postgres. What does not exist: a single production mile. Wait for `latest`.

## Contributing

```sh
pnpm install
pnpm run verify     # format, build, smoke, lint, typecheck, tests, coverage, dead code
```

**Run `pnpm run build` before any bare `tsc`.** Every package resolves its
neighbours through the `types` field in their `package.json`, which points at
`dist/` — so on a clean checkout `tsc -p packages/daemon` reports that
`@byollm/protocol` does not exist, and the wall of errors that follows reads
exactly like a half-finished migration. It cost an external contributor a
wrong diagnosis in a PR description, which is how this paragraph came to be
here. `pnpm run typecheck` now builds first, so it is safe on its own;
`pnpm exec tsc` still is not.

The bar is CI-enforced, not review-vigilance: strict TypeScript, ≥90% coverage on the server and ≥85% on the daemon, zero-warning lint, no dead code, and the conformance kit green against both the reference server and Supabase on every PR. `@byollm/protocol` is gated by the conformance kit rather than a line-coverage number, which on a types-and-schemas package is trivially met or gamed. The adversarial corpus is a separate blocking gate, and the demo in [`examples/`](examples) runs in CI so it can't rot. See [`docs/standards.md`](docs/standards.md) and the specs in [`specs/`](specs).

## Thanks

An alpha only gets bulletproof when people lend it their machines, their
subscriptions, and their patience. Ours got that from Eric Marcoullier,
David Sturgeon, Robertson Price, Kevin Samsoe, and Elisabeth Sampson —
walking the rough edges, filing the bugs, and in more than one case
finding the ones we're gladdest didn't reach you. This list grows.

## License

MIT.

<div align="center"><sub>Built by <a href="https://oftomorrow.net">Of Tomorrow</a> — the pattern behind our own apps, opened up.</sub></div>
