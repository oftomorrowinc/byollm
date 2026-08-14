# BYOLLM — threat model and security contract

**Premise: every job payload is hostile input.** A server the daemon paired
with — or an attacker who reached that server, or another user whose `public`
job we claimed — is untrusted from the daemon's seat. The daemon runs prompts
on the owner's machine, so it MUST be incapable of turning a prompt into code
execution, tool use, file access, or network calls beyond the model call
itself.

This document states what is guaranteed, what is not, and where the operating
system stops us from going further. Everything claimed here has a test id; the
suite runs on every PR and its failure blocks publish.

---

## 1. The two threats, kept apart

These are constantly conflated, and conflating them is how a product ends up
promising something it cannot deliver.

**Breakout** — payload text escaping the model call into the machine. This is
made _structurally impossible_, not detected. §3 is how.

**Prompt injection** — payload text manipulating what the model _says_. No
daemon can prevent this, and BYOLLM does not claim to. What it does is bound
the consequences: the model has no tools, no retrieval and no MCP, and its
output is inert bytes that travel back over the protocol and into a log.

> **The guarantee, in one sentence:** your machine runs one model call and
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
at all, what remains is an owner who misconfigures their own machine. So the
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

### 3.3 What we cannot drop, and say so

**`HOME` is present in the child environment.** The `claude` CLI reads its
subscription credentials from the user's own config directory, so removing
`HOME` would remove the authentication this backend exists to use. The honest
consequence: the child process can reach the filesystem its user can reach.
What prevents it doing anything with that is **having no tools**, not the
environment. If that trade is not acceptable to you, do not configure a
process-class backend — the HTTP-class one spawns nothing at all.

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
process-class backend on Windows.** On a domain-joined machine `USERDOMAIN`
is the Active Directory domain and `LOGONSERVER` names a domain controller —
organisational identity and an internal hostname, neither implied by anything
in the allowlist. A hostile job running on a corporate Windows machine learns
both. What prevents it acting on that is the same thing as everywhere else:
**having no tools, no shell, and no network egress it can reach through the
model**. But the information is visible, we cannot close it, and if that is
not acceptable to you, do not configure a process-class backend on a
domain-joined machine — the HTTP-class one spawns nothing at all.

**No OS-level sandbox yet.** There is no seatbelt profile, no seccomp filter,
no namespace. The isolation described above is process-level. Adding an
OS-level layer where the platform allows is worth doing and is not done; this
document will say so until it is.


### 3.4 The device key file, and what protects it

byollm_009 gives each machine an Ed25519 identity key. It is the most
sensitive file the daemon writes, and unlike a runner token it cannot be
reissued: losing it means re-pairing every app, and leaking it means someone
else can be this machine.

**On macOS and Linux it is written `0600`**, and the mode is re-checked on
every load — a restore from backup or a stray `chmod -R` can widen it after
the fact, and silently re-tightening would hide that something on the machine
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
both directions: POSIX asserts the mode, Windows asserts that it is *not* what
protects the key, so nobody deletes the awkward assertion and restores a false
one.

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

If you run a daemon on a shared Windows machine where other accounts can read
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
| `metered` | The owner's money, per token | `self` unless acknowledged, **and** capped |
| `subscription` | A provider's terms | `self`, always |

The bug this closed: `openai-http` was classed "open" while also accepting an
API key, so an owner could point it at a paid endpoint, offer it `public`, and
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
why. Standing up a relay is a deliberate act by the machine's owner, against
their own account, on their own hardware. The threat model here is a *hostile
job* reaching a backend it should not — not an owner circumventing a rule that
exists to protect them. An owner who wants to donate their credit balance can
already do it in one line by acknowledging the spend; the relay is a harder
path to the same place they were always permitted to go.

What the rule does prevent is the accident, which is the failure that actually
happens: `openai-http` pointed at a remote paid endpoint and offered `public`
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
- **The ingress log records the job's owner**, so the machine's owner can see
  who they have been working for.
- **Retention**: a `named`/`public` prompt is kept in full for 7 days by
  default, then reduced to its hash. A volunteer must not indefinitely retain
  strangers' content. The hash and the metadata stay, so the owner can still
  prove what ran.

Widening who may use a machine requires an explicit interactive confirmation
that names what it means in plain language, and is refused outright when stdin
is not a TTY — consent is never inferred from a script.

Test id: `COMMUNITY_BUDGETS`.

---

## 6. The return trip is untrusted too

§1–5 protect the volunteer's machine from the app's payload. This section is
the mirror: it protects the app from the volunteer's result.

A `named`/`public` result is **attacker-controlled text**. The volunteer's
machine, or a compromised one, can return anything, and an app would otherwise
render it as its own AI's output.

Every result carries provenance to the delivery seam:

```ts
{
  (audience, runnerId, runnerOwner, backendClass, model, untrusted);
}
```

`untrusted` is **derived** from the audience (`audience !== "self"`), never
supplied, so no caller can mark volunteer output as first-party.

**If you are an app developer**, a result with `untrusted: true` must not be
rendered as trusted HTML, fed to a privileged downstream step, or presented to
a reader as your own AI's answer without disclosing where it came from. There
is no redundancy or verification of community results in v0 — that is a
documented limitation, not an oversight.

Test id: `RESULT_PROVENANCE`.

---

## 7. Identity and trust boundaries

- A runner token is bound to **exactly one user**, learned from that user's own
  authenticated session during device-code pairing. A daemon can never assert
  who it is.
- Owner ids are **server-namespace-local**. `alice` on one app is not `alice`
  on another, which is why the daemon's `named` allowlist is keyed by
  **(server origin, user id)**.
- A `named` job is admitted only by the daemon's **own local allowlist**. A
  server's assertion that a runner is allowed is never sufficient — honouring
  it would mean obeying the server rather than enforcing against it.
- The allowlist is **empty by default**, so a fresh daemon is effectively
  self-only until its owner deliberately widens it.
- Tokens are stored as SHA-256 on the server and in a `0600` file on the
  daemon. The daemon's whole state directory is readable and deletable by its
  owner, by design.
- Revocation is one-way and takes effect at the next heartbeat at the latest.

---

## 8. The adversarial corpus

A named corpus of hostile payloads runs as a **blocking CI gate**. Each row
asserts "reached the model verbatim, changed nothing else."

Process-class families: shell metacharacters and command substitution; argv
injection (`--dangerously-skip-permissions`, `--mcp-config`, `--allowedTools
Bash`, `-p` lookalikes, `--` smuggling); path traversal and `file://`/`@file`
tricks; environment exfiltration; unicode (RTL override, zero-width,
homoglyph) and control characters; oversized payloads.

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

Open a security advisory on `github.com/oftomorrowinc/byollm` rather than a
public issue. Pre-release, there is no formal SLA; the honest expectation is
best effort.
