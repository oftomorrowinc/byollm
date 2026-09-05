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

### B047 amendments — Todd's ruling, 2026-09-04 eve

RULED: on Windows the preflight does NOT spawn the backend's login — it
prints the instruction ("run `claude login`, then `byollm start` again"
or the backend's own words), prominently, and continues. Everywhere
else the [Y/n] + foreground spawn stands as designed. Otherwise
approved as specced.

### B036 REOPENED by the field — 2026-09-04 eve (CW, from Kevin's .81 run)

Kevin's standard account still cannot register the task on .81. The
screenshot shows the per-user XML (named UserId, InteractiveToken,
LeastPrivilege) being refused by schtasks and the Startup-folder
fallback catching it — the fallback and its caveat worked exactly as
built, so the machinery is honest; the premise is what failed. Todd:
"Admin still required for start to schedule. So it may not be a
multi-user thing." The B036a diagnosis (unscoped task = machine-wide =
admin) was either wrong or incomplete: the fix was right in kind and
insufficient on the one real Windows box we have.

Hypotheses, ranked (CW):
- **H1 — the trigger type itself.** Microsoft's own schtasks docs put
  ONLOGON on the list of schedule types requiring administrator
  permissions, and there is reason to believe that applies to a
  LogonTrigger delivered by XML too, regardless of how well-scoped the
  Principal is. If true, NO logon-triggered task registers from a
  standard shell, ever, and the Startup folder is not a fallback but
  the standard-account path — the message should say so instead of
  hinting at IT policy.
  Test that separates it: same XML with the LogonTrigger swapped for a
  one-shot TimeTrigger, registered from Kevin's normal shell. Registers
  fine -> H1; same refusal -> look lower.
- **H2 — principal mismatch.** UserId derives from
  USERDOMAIN\USERNAME; a Microsoft-account or AzureAD box can answer
  those differently from the account's real principal, and registering
  a task *for another user* requires admin. Test: Kevin runs `whoami`
  and `echo %USERDOMAIN%\%USERNAME%` and we compare against the
  UserId in his byollm-task.xml.
- **H3 — a Settings element that wants elevation** (RestartOnFailure
  is the exotic one in our XML; it is also the whole reason we use XML).
- **H4 — actual machine policy.** Named last because it explains
  anything and predicts nothing.

Diagnostics for Kevin (paste-ready, no admin needed):
1. `schtasks /create /tn test.byollm /xml C:\Users\Kevin\.byollm\byollm-task.xml /f`
   — and paste the RAW output. Our own message interpreted the error
   and discarded the original words (see rider).
2. `whoami` and `echo %USERDOMAIN%\%USERNAME%` — for H2.
3. If willing: the H1 trigger-swap XML (CCB can hand him one).

Riders on this reopen:
- **refusalOf eats the evidence.** When the denied-pattern matches, the
  interpretation REPLACES schtasks's raw words, so the field report
  arrived without the one line that distinguishes H1 from H2 from H4.
  Print the interpretation AND the raw line under it. The reviewer's
  version of this law already exists: the announcement is not the
  effect, and an interpretation is not the evidence.
- **Kevin's UX finding, verbatim fence-checked:** the "Run as
  administrator" remedy "is there, but its buried in the middle of the
  text and easy to miss, it should be the primary thing it tells you
  since its going to be the solution 99% of the time." Restructure the
  fallback-success message: outcome first (starts at logon, the weaker
  way), the upgrade path second as its own short line, mechanics last.
  If H1 holds, the upgrade line changes accordingly (one elevated
  registration, or "this is the standard-account way" with no false
  promise that elevation is exceptional).

### The Tuesday patch — Kevin's three reports, one cut before he takes over (Todd committed in Discord, 09-04 eve)

Todd to Kevin: "I will push a patch with the three things you reported
and you can take it from there on Tuesday." Kevin — at his own machine,
on Windows — is finding the sign-in fix himself after this patch lands:
our first outside contributor. The three things, each with what the
evidence says:

**(1) The sign-in spawn is broken on Windows, and CW can name the
mechanism (verify on the box).** Kevin's setup transcript: three rounds
of "Sign in to claude now? [Y/n] y" -> "Opening Claude's sign-in now"
-> "Still cannot answer", then the honest stop. Nothing visibly opened.
login.ts spawns `claude` via `spawn(file, args, {stdio: "inherit"})` —
no `shell: true`. On Windows, an npm-installed `claude` is `claude.cmd`,
and Node cannot spawn a `.cmd` without a shell: since the CVE-2024-27980
fix (Node 18.20/20.12) it throws EINVAL synchronously, and before that
it was ENOENT. runLogin is BUILT to swallow both ("it never throws...
the same outcome to the caller"), so the loop asks again with no error
ever shown. Two design choices, each defensible alone, compose into
three silent retries.
  - The fix per Todd's B047 ruling: on Windows, do not spawn — print
    the login command prominently and continue. This transcript is the
    ruling's field proof: the spawn path cannot work as written there.
  - RIDER, same law as refusalOf twice in one day: the swallowed spawn
    error had words (EINVAL/ENOENT) and nobody printed them. Keep the
    never-throws contract, but SAY what failed on stderr before falling
    back to asking. An interpretation is not the evidence, and neither
    is silence.

**(2) The buried admin remedy** — already specced as the B036-reopen UX
rider: outcome first, upgrade path second on its own line, mechanics
last. Rides this patch.

**(3) "uninstall isn't actually uninstall."** Kevin ran `byollm
uninstall` expecting removal; it unscheduled the daemon and said so.
Todd in Discord: "That is literally why I wanted the terms removed
since it wasn't uninstalling before--just unscheduling the background
job" — the B040/B044 renames, vindicated by the first person to meet
them cold. Interim fix for the patch: `stop` (and the uninstall shim)
gains one line — "To remove byollm from this machine entirely:
`npm uninstall -g byollm`" — so the person who wanted removal is told
the true command instead of being left correct-but-unsatisfied. The
shim and its notice still die at 0.1.0 (B044); this line lives in
`stop` and survives.

**Also in scope if cheap:** B047's start/run preflight is the fourth
thing Kevin reported (yesterday's silence after sign-out); if CCB can
carry it in the same cut, the whole sign-in story lands at once —
otherwise it follows and Tuesday-Kevin only needs setup+messages fixed.

**Process note (CW -> Todd):** Kevin iterating "from there" means fork
-> branch -> PR against oftomorrowinc/byollm. The B022 drafts
(CONTRIBUTING "how work is chosen", the 0.1.0 milestone text) have been
sitting ready; posting at least CONTRIBUTING before Tuesday gives his
first PR a documented path and makes him the contributing flow's first
real test. Todd's call, as B022 always was.

### B036 diagnostics, round 1 — 2026-09-04 ~5:09pm Kevin's time. Inconclusive, instructively.

What came back, and what each answer is worth:
1. The schtasks re-run said "ERROR: The system cannot find the path
   specified" — a FILE-not-found, not an access-denied. The test never
   reached registration: byollm-task.xml does not exist on his disk
   right now. Reconstruction: the B048 teardown deleted ~/.byollm, and
   setup then REFUSED to write anything while claude was signed out
   ("Nothing was written; setup is safe to re-run"), so nothing has
   recreated the XML since. Two correct behaviors interlocking into a
   dead end for the diagnostic — and proof the sign-in bug (B049 item
   1) is upstream of everything: it is currently blocking the machine
   from even having the file the B036 test needs.
2. `whoami` -> `desktop-skc98b9\kevin`: a plain local account, no
   Microsoft-account or AzureAD indirection. H2 (principal mismatch)
   weakens substantially.
3. The %USERDOMAIN%\%USERNAME% echo printed its own literals — Kevin is
   in PowerShell and %VAR% is cmd syntax. CW's miss: paste-ready
   diagnostics must be shell-correct for the shell the tester is
   actually in. Round 2 below is pure PowerShell.

Round 2 (one paste, PowerShell, raw output wanted; step 2 rewrites the
XML because start writes the unit before asking schtasks):

    whoami
    "$env:USERDOMAIN\$env:USERNAME"
    byollm start
    schtasks /create /tn test.byollm /xml "$env:USERPROFILE\.byollm\byollm-task.xml" /f
    $xml = Get-Content "$env:USERPROFILE\.byollm\byollm-task.xml" -Raw
    $xml = $xml -replace '(?s)<LogonTrigger>.*?</LogonTrigger>', '<TimeTrigger><StartBoundary>2030-01-01T12:00:00</StartBoundary><Enabled>true</Enabled></TimeTrigger>'
    Set-Content "$env:TEMP\test-time.xml" $xml -Encoding Unicode
    schtasks /create /tn test.byollm.time /xml "$env:TEMP\test-time.xml" /f
    schtasks /delete /tn test.byollm /f
    schtasks /delete /tn test.byollm.time /f

Reading it: the first /create failing "Access is denied" while the
second (time-trigger) succeeds = H1 confirmed, the logon trigger is
the gate. Both refused = policy or something in Settings (H3/H4). Both
succeed = the original refusal was environmental and B036 may already
be fixed on a clean run.

---

## CW rolling review — 2026-09-05 ~1am UTC, range 7b21352..56b79a6 (the .82 cut)

Verdict: **CLEAR — latest may move to 0.1.0-alpha.82.** Verified
independently: all six packages read back at .82 from
registry.npmjs.org (latest uniformly .81 going in); full unit suite
green at the cut (1276 passed); and I re-ran two mutations by hand —
re-burying the upgrade line under the mechanics reddens the order test,
and deleting the preflight's interactive gate reddens BOTH spend tests
(start and run), proving the "asserts the spend, not the silence" claim
in the strongest form: the test counts verifications, so a version that
verified quietly cannot pass.

What the diff shows, confirmed against every report claim: the
preflight REPLACES the services.json read-back (signedOutLines has no
callers left in cli.ts) and the test file contains the exact test the
old design could not pass — "believes the backend, not a file written
before the sign-out", written against a STALE file rather than an
absent one, which is the precise Kevin case. refusalOf now returns the
reading first and schtasks's own words under it ("it said: ..."), and
— the detail I checked because it is where this class of fix fails —
the negative case is guarded too: a non-permission error keeps its own
words, so a disk error is not diagnosed as missing rights. runLogin
reports before it swallows. loginPlan makes the Windows decision in a
pure function, testable with no Windows. The remedy lives in BOTH
refusal branches, including the one where even the fallback could not
be written — the branch where the person has less. And `remove: byollm
stop` quietly fixed a line that still said uninstall.

**Challenge 1 (the Ollama crash), answered with a rider.** The fix is
right — verify takes the whole ServiceConfig, backendFor passes
baseUrl — and the report's own framing is the finding: caught by a
revocation test, "the kind of luck not to rely on twice." The luck has
not yet been replaced. I checked: every preflight test injects
`verify`; no test exercises the DEFAULT verify path (backendFor +
backendVerifier) interactively against an openai-http service. The
comment and the wider type are the only guards, and the type would
compile through a re-narrowing (baseUrl is optional). RIDER, rides
B014's cut: one designed test — interactive start, openai-http config
with an unreachable baseUrl, NO injected verify — asserting exit 0 and
silence. It costs nothing (the canary refuses at a closed port,
answers undefined, tri-state says nothing) and it turns the luck into
a fixture.

**Challenge 2 (the suite installing byollm on its host), answered:
the fix is the right shape and the find outranks the fix.** appData
injected as part of ServiceTarget with the ambient default preserved
(a roaming profile moves APPDATA, so home-relative would be wrong for
the product), environment arm tested as the control. The remaining
ambient env read in service.ts (PATH, line ~196) is a read-only
snapshot into unit contents — a different class, no host write, fine.
CI runner pollution is ephemeral (github-hosted). Law minted in 016
from the mechanism CCB named: the old tests never failed because the
write SUCCEEDED — a destructive escape that succeeds is invisible to
every test that only reads its own output.

Nine mutations claimed, two re-run by hand, both red. B014 unblock
confirmed — the sweep now documents shipped messages. Kevin installs
.82 by version Tuesday; his validation and the H1 datum stay parked on
the board.
