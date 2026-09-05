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

---

## CW rolling review — 2026-09-05, the B014 + rider push (byollm 3d287a3, web 73e3c29)

Verdict: faithful, and no release to gate — docs and tests only. The
rider is exactly what was asked and better in one respect: ids come
from the protocol registry, so a new backend joins the test by
existing, and the file carries a control on its own control (the
registry import resolving empty would zero out the it.each — asserted
against). I re-ran the revert mutation by hand: `createBackend(id,
{})` reddens the file (17 failures on my run; direction confirmed),
green on restore. The absence-shaped assertion is guarded the right
way — closed port so the verification really runs and really fails.

The integrate-guide correction read against the fence and the relay:
the new callout keeps "one sentence, never why" and says whose
information the withheld details are — the fence held through a docs
edit, which is where fences quietly die. The qualified old sentence is
accurate: satisfiable is an optional site-plane dep, a self-hosted
relay that does not wire it still accepts-and-expires, and saying so
is information a hosted-vs-self-hosted chooser deserves.

**One observation on the prose check (M-grade, CCB's call how to
take it).** The check is page-granular: RAISES anywhere on the page
demands NAMES-THE-REFUSAL anywhere on the page. The stated mutation
("restoring the bare callout reddens it") holds only if the WHOLE old
page comes back — restoring just the bare callout while the corrected
top paragraph keeps its "409" leaves the page green with an emphatic
contradiction back in it, because one mention three paragraphs up
satisfies the regex. That is B005's class one level down:
intra-page contradiction, which page-level presence cannot see.
Options: scope the check to the raising passage's neighborhood, or
record the residual risk as accepted. Either is fine; unexamined is
the only wrong state.

**The HTTP-silence finding — CW's read, Todd to ratify.** The
preflight as shipped is RIGHT and complete for what was ruled: Kevin's
report was about vendor-CLI sign-in, and an HTTP backend has no
sign-in — `answers: undefined` is the tri-state doing its job, and
CCB's first-draft test failing was the tri-state defending itself.
But Todd's original words were "see what services should be running
locally and check them," and the most common local-model failure is
not auth — it is the model server simply not running. That wants no
paid canary: an OpenAI-compatible server answers GET /v1/models for
free. PROPOSED as B050 (new row, unscheduled, Todd rules priority):
the preflight gains a free reachability probe for HTTP-class services
— "nothing answering at <baseUrl> — is your model server running?" —
tri-state intact (refused connection is "it said no" for
reachability, not for auth), tiny timeout, interactive only, same
silence under a supervisor.

### B050 RULED (Todd, 2026-09-05 night) — a real ping, disclosed

Todd: "I would think we just do that and mention we run one tiny
prompt on start to verify everything is working against each service
on the device." So B050 is not the reachability-only shape CW
proposed — it is a real tiny canary prompt per mapped service at
interactive `start`/`run`, every backend class, with a one-line
disclosure in the output. The tri-state's "no way to ask" case mostly
disappears: HTTP services become askable, and unreachable becomes an
answer instead of silence.

CW riders, recorded with the ruling:
- **Metered services consult the ledger first.** A ping against a
  metered backend is real money; if today's cap is already spent, do
  not ping — report "at today's cap" instead, which is itself the
  verification (the service cannot serve regardless). The ping
  otherwise counts in the spend ledger like any job. Never a path
  where verification spends past a cap.
- **Disclosure is one line, once per run,** e.g. "verifying services
  (one tiny prompt each)…" — and the docs' setup/start pages say the
  same sentence. Disclosed is the ruling's own word.
- **Non-interactive stays byte-identical**: supervisors neither spend
  nor print, exactly as B047 shipped.
- The B047 sign-in offer is unchanged; this extends what "verify"
  means for backends with no sign-in.

### B050 refined (Todd, same night, minutes later) — local models get STARTED, not reported

Todd re-read and sharpened it: "For local models running. We had a
ticket to start the models directly, so they didn't have to be running
ahead of time. I prefer that." The ticket is the icebox item from
09-02 eve (model-server auto-start, three tiers); this pulls its
runtime tier forward and supersedes detection-first FOR THIS MOMENT:
at interactive `start`/`run`, a configured local model server (ollama,
mlx) that does not answer the ping is STARTED by byollm — spawned and
supervised — not reported as somebody else's problem.

Why no [Y/n] here when the sign-in got one: typing `byollm run` is
the consent. The person asked this machine to serve its configured
services; starting the engine they configured is doing what they
asked, where opening a browser to a vendor login was doing something
adjacent to it. The disclosure line covers it: name what was started,
as it is started ("starting qwen-2.5-14b (mlx server was not
running)…").

Boundaries that stand: vendor CLIs (claude/codex) are never
auto-started into a login; sign-in remains ask-first. Metered/remote
HTTP endpoints are not ours to start — unreachable stays a report.
Non-interactive stays byte-identical. The setup-ceremony consent tier
and hosted-box supervision tier of the icebox item are untouched —
this is only the runtime tier, ruled preferred by Todd. Config gets a
per-service off-switch for anyone who manages their own server.

### B050 re-ruled (Todd, third pass, same night) — on-demand at job time, not pings at start

Todd's correction supersedes both earlier shapes: "they should call
the models to start them as needed, not keep them running when they
aren't... If we can start them when needed, probably don't need to do
so on start/run. We just need to check that subscriptions are
logged-in since they are the ones that logout all the time."

So the final shape, and it is smaller than either draft:
- **The preflight stays exactly as B047 shipped.** Sign-in check for
  subscription CLIs at interactive start/run — they are the things
  that log out. No canary pings, no per-service prompts, no metered
  spend at start. (The ledger rider dies with the pings it guarded.)
- **B050 proper = on-demand local-server start at JOB time,** in the
  daemon: a job routed to a local service (ollama/mlx) whose server
  does not answer gets the server STARTED, the job run, and cleanup
  left to the model runtime's own idle behavior (ollama unloads
  models after keep_alive on its own — Todd's "I think they
  auto-clean-up" is right for models; the server process left behind
  is light). Nothing is pre-warmed and nothing is kept resident for
  byollm's sake.
- **Open for CCB (the one real design question):** advertising. The
  daemon advertises models "actually there and healthy" — with
  on-demand start, a configured-but-stopped server should advertise
  as available (it IS available, one spawn away), which means the
  health question becomes "installed and startable," not "answering
  right now." First-job latency pays the model load; that is the
  trade Todd chose and the job timeout already bounds it.

CW note for the record: the ping-everything ruling lived for under an
hour and its supersession is the process working — the cheapest
version that serves the person (start it when they need it, check
only what actually breaks) beat the thorough version that spends on
ceremony. Ride: after Batch C with the rest, or wherever CCB slots
daemon work next.

### The prose check reads the passage — CW verify, 2026-09-05 (web 2b8f072)

CCB closed the M-note within the hour: the check now windows ±900
chars around each mention of the subject and demands the refusal
inside the window, reporting offsets. Code read clean (the /g-regex
lastIndex footgun is explicitly avoided — matchAll on the global,
a fresh non-global clone for the control). I verified WITHOUT touching
CCB's working tree, by running the window logic in python against the
real page source: current page passes with zero stranded mentions; the
exact partial revert from my note reddens with three.

One margin worth recording: the reverted callout's nearest refusal
token sits 912 chars away — the check catches today's layout by 12
characters. Any constant has a boundary, and this one is on the right
side of it, but if the corrected paragraph ever migrates ~15 chars
closer to the callout position, the partial revert quietly passes
again. Not a change request; a note so the number 900 is known to be
load-bearing at its edge.

---

## CW rolling review — 2026-09-05 tick #3: B013 + B016 (web dd17afa, byollm 22a889f), B051 endorsed

Verdict: both faithful, both better than their rows. Nothing published
— no tag gate.

**B013.** Confirmed against the SDK source, not the report: `lane?:
CloudLaneOptions` at app.ts:107 is the real option, and `git log -S`'s
"always has" claim matches the container clone. The bug is the nastier
kind — a recipe key TypeScript silently ignores, yielding a
direct-lane site that believes it is hosted, owner meaning the wrong
person, nothing saying so. The old test asserted the wrong spelling
and so CERTIFIED the bug; the new one is typed as the SDK's own
constructor parameter (rename upstream = compile failure) with a
control against vacuous extraction. Law minted in 016 at CCB's
suggestion: a check anchored to a spelling confirms the spelling, not
the thing.

**B016.** The defect was the SDK's hardcoded 8 MiB against a protocol
envelope cap that moved to 10 MiB (MAX_ENVELOPE_BYTES confirmed at
job.ts:456) — self-hosted direct lane refusing what the hosted lane
accepts. Fix derives the limit with the hub's own 512 KiB headroom. I
ran the suite (26 green) and re-ran the mutation BY HAND: restoring
the hardcoded 8 MiB reddens exactly the 9 MiB band test and nothing
else, which is the precision you want — the test lives in the gap
where the lanes disagreed, asserts the refusal REASON not the status
(schema failure is also a 400), and carries an over-cap control.

**B051 (proposed, BLOCKED on Todd) — CW verified the proof
independently.** I installed @byollm/protocol@0.1.0-alpha.64 from the
registry in a scratch dir and reproduced it: a valid .64 Capability
parses OK; add `knownModels` and strict returns `unrecognized_keys
["knownModels"]`. So the drift is real and the gun is loaded exactly
as described; CCB's blast-radius honesty (cloud lane means no daemon
heartbeats reach apps/test today) also holds. ENDORSED: one deliberate
lockstep bump of all four apps to .82 + delete the dashboard's dead
@byollm/relay@.9 dep, treated as a normal reviewed change with the
dashboard's deploy under Todd's usual gate. Recommend it ride BEFORE
Hosted (a hosted box pairs against current protocol; stale-pinned
dashboards are the wrong thing to discover that week).

---

## CW rolling review — 2026-09-05, Batch C close + B051 (web 24a8e02, f179758)

Verdict: faithful, Batch C CLOSED, B051's buildable half DONE. Nothing
published — the one remaining act is the dashboard DEPLOY, which is
Todd's gate and Todd's hands.

**B051, verified by simulation against the real tree** (no working-tree
edits): 10 workspace manifests, 5 @byollm deps, all `catalog:`, all
named in the catalog; the dead relay dep is gone from manifest AND
lockfile (all four stale resolutions purged — the lockfile diff is the
receipt). I re-ran both escape-hatch mutations as simulations: a
literal pin in www lands in the literal-pin list, and removing
@byollm/server from the catalog lands in asked-for-but-not-catalogued.
The test reads every workspace manifest with a control against empty
extraction, and the workspace file carries the whole story as a
comment where the next person will actually meet it. CCB verified by
building all four apps; between their build and my simulation the
claim is held from both sides.

**B017 read in full.** The ours-is-not-theirs split is exactly right
and the code's own comment convicted the old behavior — the action
already refused to forget the owner id on a network failure ("would
log somebody out because our own connection dropped") and then told
the SCREEN the person was refused. The new `unreachable` copy says the
true sentence: "Your job was not refused — we could not ask." The
provenance caption's three states honor the tri-state law in UI copy:
true = yours, false = shared with you, null = the sentence stops at
what is still true instead of guessing the friendlier half. That
null-is-not-flattery move is the pause/status lesson applied forward,
in the opposite direction — a screen must not say something nicer than
it knows, either. B015 verified-not-restated accepted.

Batch C's final score: five rows, of which four contained live bugs
("mostly docs" contained: a recipe teaching a nonexistent option held
in place by its own test, two lanes disagreeing on job size, a guide
contradiction in bold, ours-reported-as-theirs, and a caption telling
borrowers they owned machines). The board's expectation note said
"fast"; it was fast AND it was load-bearing, which is the argument for
never skipping the sweep batches.

---

## CW rolling review — 2026-09-05 ~6:40am UTC, B053 foundation (byollm f3cd255..3f81a33)

Verdict: faithful to the 016 ruling, and this is the FOUNDATION half —
decision logic, drain, wire channel, config gate. Not yet present, as
expected mid-build: the loop wiring (update-offered + autoUpdate ->
run the updater) and the hub half (sending updateTo, staged
cohorts/jitter, hosted-first). Suite green at the head (1333). Two
mutations re-run by hand: string-comparing versions reddens the
prerelease-numbers and release-above-prerelease tests (the exact
alpha.9-sorts-after-alpha.83 trap the comparator exists for), and
skipping the rollback canary reddens "stranded, not silent, when the
rollback installs and does not take."

What the diff shows, checked against the ruling point by point: drain
is NOT shutdown (finishes the running job, claims nothing; shutdown
cancels and releases — "an update is elective; a job is not"), and the
timeout is lease-bounded by design. exactVersion refuses tags and
ranges as a type, and update() refuses BEFORE draining when the target
is bad — a refusal must not cost the jobs the machine was about to
claim. The rollback keeps `from` as a value because "after a bad
install the machine can no longer be asked what it used to be," the
canary checks IDENTITY not liveness (a half-finished install leaves
the old binary starting perfectly), and a failed rollback strands
LOUDLY rather than looping. npm is argv-not-shell with exactVersion as
the first fence. The updateTo channel solves the strict-schema
ordering problem the RIGHT way — the hub declines to say what a
listener cannot hear, decided from daemonVersion already on the wire,
with the rule as code beside the field; the capability-list
alternative is rejected in a comment for the ordering hole it has.
UPDATE_OFFER_SINCE = .83 with "raising is safe, lowering is not."

One deviation, APPROVED as sequencing not disobedience: autoUpdate
defaults FALSE this release, with the ruling's default-yes arriving
next release behind setup's question — the mechanism ships and gets
watched on the fleet we own before it touches a laptop, and a config
that predates the field must not have its owner's consent invented by
an upgrade. That last sentence is the pause lesson applied to consent.

**WIRING-TIME MUST-CHECK (recorded now so it is not discovered
later):** `resumeClaiming()` exists and nothing calls it yet. When the
loop wiring lands, every update outcome that does NOT end in a process
restart (refused mid-flight, rolled-back where the same process
continues) must pair the drain with resumeClaiming — otherwise a
declined or failed offer leaves a daemon that quietly serves nothing,
which is Kevin's original bug wearing the updater's clothes. I will
test exactly this on the wiring cut.

### B053 wiring reviewed — same night, one commit later (9cfe5f4)

The wiring-time must-check was already answered before it was asked:
9cfe5f4 (CCB, 02:37 their time, minutes before my foundation review
landed) resumes claiming on every non-updated outcome and never
resolves the watcher — "none of them is a reason to stop working" —
and on success EXITS so the supervisor starts the new binary, because
this process is the old one and cannot become the new one. I re-ran
the stays-drained mutation by hand: deleting the resumeClaiming loop
reddens "goes back to work when the update did not take." The
refusal-above-drain ordering holds (a bad offer costs a machine
nothing), and one-offer-per-machine stops a daemon paired with four
sites from starting four updates of its one binary.

CCB's own catches this cut, both worth the record:
- The version canary matched the FIRST semver-shaped token in
  `byollm --version` output — a rewording made it match node's version
  from the second line and confidently roll back the whole fleet.
  Anchored to the `byollm` line now; a reworded line yields undefined,
  which fails the canary — wrong in the safe direction.
- Two drain tests passed in first draft WITH THE DRAIN DELETED (the
  fixture replayed one job id; the runner's own dedup declined the
  repeat, so the test proved deduplication it was not about). Rebuilt
  on fresh-work fixtures, counted at the CLAIM. The `paused` test it
  replaced had the same shape — which is presumably why THAT never
  caught anything either. The mutation-applied law, holding.

**M-grade for the hub-half cut:** `offered ??=` sets once per process
life. After a rolled-back update, a LATER offer of a strictly newer
(fixed) version is ignored until the daemon restarts — so fleet
recovery from a bad version rides on daemon restarts, not on the
channel. Either let a strictly-newer offer re-arm the watcher, or
state the restart-rides recovery plainly in the hub half's rollout
notes. Also standing open (CCB's, correctly boarded not guessed):
Windows Task Scheduler restarts on FAILURE, so exit-after-update may
strand the daemon until next logon — answer before personal devices,
not needed for hosted Linux.

Remaining for B053: the HUB HALF (send updateTo behind mayOfferUpdate,
staged cohorts/jitter, hosted-first) — needs a deploy, Todd's gate —
and the provision-page copy (product copy, Todd's approval).

### B052 (the floor) reviewed — same overnight run (a2c11a3)

Faithful, and the asymmetry at its center is the best thinking of the
night: checkDaemonFloor and mayOfferUpdate are the same question with
OPPOSITE unreadable-handling, on purpose — an unparseable version
means "do not offer" on one side and "do not refuse" on the other,
because guessing wrong on the offer breaks a heartbeat and guessing
wrong on the floor takes a WORKING machine out of service over a
string. I re-ran that exact mutation by hand (flip the guard so
unreadable refuses): red on "does not refuse a version it cannot
read." Suite 1343 green.

Also right, checked in the diff: `daemon-below-floor` is its own code,
not a reuse of unsupported-protocol-version (different sentences,
different remedies); the daemon maps by CODE not status, with the
four-status control test proving the branch is a code branch (a 403
otherwise reads as forbidden and retries forever — the exact
misdiagnosis class B036's message had); 426 fails safe on pre-B052
daemons (lands on the never-retried 4xx default, vaguer than the
remedy, which is what a fallback has to be); the hub's remedy sentence
passes through unparaphrased because the hub knows the floor and the
daemon does not.

Remaining for both B052 and B053: the HUB HALF (declare the floor +
send updateTo, both behind their fences) — needs a deploy, Todd's
gate. The daemon side of the entire update system is now built and
reviewed, uncut; it presumably rides the next release with whatever
Hosted needs.

### The M-note closed, and it was worse than the note — 78fc6ad reviewed

My M-grade said the HUB half would need to re-arm on strictly-newer
offers; CCB found the daemon was the side dropping them, and TWO
mechanisms held it: `??=` kept the first offer forever, and the
watcher returned after a failure, ending the loop that would have
seen the next one. Together: a machine that rolled back once never
updated again until restarted — the fix for a bad release could not
reach the machines the bad release landed on, the population an
auto-updater exists for. Fixed as last-writer-wins plus a memory of
attempted versions (without which the still-arriving offer becomes a
reinstall-every-second loop), and the watcher keeps watching.

Verified: suite 1347 green; I re-ran the memory-deleted mutation by
hand — red on "does not retry a version it has already failed on."
And the test carries its own confession worth the record: the first
draft of that test PASSED with the memory deleted, because it aborted
after the first attempt — before a forgetful watcher could make a
second — so it stopped the loop and then asserted the loop had not
run. Counted in cycles of the offer arriving now: five chances to
retry are five chances the assertion can see. That is the
mutation-applied law catching its second scalp of the night, this
time before review ever saw the draft.

B052+B053 daemon side: COMPLETE and reviewed, both M-grades resolved
(re-arm fixed; Windows restart semantics stays boarded for the
personal-devices release). Hub halves remain the only unbuilt pieces,
both Todd-gated.

### B050 daemon side reviewed — same overnight (c687748 + c13635c)

Faithful to the third-pass ruling, and the security thinking is the
best part. Verified by hand: opening the loopback gate to the world
reddens three tests (suite 1360 green after restore). The fences, each
one the right shape:
- **Loopback-only, by HOSTNAME, no DNS** — "a name that resolves to
  loopback today is a name somebody else controls tomorrow, and this
  decides whether to run a program." Starting a local process because
  a REMOTE endpoint is down would at worst succeed and serve a
  different model on a coincidental port.
- **spawnServer absent by default** — connect/services/status all
  build Runners to ask questions, and none of them may start a model
  server as a side effect of asking. Only the job-running daemon
  passes the seam.
- **ollama-only start command**, others say nothing (the
  verified-not-guessed precedent from login.ts); an unknown id behaves
  exactly as before B050 existed.
- **Startability before health**, because the other order costs a
  request per job on every backend including the ones the answer
  could never change.

CCB's own catch, the FOURTH vacuous-first-draft this week and a new
species: an ordering assertion built on two indexOf calls passed with
the code DELETED, because indexOf returns -1 for a call that is not
there, and -1 is less than every real index. "An ordering assertion on
its own passes most convincingly when the thing has been removed
entirely." Presence checked first now. The mutation-applied law keeps
earning its keep before review ever arrives.

Correctly boarded rather than decided at 4am: the advertising open
(configured-but-stopped should advertise per the ruling, but needs
"installed and startable" distinguishable from "configured and
absent" first) — that wants Todd's eyes, and B018 was checked and
boarded BLOCKED(on Todd) for the overnight for honest reasons
(entitlement sits in the frozen purchase surface; fleet is a deploy;
Your Devices' three actions all call unbuilt machinery). The protocol
is doing exactly what it was written to do.
