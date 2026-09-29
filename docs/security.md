# BYOLLM — threat model and security contract

**Premise: every job payload is hostile input.** A server the daemon paired
with — or an attacker who reached that server, or another user whose `team`
job we claimed — is untrusted from the daemon's seat. The daemon runs prompts
on the owner's computer, so it MUST be incapable of turning a prompt into code
execution, tool use, file access, or network calls beyond the model call
itself.

This document states what is guaranteed, what is not, and where the operating
system stops us from going further. Everything claimed here has a test id; the
suite runs on every PR and its failure blocks publish.

---

## 1. The two threats, kept apart

These are constantly conflated, and conflating them is how a product ends up
promising something it cannot deliver.

**Breakout** — payload text escaping the model call into the computer. This is
designed out, not detected — and re-proved against the real binary on every
run. §3 is how.

**Prompt injection** — payload text manipulating what the model _says_. No
daemon can prevent this, and BYOLLM does not claim to. What it does is bound
the consequences: the model has no tools, no retrieval and no MCP, and its
output is inert bytes that travel back over the protocol and into a log.

**"No retrieval" is a claim about somebody else's CLI, and it was false once.**
An agentic CLI can read a file named in the prompt *before the model turn*, in
an input preprocessor that no tool switch touches — which is retrieval, and it
turns prompt injection back into file access. That is what happened, it is
closed, and §3.2 states the flag that closes it and the live check that keeps
asking. Read the sentence above as resting on that check, not on a design.

> **The guarantee, in one sentence:** your computer runs one model call and
> nothing else; what the model _says_ is between you and the app that sent it.

An app that feeds a BYOLLM result into a privileged downstream step has
re-created the risk on its own side. See §6.

---

## 2. What a job can cause

A claimed job of kind `llm.generate` or `llm.chat` results in **exactly one
action**: text sent to the configured model backend, text returned.

Nothing in the payload may influence anything else — not the model, not the
backend, not the base URL, not flags, not the filesystem, not the environment.
The payload is data handed to a model, never configuration and never a
command.

This starts at the wire schema. There is no field on a job for a model, a
path, a URL, an argument or an environment variable, and payload objects are
`strict()`, so an unknown key is a parse failure rather than something
silently ignored deeper in.

```ts
GeneratePayload.safeParse({ prompt: "hi", model: "gpt-4" }).success; // false
```

Test ids: `NO_PAYLOAD_ROUTING`, `KIND_NO_CODE`, `KIND_TYPED_ONLY`.

---

## 3. Backend classes

The two classes have genuinely different threat surfaces, so they get
different treatment rather than one blurred description of both.

### 3.1 HTTP-class — `openai-http`

Any OpenAI-compatible server: Ollama, `mlx_lm.server`, llama.cpp server, vLLM.
One backend, N owner-configured base URLs.

**It spawns nothing.** The argv, stdin, environment and sandbox requirements
below are not applicable _by construction_ rather than by discipline. The
prompt travels as a JSON string field in a request body; there is no command
line for it to escape into because there is no command line.

What remains is the destination:

- the base URL comes from owner config and **nowhere else** — no payload field
  can set it, redirect it, or append to it;
- the request path is a hardcoded literal, and the computed URL is re-checked
  against the configured origin;
- redirects are **refused** (`redirect: "error"`), so a permitted base URL
  cannot become a forbidden one in flight;
- the response body is read through a cap, so a hostile or simply broken local
  model cannot exhaust memory.

**On SSRF filtering, honestly.** The spec calls this surface "SSRF-shaped".
The shape matters: since the base URL has no attacker-controlled input channel
at all, what remains is an owner who misconfigures their own computer. So the
check deliberately **allows loopback and private LAN addresses** —
`http://127.0.0.1:11434` is Ollama's default and the entire point of the
product — and refuses only cloud-metadata and link-local addresses, where a
misconfiguration on a cloud VM would hand out instance credentials. A filter
that broke the primary path in exchange for no real protection would be
theatre, and we would rather say so than ship it and claim credit.

Test id: `HTTP_BASE_URL_SAFE`.

### 3.2 Process-class — `claude-cli`

Spawns a binary. Every requirement below is mandatory here.

- **Fixed argv.** The argument vector is a frozen literal. There is no builder
  that appends to it and no mechanism to pass job-supplied arguments. The
  adversarial suite asserts that every hostile payload produces byte-identical
  argv.
- **Prompt on stdin.** Always. Never as an argument, never through `sh -c`.
  `shell: false`, so the argv array reaches `execvp` verbatim and
  metacharacters in it are just bytes.
- **No shell-invoking APIs.** `exec`, `execSync` and `spawnSync` are banned by
  an eslint rule, not only by convention. This holds on Windows too, where it
  costs something: npm installs `claude` as a `.cmd` shim, and Node refuses to
  spawn one without a shell. `shell: true` would have fixed that in a
  character and breached `NO_SHELL_INTERPOLATION`, so instead the shim is
  resolved to the JavaScript it would have run and that script is executed
  under the Node binary already running the daemon. The script path is an
  argument to Node, never to the CLI, so the fixed argv above is byte-identical
  on every platform.
- **No tools.** `--tools ""` is the CLI's own switch for disabling every
  built-in tool, plus `--strict-mcp-config` with an empty `--mcp-config` so no
  MCP server is available and none is inherited from the user's own settings.
- **No file surface outside the scratch directory** — and this is a *separate*
  guarantee from the one above, because the switch that delivers it is a
  different switch. The `claude` CLI expands `@`-file mentions in the prompt
  **before the model turn**, in its own input preprocessor rather than through a
  tool, so `--tools ""` never touched it: an `@/absolute/path` or `@~/path` in a
  job payload put the file's bytes into the context window and the answer
  brought them back. `--restricted` confines that surface — the preprocessor
  included — to the working directories, and the working directory is the empty
  scratch dir below. So the containment is that **there is nothing in scope to
  name**, not that anything refused. `--restricted` also ignores the user's,
  the project's and the local settings files, so a hook or a system-prompt
  append out of somebody's own `~/.claude` no longer reaches a job.
  `--setting-sources ""`, `--safe-mode`, `--disable-slash-commands` and
  `--permission-prompts none` were each tried against a canary and each leaked;
  this is the one that did not.
- **`codex` reaches files through a tool, and `-s read-only` is not the fence.**
  Read-only means read anything and write nothing, so what stands between a
  payload and any file the owner can read is the `--disable` list in
  `codex-cli.ts` — with it removed the model runs `cat` on an absolute path and
  returns the contents. Nothing needed changing there; the list was already
  doing it. What changed is that it is now proved the same way.
- **Stripped environment.** An allowlist of `PATH`, `HOME`, `LANG`, `LC_ALL`,
  `TZ`, `TMPDIR`, plus `CI=1` — and on Windows only, eight more (§3.3).
  Everything else is dropped, so a prompt that says "read your environment"
  finds nothing worth having. `ANTHROPIC_API_KEY` is deliberately absent on
  every platform, so billing cannot silently move from the subscription to a
  metered key.
- **Scratch `cwd`.** A fresh empty directory per job, removed afterwards.
  Never the daemon's directory, never the user's home, never anything a
  payload named.
- **No inherited descriptors** beyond the three std streams.
- **Hard ceilings.** A wall-clock timeout and an output-size cap. The child is
  sent `SIGTERM`, then `SIGKILL` two seconds later if it has not exited — the
  escalation is gated on the process having actually exited, not on "a signal
  was sent", so a child that ignores `SIGTERM` cannot outlive its budget.

Test ids: `NO_SHELL_INTERPOLATION`, `STRIPPED_CHILD_ENV`.

**How the file claim is proved, and what proof it is not.** The corpus in §8
has carried `@/etc/passwd` since it was written and this suite passed it every
time — because those rows run against a probe binary that reports its argv and
exits. A probe has no input preprocessor, so "the payload reached the model
verbatim" was the only question it could answer, and the hole was in a question
it could not be asked. The proof is therefore a separate row,
`file-mentions-stay-outside.test.ts`, which runs the **real** binaries:

- The guarded side calls the shipped backend, so the argv, the environment
  allowlist and the per-job scratch `cwd` are the ones a job gets.
- The **control decides whether anything was proved.** A model that will not
  read a file answers exactly like one that cannot, and the same argv that
  leaked three times in a row refused once — so the row first runs the same
  prompt with `--restricted` removed (for codex, with the `--disable` list
  removed) and reports **inconclusive**, not a pass, unless that leaks.
- A positive control asserts the mechanism is the one written above: a mention
  of a file *inside* the working directory still expands. If that stops being
  true the containment is stronger than documented and the paragraph above is
  wrong, so the row goes red on purpose and the wording gets revisited.
- A hermetic half runs under a temporary `HOME`, needs no credentials and no
  network, and asserts only what a credential-free run can carry: that this
  binary still *recognises* `--restricted`. Option parsing happens before
  authentication, so a renamed flag surfaces as `unknown option` — which is the
  likeliest way this fix dies. It proves nothing about containment and says so.

### 3.3 What we cannot drop, and say so

**`HOME` is present in the child environment.** The `claude` CLI reads its
subscription credentials from the user's own config directory, so removing
`HOME` would remove the authentication this backend exists to use. The honest
consequence: the child process can reach the filesystem its user can reach.
What prevents it doing anything with that is **having no tools and no file
surface outside the scratch directory** (§3.2), not the environment. If that
trade is not acceptable to you, do not configure a process-class backend — the
HTTP-class one spawns nothing at all.

This paragraph used to end at "having no tools", and that was the whole of the
mistake. `HOME` in the environment is what made `@~/path` resolve, and the
sentence naming it as an accepted cost was three lines above the sentence
claiming the cost was covered. The cost was real; the cover was not. It is
covered now by an argv flag and a live check, and `HOME` stays for the same
reason as before.

**Windows needs eight more variables, for the same reason.** `HOME` does not
name the user's profile there, so the allowlist also carries `USERPROFILE`,
`APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`, `SystemRoot`, `windir` and `PATHEXT`.
The first three are the Windows spelling of the `HOME` compromise above — the
CLI reads its subscription credentials from the user profile. `TEMP`/`TMP` are
the platform's `TMPDIR`. `SystemRoot` and `windir` are how Windows resolves
core DLLs, including the socket stack; without them a child fails in ways that
look nothing like a missing variable. `PATHEXT` is how Windows resolves an
extensionless command name at all.

None of the eight is a secret — they are paths and an extension list — and the
consequence is the one already stated for `HOME`: the child can reach the
filesystem its user can reach, and what stops it acting on that is having no
tools. The widening applies on Windows only; on every other platform the
allowlist is exactly the seven above.

**The adversarial suite does not yet cover this.** Its environment assertion is
a hand-written copy of the Unix allowlist, so on Windows the widened set trips
it — 33 failures, and the same run shows Windows injecting further variables
(`HOMEDRIVE` among them) that are on neither list. Rewriting the assertion to
match what was observed is how a security test quietly stops testing anything,
so it has been left failing until someone decides what Windows adds
unavoidably and whether that is acceptable inside a §2 isolation claim. Until
then, **the process-class isolation claim is verified on Linux and macOS and
unverified on Windows** — CI runs `ubuntu-latest` only.

**macOS injects `__CF_USER_TEXT_ENCODING`** into every child regardless of the
environment we pass, at a layer below anything a process controls. It carries
a uid and a locale, no secret. It is named in the adversarial suite's
assertion rather than filtered out of it, so the test says what is actually
true.

**Windows injects six**, measured on a real runner rather than assumed:
`HOMEDRIVE`, `HOMEPATH`, `SYSTEMDRIVE`, `USERNAME`, `USERDOMAIN` and
`LOGONSERVER`. Linux injects none.

They cannot be removed. Naming a variable explicitly in the environment we
pass does not replace it — the injection happens below the process, so the
choice here is to state them, not to strip them.

Four carry nothing the allowlist does not already give: `HOMEDRIVE` and
`HOMEPATH` reconstruct the profile path we pass as `USERPROFILE`,
`SYSTEMDRIVE` is `C:`, and `USERNAME` is already a component of
`USERPROFILE`.

**Two do carry something new, and this is the honest cost of running a
process-class backend on Windows.** On a domain-joined computer `USERDOMAIN`
is the Active Directory domain and `LOGONSERVER` names a domain controller —
organisational identity and an internal hostname, neither implied by anything
in the allowlist. A hostile job running on a corporate Windows computer learns
both. What prevents it acting on that is the same thing as everywhere else:
**having no tools, no shell, and no network egress it can reach through the
model**. But the information is visible, we cannot close it, and if that is
not acceptable to you, do not configure a process-class backend on a
domain-joined computer — the HTTP-class one spawns nothing at all.

**The file confinement is one flag in somebody else's CLI, and it is checked
rather than trusted.** `--restricted` is the whole of it. If a future release
renames it, drops it, or keeps the name and narrows the meaning, the hole
reopens and nothing about our code changes. Three things follow, and all three
are costs rather than reassurances:

- A renamed or removed flag is caught hermetically — option parsing precedes
  authentication, so the credential-free half of
  `file-mentions-stay-outside.test.ts` sees `unknown option`. A flag that keeps
  its name and stops confining is caught only by the live half, which needs the
  binary present and signed in.
- **`--restricted` ignores the user's, the project's and the local settings
  files. Managed (policy) settings still apply.** On a computer where an
  administrator has installed a managed settings file, that file's hooks and
  system-prompt additions still reach a job. We cannot switch that off and do
  not try to; it is the administrator's computer.
- **The claim is proved where the row has run.** Verified on macOS against
  `claude` 2.1.277 and `codex` 0.149.1, with byollm's exact argv, environment
  and scratch `cwd`. CI does not install either CLI, so **CI proves that the
  flags are in the argv, not that they still contain anything** — the live row
  needs somebody's signed-in machine, which is why it is default-on there
  rather than opt-in, and why it prints a line naming itself when it skips.
  Unverified on Windows and on Linux until the row runs there. Those version
  numbers are a date, not a guarantee — re-check rather than trust them:
  `pnpm vitest run --project adversarial file-mentions-stay-outside` on a
  signed-in machine, which reports inconclusive rather than passing if it
  cannot reach a model.

**No OS-level sandbox yet.** There is no seatbelt profile, no seccomp filter,
no namespace. The isolation described above is process-level. Adding an
OS-level layer where the platform allows is worth doing and is not done; this
document will say so until it is.

BY-01 is the argument for it. The bug was not a mistake in our code — the argv
was frozen, the environment was an allowlist, the `cwd` was an empty scratch
dir, and every one of those held. It was a capability in the child we had not
enumerated, and the fix is a request to the child not to use it. A seatbelt
profile or a namespace would make the same guarantee without asking: a process
that cannot `open()` outside its directory does not need to be persuaded. Until
that exists, everything in §3.2 about files is **a contract with a CLI, not a
property of the process** — and the difference is exactly one release of
somebody else's software.


### 3.4 The device key file, and what protects it

byollm_009 gives each device an Ed25519 identity key. It is the most
sensitive file the daemon writes, and unlike a bearer token it cannot be
reissued: losing it means re-pairing every app, and leaking it means someone
else can be this device.

**On macOS and Linux it is written `0600`**, and the mode is re-checked on
every load — a restore from backup or a stray `chmod -R` can widen it after
the fact, and silently re-tightening would hide that something on the computer
is treating it as ordinary data.

**On Windows that protection does not exist, and the code no longer pretends
otherwise.** Node synthesizes `mode` there: a writable file reports `0o666`
whatever `writeFile` was given, and `chmod` only toggles the read-only flag.
The mode we pass is ignored. What actually protects the file is the ACL it
inherits from the user's profile directory — real protection against other
*users*, weaker and less visible than an explicit mode, and not something the
daemon sets or verifies.

This was found by the platform CI matrix within hours of it existing, by a
test that asserted `0600` and failed. The tests are now platform-specific in
both directions: POSIX asserts the mode, and that a widened file is warned
about on load; Windows asserts only that the check is skipped — no warning is
printed there, because one that fired on every start would claim to have fixed
something it had not. Nothing asserts what _does_ protect the key on Windows;
that is the ACL described above, and it is unverified by this suite.

### 3.5 What an upstream observes — the spec is the record, permanently

**[byollm_009 §12](../specs/byollm_009-sessions-keys-envelopes.md) enumerates
what a hostile or compelled upstream can see. This document does not restate
it, and never will.** That is policy, not a gap awaiting a sync.

The reasoning is the one this codebase keeps arriving at from other
directions. A hand-maintained prose copy of a security guarantee is two places
deciding one value — the same shape as a version constant derived in two
files, a clock read twice, or an envelope deadline recomputed by its opener.
Each of those worked until the two copies disagreed. A duplicated threat model
has the same failure with a longer fuse: it drifts, nobody notices, and then
two documents disagree about what a relay can see. For this product that is
the worst possible sentence to have two versions of, because the answer is the
product.

So: **one source, many renderings, drift caught by machine rather than
prevented by discipline.** It is the third instance of a house pattern — the
provider docs generate from the registry, the landing page is checked against
the built packages by `scripts/check-site.mjs`, and any future
"what your relay can and cannot see" page includes the spec's enumeration at
build time with a CI check that the rendering still matches. Nothing
security-relevant is prose-copied by hand.

One thing is worth stating here, because it is a rule rather than a fact and
rules do belong in this document: **a leak we chose is still a leak and
belongs on the list.** `disposition` — the `ok`/`error`/`canceled`
discriminator — rides outside the sealed envelope so a relay can stop
dispatching a finished job without opening it, and in aggregate that is real
telemetry about someone else's system: failure rates by site, by user, by
backend. It was taken deliberately, over an alternative that left a relay
unable to tell an app it may re-enqueue. It went on §12's list the moment it
existed, and the next field to earn its way onto the wire goes on that list
too. A deliberate disclosure missing from the disclosure list is how an
"exhaustive" surface quietly stops meaning anything.

Tightening this with an explicit ACL (`icacls`) is worth doing and is not
done. It would mean spawning a process from the daemon's startup path, which
is a surface this project treats carefully, so it wants its own change rather
than a line here.

If you run a daemon on a shared Windows computer where other accounts can read
your profile, the device key is readable by them, and no amount of the above
changes that.

---

## 4. Output is inert

Returned text is treated as bytes. It is never evaluated, never written to a
path a payload named, and never interpolated into a shell.

When it reaches a terminal — through `byollm log` or `byollm status` — control
characters are replaced first, because text that can move the cursor or set
colours can forge output. The **stored** bytes stay verbatim, so the log
remains an honest record of what arrived; only the display is sanitised.

Log lines are JSON, so a payload containing newlines cannot forge a second
entry.

Test id: `OUTPUT_INERT`.

---

## 4a. Cost class — whose money, and whose terms

byollm_007 splits what used to be one field into three, because "not a
subscription" and "free to share" are different claims:

| `cost` | Constraint | Offer scope |
|---|---|---|
| `free` | Electricity | Widens freely |
| `metered` | The owner's money, per token | `private` unless acknowledged, **and** capped |
| `subscription` | A provider's terms | `private`, always |

The bug this closed: `openai-http` was classed "open" while also accepting an
API key, so an owner could point it at a paid endpoint, share it, and
donate their credit balance. The community budgets capped job *count*, not
spend, so nothing noticed.

**The enforceable part.** Cost is not configurable. For named providers it
comes from the protocol registry; for the generic HTTP backend it is derived
from the base URL — loopback and RFC1918 are `free`, everything else is
`metered`. An owner therefore cannot reach a paid API through the generic
backend and call it free, because the claim is checked against where the
request actually goes. An unparseable base URL is treated as metered: guessing
"free" wrong costs money, guessing "metered" wrong costs a config line.

**What the locality inference does not see.** The derivation reads the base
URL's host, and that is all it can read. A proxy listening on `127.0.0.1` and
forwarding to a paid API is `free` by this rule, and nothing downstream will
contradict it — the daemon sees a loopback address and has no way to learn
what is on the other side of it. Stating the limit plainly: **the inference
classifies the address, not the destination.**

We are not treating that as a hole to close, and it is worth being exact about
why. Standing up a relay is a deliberate act by the device's owner, against
their own account, on their own hardware. The threat model here is a *hostile
job* reaching a backend it should not — not an owner circumventing a rule that
exists to protect them. An owner who wants to donate their credit balance can
already do it in one line by acknowledging the spend; the relay is a harder
path to the same place they were always permitted to go.

What the rule does prevent is the accident, which is the failure that actually
happens: `openai-http` pointed at a remote paid endpoint and offered `team`
without anyone deciding to spend money. That case is caught, and it is caught
by construction rather than by noticing.

So read the guarantee as scoped: cost cannot be *declared* free, and a plainly
remote endpoint cannot be *mistaken* for free. It does not, and cannot, mean
that anything the daemon calls `free` is provably unbilled.

**The ceiling is counted, not just declared.** A shared metered backend must
carry a daily cap, and the daemon keeps a local ledger of estimated spend
against it. The estimate is deliberately crude and generous — providers do not
return a price, so it is token-count × an owner-supplied rate. It will not
match an invoice. It does not need to: it is a brake, and a defensible
over-estimate stops a runaway, which is what the owner actually wants. A
backend with no ceiling reads as *reached*, not as unlimited.

## 5. Community jobs get extra teeth

Everything above is the floor for all jobs. For jobs whose owner is not the
daemon's owner:

- **Per-source rate limits and a daily cap**, owner-configured, persisted
  across restarts so restarting the daemon does not reset a stranger's quota.
- **A tighter resource budget** — wall clock, output bytes, payload size —
  applied on top of the global ceilings.
- **The ingress log records the job's owner**, so the device's owner can see
  who they have been working for.
- **Retention**: a `team` prompt is kept in full for 7 days by
  default, then reduced to its hash. A volunteer must not indefinitely retain
  strangers' content. The hash and the metadata stay, so the owner can still
  prove what ran.

Widening who may use a device requires an explicit interactive confirmation
that names what it means in plain language, and is refused outright when stdin
is not a TTY — consent is never inferred from a script.

Test id: `COMMUNITY_BUDGETS`.

---

## 6. The return trip is untrusted too

§1–5 protect the volunteer's computer from the app's payload. This section is
the mirror: it protects the app from the volunteer's result.

A `team` result is **attacker-controlled text**. The volunteer's
device, or a compromised one, can return anything, and an app would otherwise
render it as its own AI's output.

Every result carries provenance to the delivery seam:

```ts
{
  (audience, runnerId, runnerOwner, backendClass, model, untrusted);
}
```

`untrusted` is **derived** from the audience (`audience !== "private"`), never
supplied, so no caller can mark volunteer output as first-party.

**If you are an app developer**, a result with `untrusted: true` must not be
rendered as trusted HTML, fed to a privileged downstream step, or presented to
a reader as your own AI's answer without disclosing where it came from. There
is no redundancy or verification of community results in v0 — that is a
documented limitation, not an oversight.

Test id: `RESULT_PROVENANCE`.

---

## 7. Identity and trust boundaries

- A device is bound to **exactly one user**, learned from that user's own
  authenticated session during device-code pairing. Every request after
  `pair` is signed by the device's pinned Ed25519 identity key
  (`REQUESTS_SIGNED_NOT_BEARER`); there is no runner token. A daemon can never
  assert who it is.
- Owner ids are **server-namespace-local**. `alice` on one app is not `alice`
  on another, which is why the daemon's admission is keyed by
  **(server origin, user id)**.
- A `team` job is admitted only by a **grant the device verified itself**,
  signed by the control-plane key it pinned at pairing and naming this site,
  this person, this job and the service to run. A routing party's assertion
  that a runner is allowed is never sufficient — honouring it would mean
  obeying the server rather than enforcing against it.
- A grant is **single-use** and short-lived, so a captured one replays
  nothing and a person removed from a team stops running at their next claim,
  including for work already queued.
- A device paired with **no relay** serves its owner and nobody else. There is
  no control plane to sign a statement about anybody, so there is nothing it
  could verify — and a `team` offer narrows to `private`, loudly.
- There is no runner token to store. A device code is held as SHA-256 on the
  server for the minutes a pairing is open; the device's private keys live in
  a `0600` file on the daemon (§3.4). The daemon's whole state directory is
  readable and deletable by its owner, by design.
- Revocation is one-way and takes effect at the next heartbeat at the latest.

---

## 7a. Updates

An auto-updating daemon hands whoever controls its updates the machine it runs
on, so this is the whole of what the updater will and will not do. It is off
unless the owner turns it on (`autoUpdate` in `~/.byollm/config.json`).

**Who may offer.** One origin: the update authority, `updateAuthority` in the
config, which is the reference hub (`https://hub.byollm.cloud`) when unset.
Every other paired site's offer is ignored, and the daemon says so once per
site. The authority's own offer counts only over a pairing that pinned a
control-plane key: a direct-mode pairing is one site, and never updates the
daemon every other site is also talking to.

**What is refused**, before anything is drained or installed:

- anything that is not a literal version — `latest`, `^0.1.0`, `0.1.x`;
- a version at or below the one running — **the updater never downgrades**,
  so an offer cannot walk a machine back onto a release with a known hole;
- a pair of versions it cannot order, and a machine whose own version it
  cannot name (it would have nothing to roll back to);
- a version it has already tried in this process.

**What is verified.** The install runs with `--ignore-scripts` and against
`registry.npmjs.org` only. Then, before anything runs the new binary, the
daemon reads the package's SLSA provenance from the registry and requires that
it was built by `oftomorrowinc/byollm`'s workflow from the tag `v<version>`,
that it names `byollm@<version>`, and that its subject digest is the tarball's
`dist.integrity` — the hash npm checked the download against. Anything
unreadable — no provenance, a 404, no network — fails the check. Then the new
binary is started and must report the version that was asked for.

What this does not verify, stated plainly: the daemon does not re-check the
Sigstore signature on the provenance bundle. npm checks it at publish and
refuses a publish whose bundle does not verify; the daemon trusts the
registry for that. So a stolen publish token is refused (it cannot produce
provenance from our workflow), and a lying registry is not something this
check defends against. `@byollm/protocol` is pinned to an exact version by
the verified package and is not checked separately. Updates are not staged:
every machine offered a version takes it on its next heartbeat.

**What a rollback looks like.** If the provenance check fails, or the new
binary does not answer with the version asked for, the daemon reinstalls the
version it came from — once — restarts it, and says on the owner's surfaces
what failed and that it rolled back, e.g. `update: 0.1.2 failed its
provenance check: there is no SLSA provenance for it; rolled back to 0.1.1`.
It goes back to serving and does not try that version again. If the rollback
itself fails, it says so and stops there rather than reinstalling in a loop:
the machine is left to a person.

Tests: `update.test.ts`, `provenance.test.ts` (against the registry's real
answer for `byollm@0.1.1`), `update-when-offered.test.ts`, `update-deps.test.ts`
in `packages/daemon/src`.

---

## 8. The adversarial corpus

A named corpus of hostile payloads runs as a **blocking CI gate**. Each row
asserts "reached the model verbatim, changed nothing else."

Process-class families: shell metacharacters and command substitution; argv
injection (`--dangerously-skip-permissions`, `--mcp-config`, `--allowedTools
Bash`, `-p` lookalikes, `--` smuggling); path traversal and `file://`/`@file`
tricks; `@`-mention expansion of absolute and `~` paths; environment
exfiltration; unicode (RTL override, zero-width, homoglyph) and control
characters; oversized payloads.

**What this gate cannot see, stated because it took a private report to find
it.** These rows run against a probe binary that reports its argv, environment,
`cwd` and stdin. That makes the assertion exact — the payload arrived verbatim
and changed nothing else — and it makes the gate blind to anything the *real*
binary does with a payload that arrived verbatim. The probe has no input
preprocessor, so `@/etc/passwd` sat in this corpus passing for months while the
shipped CLI was expanding it. A payload family belongs here; a claim about what
a CLI does with it belongs in a row that runs the CLI (§3.2).

HTTP-class families: absolute URLs and metadata hostnames in the payload; path
traversal; CRLF header injection; JSON breakout; control characters; oversized
payloads.

Plus ceilings: output cap, wall-clock timeout, cancellation mid-flight,
redirect refusal.

**A new backend cannot ship without its rows.** A coverage check asserts that
every registered backend declares a corpus and that the corpus is non-empty,
so adding a backend to the registry without hostile-payload coverage fails the
build.

---

## 9. Reporting a vulnerability

**[`SECURITY.md`](../SECURITY.md) is the one place that says how.** Read it
there; this section deliberately does not repeat it.

It used to, and the two had already drifted: this file said *"open a security
advisory … rather than a public issue"* and nothing about email, while
`SECURITY.md` offers both channels — and the two disagreed about what to
expect back, one saying "no formal SLA" and the other "within a few days".

That is a bad thing to have two answers to. Our own README and issue templates
link *here*, and GitHub's security tab surfaces *there*, so which promise a
reporter read depended on which door they came through — and one of the doors
hid a channel that works. `scripts/one-disclosure-path.test.mjs` fails if this
section starts explaining again.
