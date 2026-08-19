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


### The registry index

Every MUST this spec adjudicates, by id, with the section that decides it.
Added by cloud_008 Tier 4 §1.3b: byollm_009 was the only spec with a table,
so the registry was the sole enumerated home for 34 of 38 MUSTs and nothing
could compare the two. `musts-match-specs.test.ts` reads these tables.

**An index, not a restatement.** The statement lives in `MUSTS` and the
reasoning lives in the sections named below; a table that repeated either
would be a third copy to drift. What a reader gets here is the set, and what
the check gets is a list it can compare against the registry.

| MUST | Adjudicated in |
|---|---|
| `COMMUNITY_BUDGETS` | §4 |
| `HTTP_BASE_URL_SAFE` | Rev 1 §Backend taxonomy |
| `NO_PAYLOAD_ROUTING` | §2 |
| `NO_SHELL_INTERPOLATION` | §2 |
| `OUTPUT_INERT` | §2 |
| `STRIPPED_CHILD_ENV` | §2 |

## Done when

Every requirement in §2 has a passing test; the §5 corpus is green
and wired into CI as a blocking gate; `docs/security.md` states the
threat model, the breakout-vs-injection distinction, and the honest
boundary of the guarantee; a third-party backend cannot be added
without adding its adversarial rows (enforced by a coverage check
that every registered backend has a corresponding hostile-payload
suite).

---

## Rev 1 — CC review adjudication (2026-08-08)

**Backend taxonomy (review #5) changes what §2 applies to.**
- **HTTP-class** backends (OpenAI-compatible servers: Ollama,
  `mlx_lm.server`, llama.cpp, vLLM) **spawn nothing** — §2's argv/
  stdin/env/sandbox requirements are N/A by construction. Their
  threat surface is SSRF-shaped: the base URL is **owner-config
  only** (a job can never set or redirect it), requests go only to
  the configured URL, and the daemon refuses base URLs that resolve
  to metadata endpoints / link-local ranges. This is the safest
  class and should be preferred where a model offers an HTTP server.
- **process-class** backends (`claude` CLI; `mlx_lm.lora` for
  `train.*`) are where all of §2 (fixed argv, stdin, stripped env,
  scratch cwd, no inherited FDs, caps) is mandatory.
Each backend declares its class; the adversarial suite (§5) runs the
process-class corpus against process backends and an SSRF/base-URL
corpus against HTTP backends.

**Ingress-log retention (review #7).** §4 (community jobs) gains a
retention default: prompts from `named`/`public` jobs are kept in
full for a short window (default 7 days) then reduced to hash + job
id — a volunteer must not indefinitely retain strangers' content.
`self` jobs retain per the owner's preference (default: keep).
Retention is configurable; the default is stated in the daemon UI.

**Return-trip pointer.** The result of a non-`self` job is untrusted
*to the app* — modeled in 003 Rev 1. Noted here so the threat model
is symmetric in one place: 004 protects the volunteer's machine from
the payload; 003 protects the app from the volunteer's result.
