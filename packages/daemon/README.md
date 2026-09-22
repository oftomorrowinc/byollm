<!-- release-note 0.1.1 -->
> **`0.1.1` is documentation only — nothing to upgrade.** `PROTOCOL_VERSION`
> is still `2`, so a 0.1.0 party and a 0.1.1 party talk to each other in both
> directions. No dependency, schema, wire field or on-disk shape moved.
>
> This README used to open with a stack of release notes instead of with the
> package. The history moved to `docs/release-notes/` and `CHANGELOG.md`,
> where none of it was lost. Full note: `docs/release-notes/0.1.1.md`.

# `byollm`

What end users run. Connects **outbound** to an app you trust, claims only the
jobs you have agreed to run, and executes them on your own models.

```bash
npx byollm@latest connect https://your-app.com
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
npx byollm@latest connect https://your-app.com
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

```json
{
  "services": {
    "qwen": {
      "type": "ollama",
      "baseUrl": "http://127.0.0.1:11434/v1",
      "model": "qwen3:8b",
      "kinds": ["llm.generate", "llm.chat"],
      "offer": "private"
    },
    "claude": {
      "type": "claude-cli",
      "model": "claude-opus-5",
      "kinds": ["llm.generate", "llm.chat"],
      "offer": "private"
    }
  },
  "defaults": {
    "llm.generate": "qwen",
    "llm.chat": "claude"
  },
  "concurrency": 2,
  "minAvailableMemoryBytes": 2147483648
}
```

Each service names its own `type`, its `baseUrl` where it has one, the `model`
it serves, and the `kinds` of job it answers. `offer` is who may use it —
`private` is your own work only, `team` widens it to people you have shared the
device with.

`type` is the provider, not the transport, and it is worth getting right: a
service that names `ollama` can be started for you when a job needs it, and one
that names the generic `openai-http` cannot, because nothing tells byollm what
to start. Use `openai-http` for a server byollm does not know by name.

`defaults` only matters where two services answer the same kind. One claimant
serves without ceremony; two and the device will not advertise that kind at all
until you say which wins, rather than picking for you.

`minAvailableMemoryBytes` is the memory this device keeps free: a job that would
load a model on this machine is refused below it, and so is starting a server
for one. It defaults to 2 GB. **It does not know how big your models are**, so
set it to fit your largest. It does not apply to services whose compute happens
somewhere else — a hosted model reached through a local port loads nothing here.

You do not have to write any of this by hand. `byollm services manage` asks
what this machine has and writes the file for you, and it is safe to re-run:
it shows what is already there.

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
byollm start       # keep running in the background, and restart if it stops
byollm status      # says whether it is actually supervised right now
byollm stop
```

It installs at the user level on every platform — a launchd `LaunchAgent` on
macOS, a `systemd --user` unit on Linux, a logon task on Windows. No root, no
system directories: it runs as you, it stops when you say so, and you can read
every file it wrote. Output goes to `~/.byollm/service.log` on all three.

Two things worth knowing:

- **Install `byollm` properly first.** `byollm start` refuses to supervise a
  copy running from `npx`'s cache, because npm deletes that directory without
  warning and the service would stop working at some later boot with nothing
  to show for it. `npm install -g byollm@latest` first.
- **On Linux, `systemd --user` stops when you log out** unless lingering is
  enabled. `byollm start` prints the one command for that rather than
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
byollm stop           # stop claiming work — the off switch, always yours
byollm start          # and bring it back
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
[`docs/security.md`](https://github.com/oftomorrowinc/byollm/blob/main/docs/security.md).

MIT

<!-- family:start -->

## The rest of byollm

Six packages, and they are only interesting together:

- [`@byollm/protocol`](https://www.npmjs.com/package/@byollm/protocol) — the wire: envelopes, signatures and the closed vocabularies both ends validate against
- [`@byollm/server`](https://www.npmjs.com/package/@byollm/server) — the SDK a site uses to ask a device for work
- [`@byollm/relay`](https://www.npmjs.com/package/@byollm/relay) — the broker that holds jobs between a site and a device, and can read neither
- [`@byollm/control-plane`](https://www.npmjs.com/package/@byollm/control-plane) — who may ask whom, and the policy store behind it
- [`@byollm/conformance`](https://www.npmjs.com/package/@byollm/conformance) — the kit that proves an implementation is one — including a posture audit that holds nothing but a URL

### Where the rest lives

- [GitHub](https://github.com/oftomorrowinc/byollm) — the source, and where issues go
- [byo-llm.com](https://byo-llm.com) — what this is, and why
- [byollm.cloud](https://byollm.cloud) — the hosted relay — devices, consent and billing
- [docs.byollm.cloud](https://docs.byollm.cloud) — integrating a site, end to end

<!-- family:end -->
