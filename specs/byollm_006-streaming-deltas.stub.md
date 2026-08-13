# byollm_006 — Streaming deltas (stub — requirement from the first real consumer)

**Status: stub, deprioritized (2026-08-12).** The first production
consumer is now an internal publishing suite's local-jobs lane —
async jobs (`llm.chat` / `llm.generate`) that the request/response
protocol serves today, so nothing currently drives streaming. The
voice product that surfaced this requirement deferred its byollm
integration entirely (its end users won't run daemons); its latency
numbers below are retained because they are what any future
live-voice consumer will hit. Revisit when one exists.**

## The requirement, as discovered

CD's call surface runs live voice conversations (ElevenLabs transport).
Its persona turns have a hard latency budget: **ElevenLabs begins
retrying around ~4s**, and a subscription backend's first byte alone
measured **~2.3s** (`claude -p`, warm, no queue hop). The protocol
today is request/response — `llm.chat` / `llm.generate` / `llm.exec`
return whole results, so **first token and last token are the same
moment**. A live persona turn through the daemon therefore lands at the
edge of the budget or past it. This was a deliberate v1 scope choice,
not an oversight: the alpha's hard part was the MUSTs, the audience
model, and breakout-impossible-by-construction, and a delta channel
complicates all three.

## What CD does meanwhile (no protocol change needed)

- **Async inference first**: scoring, debriefs, puzzle grading, idea
  generation — real cost, no latency budget. This is the clean first
  dogfood and exercises the whole loop (job → daemon → backend →
  result → ledger).
- Live turns stay on the app's metered path, or may try the `ollama`
  backend with a small local model, whose first byte may clear the
  budget without deltas.

## Shape of the eventual answer (sketch, not design)

A streaming job kind (e.g. `llm.chat.stream`) with a delta channel —
likely the daemon holding its existing outbound connection and posting
incremental chunks against the job id, preserving: outbound-only (no
tunnel), `deadlineAt` semantics per-chunk or per-turn,
fixed-argv/stdin-only execution, and the audience rules unchanged
(subscription backends still hard-locked to `self`). Streaming must not
weaken any MUST. Whether process-class backends (claude CLI) can
stream at all vs only HTTP-class (ollama/openai-http) is an open
question the design must answer honestly — it may be an HTTP-class-only
capability at first.

## Why this is recorded here

Same relationship the framework has with its consumers: the payload
gains capabilities when a real consumer surfaces the requirement with
numbers, not on speculation. CD is that consumer; these are the
numbers.

## Done when (when designed + built)

A live CD persona turn streams through the daemon inside the voice
budget on at least one backend class, with all protocol MUSTs intact
and conformance extended to cover the streaming kind.
