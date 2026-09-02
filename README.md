> [!WARNING]
> **Alpha (`0.1.0-alpha.68`) — under active development. Don't use this yet.**
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
> **Formats change, and a change may require re-pairing.** On-disk shapes
> (the pairings file), wire fields and the routing store's keyspace are still
> moving, and while the only deployment is ours they move in **one** release
> rather than three: transitional code exists to protect a party who has not
> agreed to change, and today that party is us. The slow procedures —
> dual-read for a keyspace, N/N+1 for a wire field, three releases for an
> on-disk format — are written down and turn on with the first outside user.
> If an upgrade leaves a daemon saying it is paired with nothing, `byollm
> connect` is the answer and nothing else is lost.
>
> **`alpha.58` — sites declare what they need; they no longer name what runs
> it.** Breaking on every surface, and the largest change since alpha.44.
>
> `enqueue({ service })` is gone. A site registers a **manifest** — purposes
> it declares, each listing the job kinds it uses — and each of your users
> maps those purposes to their own services on the consent screen. A job names
> a purpose; the mapping does the rest. Your site never learns which service,
> which model or whose machine answered: it learns whether a slot was
> satisfiable, and nothing else.
>
> ```jsonc
> // registered once, by the site
> { "revenue": { "label": "Revenue", "kinds": ["llm.generate"] } }
> ```
> ```ts
> await app.enqueue({ kind: "llm.generate", purpose: "revenue", owner, payload });
> ```
>
> **Why this is not a rename.** Naming a service put the device owner's
> vocabulary on the wire, which meant refusals had to be carefully identical
> so a site could not probe names and enumerate somebody's machine. That
> vocabulary no longer crosses the boundary at all, so there is nothing to
> probe — the guarantee stopped being a rule anybody had to keep and became
> the shape of the wire.
>
> **Admission changed underneath it.** A device no longer holds a list of who
> may use it. Every job arrives with a short-lived, single-use **grant**,
> signed by the control plane your device pinned when it paired, naming the
> site, the person, the job and the service to run. Add somebody to your team
> and their next job runs; remove them and their next claim fails, including
> work already queued. `byollm allow`, `byollm disallow` and `byollm approve`
> are gone and leave tombstones pointing at where those decisions live now.
>
> **A device with no relay serves its owner and nobody else**, because nothing
> there can tell it who anybody else is. A `team` offer on such a machine
> narrows to `private`, and says so.
>
> `public` is gone as an offer scope and an audience, in OSS too. It was the
> one value that ran a stranger's job *without the device checking who they
> were* — an off switch for admission wearing a wider setting's clothes.
>
> **`alpha.52` — a device that is running and invisible now says so, and
> `byollm offer` no longer disagrees with the daemon about what a service
> costs.**
>
> **If you shared a cloud-tagged model and it snapped back, this is why.**
> `byollm offer <service> team --cap N` computed the service's cost without
> its model, so `glm-5.2:cloud` on a local address looked free: no consent was
> asked for, `--cap` was discarded, and the daemon — which does read the model
> — refused the share and told you to run the command you had just run. Both
> halves read the same three things now, and a `--cap` the command will not use
> is an error rather than a silent drop.
>
> **`byollm status` leads with whether the hub is listening.** After six
> consecutive rejected messages it says `NOT REPORTING` and names what the hub
> said, because `state: running` was true for hours on a device whose every
> heartbeat was refused. It also says, out loud, that everything below is what
> the device believes rather than what the hub has been told.
>
> Services print on three short lines instead of one long one, so nothing
> wraps: the widest line is 68 columns, down from 86.
>
> **`alpha.51` makes service selection actually work.** If you are using
> `enqueue({ service })`, this is the release that makes it do what alpha.48
> said it did.
>
> A device advertised only the service that *won* each kind, so the router had
> nothing else to match a selection against — naming any other service was
> refused as unadvertised. Selection worked for exactly the service you would
> never need to name. A device now advertises every service it declares, with
> a marker saying which one an unselected job takes.
>
> **`defaults` changed meaning slightly, and in your favour.** A kind two
> services answer with no default chosen used to advertise neither. Both are
> selectable by name now; what has no answer is a job that named neither. A
> job naming a service was never ambiguous, and refusing it punished a site for
> a decision the device's owner had not made about something else.
>
> `byollm status` says "default for" and "selectable for" apart, because those
> were one sentence and are two facts. Its `routes` section is gone — it
> restated what the service lines already say.
>
> **`alpha.50` — the background daemon can find your CLIs. Reinstall the
> service after upgrading:** `byollm uninstall && byollm install`.
>
> A supervised daemon runs with the service manager's environment, not yours.
> launchd hands an agent `/usr/bin:/bin:/usr/sbin:/sbin`, and `claude` installs
> to `~/.local/bin` — so the daemon could not find it, the health probe failed,
> and the service was never advertised. Your device offered only whatever else
> it could reach, and nothing said why: "not installed" is a legal answer to a
> health probe, and the daemon cannot tell it from "installed somewhere I
> cannot see". systemd user units had the same gap.
>
> `byollm install` now captures your shell's PATH. It is a snapshot — install a
> CLI somewhere new and run it again.
>
> **`byollm services` no longer speaks for the daemon.** It said "healthy and
> will be advertised", which is a promise only the daemon can make, and on the
> machine that found this it was false: the command probed with the user's PATH
> and reported a CLI the daemon could not execute. It says "healthy from this
> shell" now, and when a service is installed it says so and points at the
> device's page. PATH was one divergence; a different user, a different HOME
> and a credential a login shell can see are others.
>
> `byollm status` also lists every service and your `defaults`, not only the
> routes that resolved — a service displaced by another kind's default used to
> appear nowhere at all.
>
> **`alpha.49` fixes what the wizard writes, and makes `enqueue` refuse
> options it does not understand.** Breaking only in the second sense, and
> deliberately.
>
> **If you ran `byollm setup` before this, your config has settings you were
> never asked about.** It wrote the answers *plus* every default the schema
> filled in — `concurrency`, the community and ingress blocks, a per-service
> `offer`. Those are today's values frozen into your file, so a later change to
> any of them will not reach you. Nothing is broken; delete the lines you did
> not choose and the daemon supplies them again. The wizard now writes only
> what it asked you.
>
> `byollm setup` also finds local model servers by asking them — one request
> per well-known port, and it offers whatever answered, with the models that
> server named. Multi-select, and it writes the server's own address rather
> than a guess.
>
> **`enqueue` now throws on an option it does not know**, instead of ignoring
> it. If you call it with a field your installed `@byollm/server` predates —
> `service`, most likely — you now get an error naming the field instead of a
> job that quietly runs differently than you asked. That silence is the reason
> for the change.
>
> `runnerAvailability` reports one `selection-unavailable` where it briefly
> reported two reasons. A name nobody advertises and a name not offered to you
> must answer identically, or trying names and sorting the replies enumerates
> somebody else's device.
>
> **`alpha.48` finishes service selection through the SDK.** Not breaking.
>
> `app.enqueue({ kind, service? })` — a site may name one of the device
> owner's advertised services, and the name travels to the device that runs it.
> Leave it out and the owner's default answers, which is every job written
> before this. You will not usually know the name: it is for the case where a
> person has told your app which of *their* services to use.
>
> `runnerAvailability` learned three new answers, so an app can tell apart
> problems with different fixes: `no-such-service` (the kind is served, that
> name is not), `awaiting-default` (two services answer it and the owner has
> not chosen), and `default-unusable` (the owner's default can never serve this
> requester). Previously all three read as "no matching capability", which sent
> everybody looking for a missing install.
>
> Supabase adapter: one nullable column, `byollm_jobs.service`. Nothing to
> backfill — the null already means "the owner's default", which is what every
> existing job meant.
>
> **`alpha.47` adds `byollm setup` and the Codex CLI.** Neither is breaking.
>
> `byollm setup` asks three questions and writes `~/.byollm/config.json` for
> you — device name, which of your subscription CLIs to use, and whether you
> want a local model. It refuses to touch a config that already exists, so
> running it on a working install tells you what you have and changes nothing.
> It needs a real terminal; piped into it, it declines rather than answering
> its own questions.
>
> **Codex CLI** joins Claude Code as a subscription backend, locked to your own
> work by `SUBSCRIPTION_SELF_LOCK`. Codex is an *agent*, and its default
> feature set has a shell tool, browser control and computer use all on — the
> daemon disables every one of them and there is a check that reads a canary
> file with the real binary to prove they stay off. `byollm_004` §2's
> no-tools rule holds for it unchanged.
>
> **Gemini CLI is not supported, and that is a finding rather than a gap.** Its
> built-in file access cannot be disabled: `--approval-mode=plan`,
> `--allowed-tools ""`, `--policy` deny-all and both `--admin-policy` shapes
> were each tried against the shipped binary, and it read a canary file every
> time. Our isolation rules require that no tool be reachable from a prompt, so
> a backend that can read your files does not qualify. Tested against the
> version current in August 2026; we re-test on new releases, and if that
> changes, support returns.
>
> **`alpha.46` lets a site name a service.** `enqueue` takes an optional
> `service`, and a job that names one runs only on a device advertising that
> exact service for that kind — never a fallback to something else. Absent
> means the owner's default, which is every job written before this release,
> so nothing changes unless you opt in.
>
> Breaking only if you implement `RoutingStore`: `ClaimInput` gains `serves`,
> the (kind, service) pairs a device advertises, and `kinds` narrows to the
> kinds it has a *default* for. The store contract asserts both, so
> `byollm-certify` tells you rather than a user does.
>
> **What a site may and may not say.** The field is a *key* the owner chose,
> never a value: no model, no base URL, no flags cross the wire, and a name
> the owner does not advertise is refused rather than quietly served by
> something else. That is `NO_PAYLOAD_ROUTING` amended rather than weakened —
> selection is permitted, description is not, and the field is on the stub
> where a prompt cannot reach it.
>
> **`alpha.45` carries withheld kinds on the heartbeat.** Breaking only if you
> implement `RoutingStore` yourself: `Presence` gains a required `withheld`
> field, so `seen()` takes one more property and your store must round-trip it.
> The store contract asserts it, so `byollm-certify` tells you rather than a
> user does.
>
> Why it exists: when two services answer one kind and no `defaults` entry
> picks a winner, alpha.44 withholds the kind — correctly — but from the
> server's side a withheld kind and an absent one are the same shape. Without
> this the owner's page can only say "nothing serves llm.generate", which is
> true and useless, instead of "two services answer it and you have not
> chosen". Nothing changes for sites or for daemons that do not run a relay.
>
> **`alpha.44` replaces the config shape. Every existing `~/.byollm/config.json`
> must be rewritten — there is no compatibility path, and the daemon refuses the
> old one by name rather than failing with a schema error.**
>
> `backends` and `routes` are gone. A backend and the route that pointed at it
> were always one decision written in two places; they are now one **service**:
>
> ```json
> {
>   "services": {
>     "ollama": {
>       "type": "openai-http",
>       "baseUrl": "http://127.0.0.1:11434/v1",
>       "model": "llama3.2",
>       "kinds": ["llm.generate", "llm.chat"],
>       "offer": "private"
>     }
>   }
> }
> ```
>
> What that costs you, concretely:
>
> - **Two services can answer the same kind now** — that is the point of the
>   change. When they do, neither is advertised until you name the winner in
>   `defaults`: `"defaults": { "llm.generate": "ollama" }`. An unresolved kind
>   is *withheld*, not silently assigned, and `byollm services` prints which
>   services are contending. Guessing on your behalf is how a job ends up on the
>   metered backend you were saving.
> - **`byollm backends` is now `byollm services`**, and rows lead with the
>   service name rather than the backend id.
> - **One sharing vocabulary: `private | team`.** `self`, `named` and `paid` are
>   gone as scope words. `byollm offer <service> <scope>` takes the new set.
> - **`public` is gone**, in direct mode too. Not deprecated — removed. It was
>   the one scope that ran a stranger's job *without the device checking who
>   they were*, which made it an off switch for admission rather than a wider
>   setting. Every scope that remains asks a question.
>
> **That gap is closed.** `offer: "team"` used to be enforced by a device-local
> allowlist, so adding a teammate on your team page did nothing until you also
> enrolled them on each machine. Admission is now a **signed grant, authored at
> claim**: add somebody and their next job runs; remove them and their next
> claim fails, including work already queued. The device verifies that grant
> against a key it pinned at pairing, so the party routing the job still cannot
> author one. Do not read this
> release as "team sharing works."
>
> **If you use the cloud lane, the hub has to move with you.** The hub speaks
> the old vocabulary until it is redeployed against this release, and its
> schemas do not contain the words `private` or `team`. Two consequences while
> it is behind: a daemon on alpha.44 does not appear on the devices page at
> all, because its heartbeat fails validation; and a `private` or `team` job
> queues and is never claimed. Both fail closed — nothing is offered to anyone
> it should not be — but both fail *quietly*, so a job that never runs is the
> symptom you would see. Direct mode is unaffected: no hub, no lockstep.
>
> **Still queued: a terminal answer for a job whose record is gone.** A site
> polling for a job the relay no longer holds waits out its deadline instead of
> being told. Saying "gone" rather than "unknown" needs the store to remember
> that a job existed and expired — a tombstone with its own horizon, and a
> decision about how that horizon relates to `deadlineAt`. It was cargo for this
> release and did not fit; it rides the next change to that seam. It has not
> fallen off the board.
>
> **`alpha.7` tightens who a device is allowed to say it is.** A relay now
> refuses to pair a device its owner has not approved in a control plane —
> previously a daemon presented keys and the relay believed them, which made
> the relay the authority on identity rather than the person who owns the
> device. Breaking only if you operate a relay; direct-mode sites and daemons
> are unaffected and nothing re-pairs.
>
> **`alpha.5` added the reference relay and the cloud lane.** `app.enqueue(...)`
> is identical whether a site talks to daemons directly or routes through a
> relay — the lane is a config field. Breaking only if you wrote your own
> `JobStore`: see [`@byollm/server`](packages/server) for the two methods that
> changed. byollm_009 is **frozen** as of this release, after eight findings
> that only a real consumer produced.
>
> **`alpha.4` was the breaking one. Every paired runner had to pair again, and
> there was no upgrade path — by design, and for the last time before there are
> real consumers.**
>
> Devices and sites now have cryptographic identities. Each daemon holds an
> Ed25519 signing key and an X25519 encryption key; pairing exchanges and
> **pins** them, every request is signed rather than bearing a token, and the
> work itself is sealed: a payload is encrypted to the device that claimed it,
> a result is encrypted back to the site, and each is signed by its sender and
> refused if it does not verify. An intermediary that relays byollm traffic
> carries ciphertext it cannot read and cannot substitute.
>
> What that costs you, concretely:
>
> - **A site now needs a keypair.** Generate one — once — with
>   `npx @byollm/server@alpha keygen`, and set `BYOLLM_SITE_KEYS`. Not at
>   startup: every instance would get a different identity and daemons would
>   pin one and be refused by another.
> - **Runner tokens are gone.** A daemon proves who it is by signing, so old
>   tokens authenticate nothing and every paired device re-pairs.
> - **`claim` answers with a stub, not the work.** A daemon that declines a job
>   never receives the prompt at all; it fetches the payload only after
>   deciding to run it.
> - **Next.js users:** `createHandler` now takes a *function*. See
>   [`@byollm/server`](packages/server) — an object is constructed during
>   `next build` and fails on credentials it cannot have.
>
> See [byollm_009](specs/byollm_009-sessions-keys-envelopes.md), including §12
> for what an upstream can still observe.


<div align="center">

# BYOLLM

**Bring Your Own LLM.** Let your app's users run its AI on *their* models and *their* subscriptions — their Ollama box, their Mac running MLX, their `claude` CLI — through a tiny daemon they run and control.

`npx byollm@alpha connect https://your-app.com`

[![npm](https://img.shields.io/badge/npm-%40byollm-cb3837)](https://www.npmjs.com/org/byollm) · [![license](https://img.shields.io/badge/license-MIT-blue)](#license) · [![status](https://img.shields.io/badge/status-alpha-orange)](#status)

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
    // Generate once with `npx @byollm/server@alpha keygen` — never at startup,
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
  "services": {
    // One HTTP type covers Ollama, MLX, llama.cpp and vLLM — they all speak
    // OpenAI-compatible /v1/chat/completions. Configure as many as you run.
    "local":  { "type": "openai-http", "baseUrl": "http://127.0.0.1:11434/v1",
                "model": "gemma3:12b", "kinds": ["llm.generate"],
                "offer": "private" },               // or "team" to share it
    "claude": { "type": "claude-cli", "model": "claude-opus-5",
                "kinds": ["llm.chat"] }             // subscriptions are locked to "private"
  }
}
```

```bash
byollm services       # what's installed, healthy, advertised — and who each is offered to
byollm sites          # which sites this device serves, and which keys it holds
byollm log            # every prompt that ran here, ever
byollm pause          # stop claiming work — the off switch, always yours
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

| Package | What it is |
|---|---|
| [`@byollm/protocol`](packages/protocol) | The wire contract — types, schemas, the normative spec. |
| [`byollm`](packages/daemon) | What users run (`npx byollm@alpha`). Backends, routing, the trust log. |
| [`@byollm/server`](packages/server) | Drop-in handlers + a Supabase adapter for your backend. |
| [`@byollm/conformance`](packages/conformance) | The compatibility contract — certify any server with one command. |

A server is **byollm-compatible** when the conformance kit passes against it. That sentence is the whole versioning story — no framework version to chase.

## Status

**Alpha, built in the open.** All four packages are published — `byollm`, `@byollm/protocol`, `@byollm/server` and `@byollm/conformance` — and you should ask for `@alpha` explicitly. npm assigns `latest` on a first publish and refuses to let it be removed, so a bare `npm install byollm` resolves here too; the warning at the top of this file is the guard, deliberately rather than an npm deprecation, which would say *abandoned* when the truth is *early*.

The protocol is at v0 and the audience model is settled, but v0 means what it says: it will change without a deprecation path. A device serves its owner alone until it is paired with a relay and its owner shares a service deliberately. Backends at v1: `openai-http` (Ollama, MLX, llama.cpp, vLLM) and `claude-cli`.

What exists: 421 tests, an adversarial corpus wired as a blocking CI gate, and a conformance kit green against both the in-memory reference and real Postgres. What does not exist: a single production mile. Wait for `latest`.

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

## License

MIT.

<div align="center"><sub>Built by <a href="https://oftomorrow.dev">Of Tomorrow</a> — the pattern behind our own apps, opened up.</sub></div>
