# byollm_004 — Execution isolation and the hostile-prompt threat model

**Premise: every job payload is hostile input.** A server the daemon
paired with — or an attacker who reached that server, or another user
whose `public` job we claimed — is untrusted from the daemon's seat.
The daemon runs prompts on the owner's machine; it MUST be incapable
of turning a prompt into code execution, tool use, file access, or
network calls beyond the model call itself. This spec is the security
contract, and its tests are non-negotiable CI gates.

## 1. The one and only thing a job can cause

A claimed job of kind `llm.generate`/`llm.chat` results in **exactly
one action**: text sent to the configured model backend, text
returned. Nothing in the payload may influence anything else — not
the model chosen, not the backend, not flags, not the filesystem, not
the environment. The payload is **data handed to a model**, never
configuration and never a command.

## 2. Concrete isolation requirements

- **No shell string interpolation, ever.** Backends are invoked via
  `execFile`/`spawn` with a fixed argv array and the prompt delivered
  on **stdin**, never as an argument and never through `sh -c`. There
  is no code path where payload text becomes part of a command line.
  (Test: payloads of `$(…)`, backticks, `;`, `&&`, `|`, newlines,
  `--flag`-looking text, 1MB of junk — all must arrive at the model
  verbatim and affect nothing else.)
- **Model/backend come from the daemon's local config only.** The
  job's `kind` selects a *route the owner defined*; a job can never
  name a model, a path, a URL, or a flag. Unknown kind → refused, not
  guessed.
- **Argument allowlist.** The exact flags passed to each backend are
  hardcoded per backend; there is no mechanism to pass through
  job-supplied arguments. `claude -p` runs with `--allowedTools`
  empty/none and no MCP config; the CLI wrapper additionally strips
  the ambient environment to a minimal allowlist so a prompt that
  says "read your env" finds nothing.
- **Child process sandbox.** Backends spawn with: a stripped env
  (allowlist: PATH, HOME, the one API/auth var that backend needs —
  nothing else), `cwd` set to an empty scratch dir, no inherited file
  descriptors beyond the three std streams, and a hard timeout +
  output-size cap (a job cannot wedge or OOM the machine). Where the
  OS allows, drop further (documented per-platform; not a false
  promise where it can't).
- **No prompt-driven tools.** The daemon exposes no tools, functions,
  retrieval, or MCP to the model. If a future kind needs tools, that
  is a new kind with its own spec and its own threat review — not a
  payload flag.
- **Output is inert.** Returned text is treated as bytes: never
  eval'd, never written to a path the payload names, never logged in
  a way that interpolates it into a shell. Result goes back over the
  protocol and to the ingress log as data.

## 3. Prompt-injection is the model's problem, not a breakout

Distinguish two threats and don't conflate them: (a) **breakout** —
payload escaping the model call into the machine — which this spec
makes *structurally impossible*, and (b) **prompt injection** —
payload manipulating the model's text output — which no daemon can
prevent and which is bounded here precisely because output is inert
and the model has no tools. The daemon's guarantee is narrow and
honest: "your machine runs one model call and nothing else; what the
model *says* is between you and the app that sent it." Documented
plainly so integrators don't assume more.

## 4. Extra teeth for community jobs (`named`/`public`)

Everything above is the floor for all jobs. For jobs whose owner is
not the daemon's owner, additionally: per-source rate limits and a
daily cap; a resource budget (wall-clock, tokens, output bytes) the
owner sets and the daemon enforces; the ingress log records the job
owner; and payload size/shape limits are stricter. The scarier-
confirmation for widening scope names these in plain language.

## 5. The adversarial test suite (CI gate, part of conformance)

A named corpus of hostile payloads, each asserting "reached the model
verbatim, changed nothing else": shell metacharacters and command
substitution; argv injection (`--dangerously…`, `--mcp-config`,
`-p` lookalikes, `--allowedTools Bash`); path traversal and
`file://`/`@file` tricks; env-exfiltration prompts; oversized and
malformed payloads; unicode/control-char and encoding tricks;
attempts to set model/backend via payload; ANSI/log-injection in
text that gets logged; zip-bomb-style output from a hostile local
model (cap holds). Each has a test id; the suite runs on every PR and
its failure blocks publish. New backend = new adversarial rows before
it ships.

## Done when

Every requirement in §2 has a passing test; the §5 corpus is green
and wired into CI as a blocking gate; `docs/security.md` states the
threat model, the breakout-vs-injection distinction, and the honest
boundary of the guarantee; a third-party backend cannot be added
without adding its adversarial rows (enforced by a coverage check
that every registered backend has a corresponding hostile-payload
suite).
