<!-- release-note 0.1.7 -->
> **`0.1.7`: a Windows device can update itself.** **On Windows 0.1.6 or
> earlier, run `npm install -g byollm@0.1.7`, then `byollm stop`, then
> `byollm start`, once, in that order:** a device runs the updater of the
> version it is on, and before 0.1.7 the Windows updater could not start npm
> (#9726). Without the `stop`, the 0.1.6 daemon keeps running, because Task
> Scheduler ignores a `start` while it runs. To confirm, `byollm status`
> should begin `byollm 0.1.7` and say it is running under supervision. macOS and Linux with
> `autoUpdate` on take 0.1.7 as usual. `byollm start` now installs nothing on
> a machine that was never set up or is not paired, says what to run first,
> and exits 1, instead of leaving systemd or launchd restarting it every ten
> seconds (#9703). On Windows, `byollm stop` ends the daemon and the `claude`
> or `codex` it started for a job in flight (#9735). `PROTOCOL_VERSION` is
> still `2`; update in any order. Full note: `docs/release-notes/0.1.7.md`.
>
> This README used to open with a stack of release notes instead of with the
> package. The history moved to `docs/release-notes/` and `CHANGELOG.md`,
> where none of it was lost.

# `byollm`

What end users run. Connects **outbound** to an app you trust, claims only the
jobs you have agreed to run, and executes them on your own models.

```bash
npm install -g byollm@latest
byollm setup
```

There is nothing to open on your network. The daemon never listens.

## Five minutes, start to finish

You need a model server. Ollama is the usual one:

```bash
ollama serve            # http://127.0.0.1:11434
ollama pull gemma3:12b
```

Then install byollm and pair it with the app:

```bash
npm install -g byollm@latest
byollm connect https://your-app.com
```

```
  Open:  https://your-app.com/settings/runners
  Code:  KRTZ-9F2Q      (expires in 10m)

  waiting for approval… ✓ paired as you@example.com
```

You approve inside the app's own login session — the daemon never asks for a
password and never accepts a pasted secret.

`byollm setup` asks which models to offer, pairs with byollm.cloud and
offers to start byollm, kept running across restarts; `byollm connect` pairs
with the app you name, and `byollm start` keeps it running.

### Setup without a person at the keyboard

The same questions can be answered by a script or an agent, or by a program
that draws its own window.

```bash
byollm setup --yes --service claude                  # one service
byollm setup --yes --service claude --service qwen3-8b --default claude
byollm setup --json                                  # for a parent program
```

`--yes` presses Enter at every question, so it takes each default: the
suggested device name, no team, connect, and start. It prints the questions
and every sentence that must be shown with them, the subscription sentence
included. It never reads stdin.

Two questions have no default `--yes` may take, so it stops there and names the
flag that answers them. Both stops come before anything is written or paired.

- `--service <name>` (repeat it): what this machine runs. A bare `--yes`
  enables nothing. The names are the ones setup's list shows.
- `--default <name>`: which service answers a job that names none. Needed
  only when more than one service is turned on.

`--yes` makes no call on a subscription it was not given by name. Setup
checks a signed-in CLI such as `claude` with one real call on your plan, and
under `--yes` it does that only for a subscription named with `--service`.
One that is not named is still listed, unchecked.

A CLI whose model byollm does not know, such as `codex` on a fresh machine,
asks for its model. `--yes` skips that question, so that CLI is not on the
list, and naming it with `--service` stops the run.

`--json` writes each question to stdout as one JSON line,
`{"format":1,"question":{...}}`, and everything else setup says as
`{"format":1,"say":"..."}`. It reads each answer from stdin as one JSON string
on one line: the line a person would type, with `""` for the default. A blank
line is not an answer, and input that ends is not a yes. Either one stops the
run before it pairs. Nothing listens on a port.

`npx byollm@latest connect https://your-app.com` pairs once without
installing anything, but keeping byollm running needs the global install:
`byollm start` refuses an npx copy, because npm deletes its cache without
warning.

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

`autoUpdate` (default `false`) lets the daemon install new versions when it is
offered one. Offers are taken only from `updateAuthority` — the reference hub,
`https://hub.byollm.cloud`, when you leave it out — and never from any other
site you paired with, never from a direct-mode pairing, and never for an older
version. Every update is checked against its npm provenance before it runs and
rolled back if it fails; [`docs/security.md` §7a](https://github.com/oftomorrowinc/byollm/blob/main/docs/security.md#7a-updates)
says exactly what is checked.

Every update writes down what it did, one line per step, each beginning
`update:` and the time in UTC: the offer it took and from where, the drain,
the install, the provenance check, the re-register, and then the new
daemon's `now running 0.1.7, was 0.1.6`. A failure says which step failed,
npm's words, and whether the machine stayed, rolled back, or needs you, with
the two commands to run. They are in `~/.byollm/service.log` and in
`byollm logs`:

```bash
grep update: ~/.byollm/service.log
```

Written by the updater already on the device, so the first update with an
account is the one after 0.1.6.

**On Windows, automatic updates work from 0.1.7.** Before it, the Windows
updater could not start npm and every update failed with exit 127, leaving
the device on the version it had. A device runs the updater of the version it
is on, so a Windows device on 0.1.6 or earlier takes 0.1.7 by hand, once, in
this order: `npm install -g byollm@0.1.7`, then `byollm stop`, then
`byollm start`. Without the `stop`, the 0.1.6 daemon keeps running, because
Task Scheduler ignores a `start` while it runs. The `stop` is 0.1.7's, so it
ends that daemon and everything under it and waits for it to exit. To
confirm, `byollm status` should begin `byollm 0.1.7` and say it is running
under supervision: its first line is the version installed, and after the
`stop` the only daemon running is the one `start` brought up from it.

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
`byollm logs` reads the device's own event log rather than this file, so it
works the same under any supervisor and at a hosted box's `byollm>` console.

Three things worth knowing:

- **Pair it first.** `byollm start` on a machine that was never set up, or
  that is not paired with any app, installs nothing: a service there would
  have nothing to run and would only be restarted, over and over. It names
  the step to take (`byollm setup`, or `byollm connect`) and exits 1. A
  service you installed earlier is left as it was.
- **Install `byollm` properly first.** `byollm start` refuses to supervise a
  copy running from `npx`'s cache, because npm deletes that directory without
  warning and the service would stop working at some later boot with nothing
  to show for it. `npm install -g byollm@latest` first.
- **On Linux, `systemd --user` stops when you log out** unless lingering is
  enabled. `byollm start` prints the one command for that rather than
  running it — it changes something outside your session, so it is your call.

`byollm stop` ends the daemon and anything it is running for a job. On
Windows, where a Task Scheduler process cannot be asked to shut down, that
means ending the daemon's whole process tree (`taskkill /T /F`), and only
when its heartbeat is less than a minute old. A job in flight is ended, not
finished, and the site holds it until its lease runs out.

`byollm status` reports three states, not two: running under supervision,
*installed but not running* (the one that looks fine from an app's dashboard
and serves nothing), and not installed at all.

### When the BYOLLM app is removed

The BYOLLM app installs its own Node, a `byollm` under it, and the same
start-at-login entry `byollm start` writes. Dragging the app to the Trash, or
deleting its folder by hand on Windows, removes none of those. So a daemon
the app installed looks for the app, and stops itself when it is gone
(ruled on #10663).

**The note.** The app writes `~/.byollm/app.json` when it installs or is
opened. byollm reads it and never writes it:

```json
{
  "format": 1,
  "app": "/Applications/BYOLLM.app",
  "node": "/Users/lis/.byollm/node/bin/node",
  "program": "/Users/lis/.byollm/node/lib/node_modules/byollm/dist/bin.js"
}
```

`format` is `1`. `app` is where the app is (the `.app` bundle on a Mac, its
folder on Windows), `node` is the Node the app installed, and `program` is the
byollm script under that Node. All three are absolute paths. A note that is
not JSON, has another `format`, or has a path that is missing or relative is
ignored, says so once in `service.log`, and is never acted on.

**Whose note it is.** A daemon acts on the note only when it is itself
running from the `node` and the `program` the note names, compared after
resolving links. Every other daemon ignores the note. On Linux the note is
not read at all.

**The check.** When the daemon starts, and once a day while it runs, it looks
for the app at the note's `app` path. An app in the Trash is not at that path,
so it counts as gone at once. So does an app moved somewhere else; opening it
again writes the note with its new path, and `byollm start` puts the daemon
back. When the app is missing, the daemon looks again a minute later before
it does anything, because an app being replaced by its own updater is missing
for a moment.

**The stop.** The start-at-login entry goes first, then the daemon:

- macOS: the plist in `~/Library/LaunchAgents` is deleted, then the daemon
  shuts its work down and runs `launchctl bootout gui/<uid>/cloud.byollm.daemon`.
  launchd ends the job. Deleting a file cannot end the process that deletes
  it, which is why it goes first; with no plist, nothing loads the job at the
  next login.
- Windows: `schtasks /delete` removes the task (deleting a task does not end
  the process it started), the task file and the Startup-folder entry are
  deleted, and then the daemon shuts its work down and exits. A deleted task
  has no restart-on-failure left to start it again.

If the entry cannot be removed, the daemon says why in `service.log`, keeps
running, and looks again the next day. A daemon that stopped with its entry
still in place would only be started again at the next login.

Only the start-at-login entry is removed. Your config, keys, pairings, the
note and the app's Node folder stay where they are. Nothing is sent anywhere.

**Afterwards**, `service.log` says the daemon stopped because the BYOLLM app
was removed, and `byollm status` says:

```console
state: STOPPED — the BYOLLM app was removed
  the BYOLLM app is no longer at /Applications/BYOLLM.app, so on 2026-11-24T09:02:11Z this device's daemon removed its start-at-login entry and stopped.
  Your config, keys and pairings are untouched in /Users/lis/.byollm.
  To serve again: install the BYOLLM app and open it, or run `byollm start`.
service: not installed — the daemon removed its own start-at-login entry when the BYOLLM app was removed
```

`byollm status --json` reads `"state":"stopped"`. The next daemon to start
clears this.

**A machine with byollm from npm and the app.** There is one `~/.byollm` and
one start-at-login entry (`cloud.byollm.daemon`) per person, whichever
install wrote them. Whichever of `byollm start` and the app's install ran
last owns that entry: its plist or task names that install's Node and
program. The note always belongs to the app's daemon, because it names the
app's Node and program. The npm daemon never stops itself because of the
note, whatever the note says and whether or not the app is there. So:

- the app installed last and later removed: the app's daemon owns the entry,
  finds the app gone, removes the entry, and stops. Nothing starts byollm at
  the next login. Run `byollm start` from the npm install to put your own
  daemon back;
- `byollm start` from npm run last: the npm daemon owns the entry and the
  app's daemon is not running, so removing the app changes nothing. The npm
  daemon keeps starting at every login.

### When the app's own Node is old

The Node the BYOLLM app installed is the app's to replace, not yours, so
`byollm status` says when it is older than this release calls safe (ruled on
#10660). It says nothing about a Node you installed yourself, however old.

The daemon writes the Node and program it runs from, and that Node's version,
into `~/.byollm/heartbeat.json` with every beat. `byollm status` warns only
when the app's note names that same Node and program, and that version is
older than the lowest this release calls safe. On the day 0.2.0 ships that is
22.14.0, the same as `engines`, so nothing is warned about yet; each release
checks Node's security releases and may raise it. It is a separate number
from `engines`, which still decides which Node can install byollm at all.

In that case, and no other, `byollm status` prints one more line under
`service:`:

```console
node: this BYOLLM came with its own Node (22.13.1), which is older than this release calls safe (22.14.0) — downloading BYOLLM again replaces it.
```

and `byollm status --json` says `"appNodeOutdated":true`. It is `false` on
your own Node, with no note, on Linux, and before the daemon has run on a
release that records its Node. Nothing is downloaded, replaced or sent
anywhere.

With byollm from npm and the app on one machine, the answer follows whichever
Node the daemon last ran on, not the note: after `byollm start` from npm the
daemon is on your Node and nothing is said, even though the note still names
the app's; after the app installs over it, the daemon is on the app's Node
and the app's Node is the one checked.

### `byollm status --json`, for a program

A tray icon, a script, or anything else that would otherwise have to read
`byollm status`'s sentences can ask for one JSON object instead:

```console
$ byollm status --json
{"format":1,"state":"running","daemonVersion":"0.1.7","services":["claude","studio"],"autoUpdate":true,"paired":true,"appNodeOutdated":false}
```

It opens no port and starts nothing: it reads what the daemon already writes,
prints one line on stdout, and exits 0, as `byollm status` does. Plain
`byollm status` is unchanged.

| field           | what it says                                                                      |
| --------------- | --------------------------------------------------------------------------------- |
| `format`        | the version of this shape. `1` today.                                             |
| `state`         | `running`, `stopped`, or `needs_attention` — the three states above.              |
| `daemonVersion` | the daemon's version, as `byollm --version` prints it                             |
| `services`      | the services this device runs, by the names you gave them in `config.json`        |
| `autoUpdate`    | whether this device updates itself                                                |
| `paired`        | whether it is paired with any app                                                 |
| `appNodeOutdated` | the daemon runs on the BYOLLM app's own Node and it is older than this release calls safe; `false` otherwise, always on your own Node |

The three words:

- **`running`** — installed to run, and running: a supervisor (or a hosted
  box's own) keeps it up, and its heartbeat is fresh.
- **`stopped`** — nothing is installed to start it. You ran `byollm stop`,
  never ran `byollm start`, or the daemon stopped itself because the BYOLLM
  app was removed. A `byollm run` open in a terminal is serving, and
  still reads `stopped`: nothing will start it again when that window closes.
- **`needs_attention`** — installed to run, and not running: the supervisor
  says it is down, its heartbeat has stopped, the hub refuses everything it
  sends, or the hub has revoked it. `byollm status` says which.

It names no account, key, token or app. A service is named as you named it,
never with who is signed in to it, and `paired` is yes or no.

**The shape only grows.** A field may be added in any release without
`format` changing, so a reader should ignore fields it does not know. `format`
changes only when an existing field is removed, renamed, or changes what its
values mean — including a fourth word for `state`. A reader that finds a
`format` it was not built for should say so rather than guess.

## The trust surface

The meter is the product, and it gets the same care as the loop.

```bash
byollm status         # what's connected, what's running, what you've done for others
byollm sites          # which sites this device serves, and which keys it still holds
byollm log            # every prompt that has ever run here
byollm log --full     # the whole text, not the first line
byollm logs           # what happened, one line per event: claimed, started, answered, failed
byollm logs --job 911c5d84   # one job's lines, and where it stands
byollm logs --follow  # and keep printing as they happen (--tail N for more than 20)
byollm stop           # stop running in the background — the off switch, always yours
byollm start          # and bring it back
byollm forget <url>   # drop a pairing entirely
```

### Which sites this device serves is decided in your dashboard

Pairing is with an *app* — a hub, a relay, your own server — and one pairing
can cover several sites. Which sites arrives on the heartbeat, from the same
party that routes the work.

A site that turns up after pairing is **pinned and served** from that
heartbeat on. Nothing on this machine asks you first: `byollm approve` is
gone (it exits with a tombstone saying so), and which sites reach your device
is decided in the app's dashboard, where the person changing it is signed in
and can see what they are changing.

What you get instead is a notice. The first time a new site's work runs here,
the daemon says `now serving <site>, enabled from your dashboard` with the
site's fingerprint — on screen in `byollm run`, in `~/.byollm/service.log`
when it runs in the background — so a change made at the app is never silent
at the machine. `byollm sites` lists every site this device serves and
every key it still holds, with fingerprints, for comparing against what the
site itself shows you.

What the daemon still refuses, whatever the app says: a key that moves under
a site id it has already pinned, for the life of the pairing — including when
the site leaves the list and comes back (rotation is an explicit, signed path,
not a silent swap); and any job that does not carry a grant signed by the
control-plane key this device pinned when it paired. A party that can add a
site to your heartbeat still cannot sign work for it.

The trade is stated plainly in the spec (byollm_016, Amendment K): an app or
control plane that is compromised can point your device at a site you never
chose. Spend caps bound what that costs, the notice makes it visible, and the
levers are yours: `byollm stop` stops all work, `byollm forget <url>` drops
the pairing.

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
caps; HTTP-class backends spawn nothing at all. The model has no tools that
run on your device, no retrieval and no MCP. A site's own tools (`llm.tools`,
off until you turn it on for a service) run on the site: the daemon seals each
call to that site, logs it first, and never executes it.

Prompt injection — steering what the model _says_ — is not prevented by
anything and we do not claim otherwise. It is bounded here because nothing
the model says runs on the device: its output is inert, and a call to a site's
tool is sealed to that site and run there.

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
