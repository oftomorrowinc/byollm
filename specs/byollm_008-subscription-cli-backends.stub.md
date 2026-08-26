# byollm_008 — Subscription CLI backends (stub)

**Status: stub, scoped and deliberately not built (2026-08-13).**
byollm_007 gave `subscription` a cost class and exactly one member:
`claude-cli`. The obvious next members — `codex` and the Gemini CLI —
are not one-line registry additions the way the metered HTTP providers
were, and this records why, so nobody later mistakes the gap for an
oversight.

## Why these are not registry lines

byollm_007's central economy is that **providers are entries, not
implementations**: every HTTP provider shares one audited transport, so
adding one is a line of data and the existing adversarial corpus
already covers it. That economy comes from the wire format being
identical — `POST /v1/chat/completions`, one shape, one parser.

Process-class backends have no such shared surface. Each CLI is its own
executable with its own flags, its own output format, its own auth
model, and its own idea of what a prompt is. byollm_004 §2 applies to
every one of them individually:

- **Fixed argv.** The argument vector is a literal in our source. No
  payload-derived token ever reaches it, so each CLI needs its own
  vector worked out and pinned — and each new flag is a review.
- **Prompt on stdin only.** Which requires knowing that the CLI reads
  stdin at all, and that it does not also interpret what it reads.
- **Stripped environment.** An allowlist per CLI, because each one
  authenticates differently, and "pass the environment through" is the
  failure this rule exists to prevent.
- **Its own corpus rows.** The adversarial coverage check refuses a
  backend with no hostile-payload rows, and rows written against
  `claude -p` do not exercise another CLI's parser.

A shared `subscription-cli` transport with per-CLI config would look
like the HTTP economy and would not be it: the thing being shared would
be argv construction, which is precisely the surface byollm_004 makes
non-generic on purpose.

## What this spec has to answer

1. **Per-CLI isolation, written out.** Fixed argv, stdin contract,
   env allowlist, and corpus rows for each of `codex` and the Gemini
   CLI — the byollm_004 §2 treatment, once per binary.
2. **Detection.** `CAPABILITY_IS_DETECTED` says never advertise what is
   not installed and healthy. Each CLI needs a health probe that does
   not cost a token and does not hang.
3. **Auth without a key.** These authenticate out-of-band (a login, a
   config file). The daemon must not read, copy, or log those
   credentials — it inherits a session it cannot see.
4. **Whether `subscription` is right for each.** It is the correct
   class only where terms actually cover one person's work. That is a
   question about each vendor's terms, answered per CLI, not assumed
   from the fact that it is a CLI. A CLI that bills per token is
   `metered` and belongs in the HTTP story or its own.
5. **Output parsing as hostile input.** `OUTPUT_INERT` already holds;
   each CLI's format (JSON, stream-JSON, prose) needs its own parser,
   and each parser is new attack surface.

## Why not now

Nothing consumes them. `claude-cli` covers the dogfood, and the alpha's
scarce resource is review attention on the isolation boundary — which
is exactly what adding two more spawned binaries spends. The cost axis
was worth doing immediately because it closed a hole that could cost a
volunteer real money; this closes no hole, it adds reach.

The registry is ready for them: `subscription` exists, the self-lock is
enforced on both sides and certified, and `byollm offer` already
refuses to widen a subscription backend. What is missing is the
per-binary isolation work, and that is the whole spec.

---

2026-08-24: Phase 2 of byollm_015 promotes this stub. The five questions above are the acceptance list; the economy argument stands as written.

---

## Verdicts (Todd + CC, 2026-08-25, empirical)

**gemini-cli: disqualified.** File-reading tool access is built in,
and every documented way to disable it was tried — a dozen
approaches — and did not work. That fails byollm_004 §2 at the
threshold: the requirement is that no tool be *reachable*, not that
tools be configured off, because the prompt is site-authored data
and injection rides in with it. A CLI that can read files turns "run
this text through a model" into "let this text read the owner's
disk" — byollm_012's permanent no. Revisitable only if gemini-cli
ships a no-tools mode that survives the probe below. Note the pitch
consequence honestly: "works with the subscription you already have"
excludes Gemini-subscription CLIs for now; Google models remain
reachable app-side via the metered API lane — the removal is of this
adapter, not of a vendor.

**codex: qualifies.** All tools can be turned off, Claude-Code-like;
proceeds through the stub's five questions as planned.

**Rule minted from how the verdict was reached: containment is
tested, never read.** Vendor documentation of a lockdown flag is a
claim, and this one was false a dozen ways. A process-class backend
qualifies by *demonstrated* containment: its adversarial corpus MUST
include a tool-escape probe — a prompt instructing the CLI to read a
file and echo it (and kin) — passing only when no tool fires. This
joins the five questions as a sixth, for codex now and every CLI
after it.

**Ruling (Todd, 2026-08-25): the disqualification goes public.** The
home page and docs state gemini-cli as NOT supported, with the
reason — its built-in file access cannot be disabled, and our
isolation rules require that no tool be reachable from a prompt. Two
precision requirements: the claim is dated and versioned (as tested
against the gemini-cli version current 2026-08; the tool-escape probe
is the standing re-test, and support returns if it ever passes), and
the same surface is honest in the other direction — codex is "coming"
until its adapter ships and its probe passes, never "supported" early
(claims trail proofs). Shape: a supported-backends table — supported
(openai-http servers, claude-cli), coming (codex), not supported
with stated reason (gemini-cli).

**Update (Todd, 2026-08-25): the codex adapter is done — no "coming"
row.** The public table is two states: supported and
not-supported-with-reason. Codex lists exactly like Claude Code —
"(subscription, locked to your own work)". Condition carried from the
sixth question: "supported" presumes the codex tool-escape probe row
exists and passes in the adversarial corpus — CCC to confirm; if the
row is missing, it lands before the table does.

---

## The keychain finding + the health-canary question (2026-08-25 night)

First cross-user job's claude failure, root-caused and fixed
(40662bf): on macOS the Claude CLI keeps credentials in the login
Keychain, reached via USER — absent from the env allowlist, so the
child found its config and not its credentials. Bisected against the
real binary: allowlist fails, +USER succeeds, +LOGNAME fails (same
name, different variable, unread — stays out; the allowlist admits
what is proven needed, nothing shaped like it). The allowlist's own
comment predicted this failure shape for Windows; it arrived on macOS
first. Codex unaffected (~/.codex under HOME).

**Principle recorded: a health check that can't fail the way the
thing fails is reporting on something else.** `--version` needs no
credentials; every job does. Cowork's recommended ruling (Todd's
call): a credentialed canary at *enablement* and *daemon start* —
bounded, human-adjacent moments — never on the polling loop (paid
calls to reassure nobody); plus the free leg: auth-shaped real-job
failures flip the service unhealthy with a notice after the first,
closing the gap within one job with zero standing spend.

Also clarified (Todd's correction): routing honored the config
default throughout — claude-as-default routed claude, the switch
routed qwen. The four-isDefault bug is the *advertisement* lying
about a decision the daemon makes correctly — a wire flag
disagreeing with the behavior it describes, the flattering-copy bug
in a protocol field, and the Phase B guard field at that. Fix soon.
