> [!WARNING]
> **Alpha (`0.1.0-alpha.76`) — under active development. Don't use this yet.**
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
> remote base URL and an offer scope wider than `private` is narrowed to `private`
> until you acknowledge the spend and set a daily ceiling:
> `byollm offer <backend> public --cap <cents>`. Local base URLs are
> unaffected. `byollm backends` shows the cost class per route.

<!-- release-note 0.1.0-alpha.21 -->
> [!NOTE]
> **`0.1.0-alpha.20` is not a complete release — do not pin it.** Four
> packages published and `@byollm/server` did not: a Sigstore
> transparency-log 409 on its provenance attestation. The workflow's
> "already published" guard correctly refuses to resume a partial publish,
> so `0.1.0-alpha.21` is that release, whole.
>
> If you run the Supabase adapter, `alpha.21` needs
> `20260819010000_completed_by_lease_id.sql`: alpha.19 shipped §3.6's
> ordering without the column it stores the grant in.

<!-- release-note 0.1.0-alpha.40 -->
**`byollm install` — stop keeping a terminal open.** The daemon can now run
under your computer's own supervisor and restart itself if it stops: a launchd
agent on macOS, a `systemd --user` unit on Linux, a logon task on Windows. All
user-level — no root, no system directories, and `byollm uninstall` takes it
away. `byollm status` gained a line saying whether it is actually supervised
right now, including the state that matters most: installed but not running,
which looks fine from an app's dashboard and serves nothing.

If you are running via `npx`, install properly first (`npm install -g
byollm@alpha`) — `install` refuses to supervise a copy in npx's cache, because
npm deletes that directory and the service would fail at some later boot.

<!-- release-note 0.1.0-alpha.41 -->
**`onNoRunner` takes a string.** Your fallback answer is your own value, not
wire data, and handing back a whole result record for it was ceremony — the
README's own example got the shape wrong, which is how this was found.

```ts
const { outcome, fallback } = await job.result({
  onNoRunner: () => runOnHostedModel(transcript),
});
```

Whatever you return, `result()` labels it `fallback: true` — the stamp is
applied by the wait, not taken from you, so an answer that did not run on
somebody's device cannot be reported as though it did (`FALLBACK_LABELED`).
Both delivery channels do it, polling and Supabase Realtime. Records still
work; they just get labelled too.

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

A job's `kind` selects a route **you defined**, and a job can never name a
model, a URL, a path or a flag — there is no field on the wire for any of
them. It cannot name one of your services either: a site declares what it
*needs*, you decide which of your services answers that need, and the job
carries the site's word for the need rather than yours for the answer.

`byollm services` shows what is configured, what is healthy, what each one
answers, and which is your own default. A service that is down is never
advertised, so you never get work you cannot run.

## Keep it running

By default `byollm connect` and `byollm run` hold a terminal — close the
window and the device stops serving. Nothing breaks (your pairings live in
`~/.byollm/pairings.json` and survive), but the device goes quiet without
telling anyone, and if it is on a team's roster, the first person to notice is
a teammate whose job did not run.

```bash
byollm install     # keep running in the background, and restart if it stops
byollm status      # says whether it is actually supervised right now
byollm uninstall
```

It installs at the user level on every platform — a launchd `LaunchAgent` on
macOS, a `systemd --user` unit on Linux, a logon task on Windows. No root, no
system directories: it runs as you, it stops when you say so, and you can read
every file it wrote. Output goes to `~/.byollm/service.log` on all three.

Two things worth knowing:

- **Install `byollm` properly first.** `byollm install` refuses to supervise a
  copy running from `npx`'s cache, because npm deletes that directory without
  warning and the service would stop working at some later boot with nothing
  to show for it. `npm install -g byollm@alpha` first.
- **On Linux, `systemd --user` stops when you log out** unless lingering is
  enabled. `byollm install` prints the one command for that rather than
  running it — it changes something outside your session, so it is your call.

`byollm status` reports three states, not two: running under supervision,
*installed but not running* (the one that looks fine from an app's dashboard
and serves nothing), and not installed at all.

## The trust surface

The meter is the product, and it gets the same care as the loop.

```bash
byollm status         # what's connected, what's running, what you've done for others
byollm sites          # which sites this device serves, and which are waiting on you
byollm approve <site> # say yes to a site that asked
byollm log            # every prompt that has ever run here
byollm log --full     # the whole text, not the first line
byollm pause          # stop claiming work
byollm resume
```

### A site cannot add itself

Pairing is with an *app* — a hub, a relay, your own server — and one pairing
can cover several sites. Which sites arrives on the heartbeat, from the same
party that routes the work.

So a site that turns up after pairing **waits**. It is listed by
`byollm sites` with its fingerprint, nothing is claimed for it, and it starts
being served the moment you run `byollm approve <site>`. Compare the
fingerprint against what the site itself shows you before you do.

The reason is narrow and worth stating: the daemon pins each site's keys so
that the party routing a job cannot choose which key signed it. If that party
could also *add* a site, it could generate a keypair, announce it, sign its
own work with it, and every pin check downstream would pass — because the
list they check against is the thing it wrote. Approving is the one step it
cannot perform for you.

A key that moves under a site you already approved is refused rather than
replaced, for the life of the pairing — including when the site leaves the
list and comes back. Rotation is an explicit path, not a silent swap.

Every prompt is appended to `~/.byollm/ingress.log` **before** it executes, so
a job that wedges the computer still leaves a record of what it was. The file is
JSONL, `0600`, and yours to read, grep and delete.

## Lending your computer to other people

Off by default. A fresh daemon runs your work and nobody else's.

```bash
byollm offer qwen team --cap 250          # share a service with your team
byollm offer qwen private                 # back to your work only
```

Who "your team" is lives in the dashboard, not on this machine. Add somebody
to your roster there and their next job can run here; remove them and their
next claim fails, including work already queued.

`byollm allow` and `byollm disallow` are gone. A device no longer keeps its own
list of who may use it — that list had to be kept in step with the roster by
hand, and two lists that must agree are one list and a bug waiting. Both
commands leave a tombstone pointing at where the decision lives now.

What replaced it is stronger than a list. Every teammate's job arrives carrying
a **grant**: short-lived, single-use, signed by the control plane your device
pinned when it paired, naming the site, the person, the job and the service to
run. Your daemon checks that signature itself before it runs anything, so an
app saying "this runner is allowed" is still not enough — and neither is a
relay saying it. Jobs from other people are additionally rate-limited, capped
daily, given a tighter resource budget, and their prompts are reduced to hashes
after 7 days so you are not holding anybody else's content indefinitely.

`public` is not a scope. It was one until 2026-08-26, and `byollm offer <service>
public` now refuses by name rather than silently doing something else.

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
