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

---

## CW rolling review — 2026-09-04 eve, range 255ba75..8f1c6a0 (the .81 cut)

Verdict: **CLEAR — latest may move to 0.1.0-alpha.81.** Verified
independently, not from the report: all six packages read back at .81
from registry.npmjs.org directly (latest uniformly .79 before the
move); full unit suite green at 8f1c6a0 (97 files, 1263 passed); and I
re-ran two mutations myself — pause aliased at uninstall reddens the
"does not quietly do something else" test, and DAEMON_VERSION set to
0.1.0 reddens all four death-date arms, each printing its instruction.

The build's central finding is confirmed in the diff and it upgrades
the ruling's rationale, as CCB said: `#paused` gated claiming inside
the Runner, but pause()/resume() had only test callers, and the CLI's
flag file was read by exactly two surfaces — the connect probe and the
`status` headline, where PAUSED outranked everything but REVOKED,
including NOT REPORTING. The removal is the honest fix and the tests
around it are the right shape: the stubs exit 2 and print the truth;
the flag file is never written; and — the test I most wanted to see —
an *old* flag file from a pre-.81 install is proven inert against the
status headline. The wire assertion checks the key, not just the
value, so dropping the field is the failure it catches.

Keeping `paused` on the wire until 0.1.0 is correct, and not merely
compatible: pre-.81 daemons in the wild can still legitimately send
`true` (their flag files exist), and the hub's offer gate at
`!runner.paused` still serves them. The field, the gate, and the
server records all die together at the lockstep cut, and the
death-date test's instruction text names every site. Footprint
enforcement is transitive but real: the test forces the surface
deletion, and knip (in verify.sh) then fails the build on the orphaned
listModels — Todd's "remove the code footprint" wish is machine-held
at both levels.

Two minors, doc-grade, riding any next cut:
- **M-1** runner.ts's compromised-control-plane trade note now reads
  "Spend caps bound the damage," which silently halved the recorded
  trade. Truer than before (pause never bounded anything), but the
  owner's actual lever should be named: spend caps bound it, `byollm
  stop` ends it.
- **M-2** relay fixture's HeartbeatRequest mirror has `paused` with
  `.default(false)` where the real schema has it required — a fixture
  lenient where the protocol is strict predates this range, but the
  0.1.0 sweep should take the mirror with it.

CCB's swallowed-mutation catch is minted as law in 016: prove the
mutation applied before trusting its verdict.

---

## B047 — startup preflight: check the services now, offer the sign-in (Kevin's ask via Todd, 2026-09-04 eve; CW diagnosis + design sketch)

Kevin, on .81: logging out of claude and running `start` or `run` never
prompted him to log back in. Todd: check what services should be running
locally on startup, check them, and prompt.

**Why .81 is silent, from the code (CW, read at 8f1c6a0).** The B036b
line has one caller — `commandInstall` — and it READS services.json, the
daemon's own probe record, "rather than probed again: a canary spends a
real call." That design is right for what it does and it loses the exact
race Kevin ran: `installService` polls `confirmRunning` for the daemon
being ALIVE, not for its startup probe having completed and WRITTEN. A
backend probe takes real seconds, so `start` reads the file from before
the probe lands — stale-healthy after a fresh sign-out, absent on a
fresh machine, and the tri-state rule ("absent is not signed-out")
correctly says nothing about either. The read-back only speaks when a
PRIOR daemon session already recorded signed-out. And `run` has no
signed-out surface at all — `signedOutLines` has exactly one caller.
So both of Kevin's cases produce silence by construction, not by bug:
the check answers "what did the daemon learn last time" at the one
moment the person deserves "what is true now."

**Design.** At `start` and `run`, in an interactive terminal, before
the success/serving line:

1. Enumerate the mapped services from config — the same set the daemon
   will advertise.
2. Verify each backend's auth NOW, with the machinery `setup` already
   trusts (backendVerifier), not by reading services.json. Cost: one
   verification per mapped backend per human-initiated start. Bounded,
   and spent at the moment somebody is watching the answer.
3. Signed-in: fold into the serving line — say what is being served.
4. Signed-out: print the existing named line + remedy, then PROMPT:
   "Sign in to <backend> now? [Y/n]". Yes spawns the backend's own
   login command in the foreground, inheriting the TTY, then
   re-verifies and reports. No (or EOF) prints the remedy and
   CONTINUES — signed-out is not fatal, per B036b's "alongside the
   success rather than instead of it." Never auto-spawn a login
   without the y/n: logins open browsers.
5. Non-interactive (no TTY, supervisor respawn): unchanged from today
   — no prompt, no fresh spend, the daemon's own probe + withdrawal
   machinery remains the authority. The preflight is a terminal
   feature for a person at a terminal.

**Opens for CCB.**
- Whether `start` should also WAIT for the daemon's first probe write
  and read it back (closing the race for the passive line too), or
  whether the active preflight makes the passive read-back at `start`
  redundant and it should simply be replaced. CW leans replace: two
  answers to one question on one screen is how they disagree.
- Backend login spawn: claude and codex both have interactive login
  flows; the adapter should own its login command the way it owns its
  failure definition (016's per-backend rule, 6.4 above).
- Whether `setup` should reuse the same preflight verbatim (it already
  verifies; convergence is free consistency).

**Acceptance.**
- Signed-out backend + interactive `start`: named line, prompt, login
  runs on yes, re-verify confirms, service proceeds either way.
- Same for `run`, before its serving line.
- Fresh machine (no services.json): the live check still speaks —
  the absent-is-silence rule stays true of status and stops being the
  reason start says nothing.
- Non-interactive start: byte-identical behavior to .81.
- Declining the prompt is honored and quiet — asked once per start,
  never nagged.
