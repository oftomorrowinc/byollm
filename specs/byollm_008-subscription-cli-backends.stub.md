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
