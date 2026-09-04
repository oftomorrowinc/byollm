# byollm_020 — CLI surface audit and simplification

Status: DRAFT for build (Todd approved the shape 2026-09-04; slotted
into Batch B, with the Windows/daemon work, so ALL daemon-facing
changes land as one update — Kevin and Rob switch to `start` once,
not across two batches — and it still lands before Eric's users
onboard). Not built.

## Why now, not icebox

The CLI is the project's front page: every blog post, the video, the
docs, and a stranger's first two minutes are these commands on screen.
Shipping `install` when nothing installs, and two list commands for one
table, is the small dishonesty the whole project trades against. And
Eric's users are about to arrive — a rename after they onboard is churn
they should never see. So this rides Batch C, before them.

## Principle

One concept, one command; a verb acts, a noun lists; persistent
running is the default, foreground is the exception.

## The change

REPLACE (with deprecation aliases for a window, each printing a
one-line "renamed to X" notice so Kevin/Casul/Eric's early installs
keep working):
- `install`  -> `start`   (run persistently, across restarts)
- `uninstall`-> `stop`    (stop the persistent daemon)
- `pause`    -> REMOVED, not renamed (B043, ruled by Todd 2026-09-04).
  The build found why the rename was the wrong shape: the flag `pause`
  wrote was never read by the running daemon. It reached a probe
  heartbeat and the `status` headline, which printed `PAUSED` over a
  daemon that went on claiming work. So there was no temporary-idle
  nuance to drop — there was a screen agreeing with the person instead
  of with the machine. `pause` and `resume` now say they are removed
  and exit non-zero; they are not aliased at `stop`, which unregisters
  supervision and is more destructive than what was typed.
- `resume`   -> REMOVED, same ruling.
- `models`   -> folded into `services` (killed — "services" is our
  ruled term, "models" is not; the service->model mapping becomes a
  column of `services`)

FIX:
- `run` keeps only the foreground/watch meaning ("run it here so I can
  see the log"); it loses its `[url]` argument — `connect` owns URLs,
  and "serve all paired apps" is the whole job. `run` prints a clear
  "serving <device>, enabled from your dashboard" line on start, so a
  person can tell it is working (closes B037).
- the daemon's surfaced remedy line ("Not expected? `byollm stop`
  stops all work...") names `stop` — done.
- `setup` gains a final y/n: "Start byollm now and keep it running
  across restarts? (recommended)" — if yes, it does the `start`, so a
  new user never has to discover a second command.

KEEP: setup, connect [url], forget [url], name [name], status,
log [--full] [-n N], services (now with health + advertised/withheld +
the model each runs), model <svc> <name> (the setter), offer <service>
<scope>, sites.

## Resulting surface

  byollm setup            first-run questions; offers to start + persist
  byollm connect [url]    pair with a site (forget is the inverse)
  byollm forget [url]     drop a pairing
  byollm name [name]      what this device calls itself
  byollm start            run persistently, across restarts (was install)
  byollm stop             stop the persistent daemon (was uninstall)
  byollm run              run in the foreground and watch (no url)
  byollm status           what is connected, running, and what it cost
  byollm log [--full] [-n N]   every prompt this device has run
  byollm services         each service: health, advertised/withheld, model
  byollm model <svc> <name>    check a model answers, then use it
  byollm offer <svc> <scope>   who a service is offered to (private|team)
  byollm sites            which sites this device serves

Sixteen commands to twelve; the two most-confusing verbs (install, run
with a url) fixed; one list where there were two.

## Open questions for the build (CW to rule with Todd if they come up)

- Does the `model <svc> <name>` setter stay, or fold into the services
  vocabulary as `service <svc> <name>`? Todd ruled "services" is our
  term; "model" as the noun for the thing a service runs is still real,
  so the setter probably stays. Lean: keep `model` as the verb, since
  it names a real thing you are choosing.
- Does `sites` fold into a richer `status`? Lean: keep it — "who am I
  serving" is a distinct question a person asks out loud.
- Keep `run` at all, or make it `start --foreground`? Lean: keep `run`
  — it is the honest word for the watch-it mode and people reach for it.

## Not in this spec

- The Windows supervised-install path (schtasks Access-denied without
  admin) — that is the Batch B Windows work (B036/#7), not a naming
  change. This spec assumes `start` calls whatever the platform's
  supervisor is; the Windows fix is separate.
