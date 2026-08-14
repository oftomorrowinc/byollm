# byollm_012 — Tools (stub): why not, and the narrow maybe

**Status: stub, not scheduled. Asked twice now by real integrators —
most recently while porting a verification workload whose jobs need
web search. Recorded so the answer is a position, not a shrug.**

## The rule today, and why

Jobs are typed data, never code (`KIND_NO_CODE`); output is inert
(`OUTPUT_INERT`); the child gets a fixed argv, a stripped environment,
and no tools. A byollm job can waste compute or return garbage — it
cannot *act*. That property is the product.

A workload that needs tools (web search, retrieval, anything with
side effects) belongs on the app's own metered lane today. That is
not a gap; it is the billing-lane principle: tool-needing jobs sort
to the API the app pays for, tool-free jobs sort to byollm.

## Why agentic tools can never cross the shared plane

On `named` or `public`, the prompt is a stranger's. Tools turn "run a
stranger's text through a model" into "let a stranger's text drive
actions on your machine" — remote code execution as a service, with
extra steps. No MUST can contain it, because the dangerous artifact
is the *output the model was talked into*, not the input any schema
can validate. This is a permanent no, of the `SUBSCRIPTION_SELF_LOCK`
kind.

## Why even `self` is not obviously safe

The subtle half: on `self`, the *account* is yours but the prompts
are **site-authored** (or derived from data the site processed —
emails, documents, web pages). Today a malicious or compromised site
can waste your compute. Give the model tools and that same site can
act on your machine through them. "My own jobs" does not mean "my
own words," and prompt injection needs only the words.

## The narrow maybe: daemon-mediated, read-only, self-only

If tools ever land, the shape is not "the model gets tools" but
**"the daemon offers a short menu of functions it implements and
mediates itself"**:

- **Web search/fetch first** (the only tool real consumers have asked
  for): outbound GET to the public internet only — the SSRF policy
  from execution isolation, *inverted* (model endpoints allow
  loopback/LAN and refuse the cloud; a tool fetch refuses loopback,
  LAN, and metadata endpoints, and follows no redirects across that
  line). No cookies, no credentials, no headers the daemon didn't
  set. Response returned as data, size-capped.
- Typed, schema-validated parameters — a tool call is payload, held
  to the same standards as any payload.
- **Read-only forever**: no filesystem, no shell, no write-actions.
  The menu is fetch-shaped or it is not on the menu.
- Rate- and budget-capped per job and per site; **every URL in the
  ingress log** — the owner can read everything their machine was
  asked to look at.
- **Off by default, per-backend opt-in, and `self`-locked as a hard
  protocol MUST** (`TOOLS_SELF_ONLY`) — plus consent-screen
  disclosure, since a site gaining "can make my machine fetch URLs"
  is a scope a user must see.

Even this narrow shape ships only with its own adversarial corpus
(injection attempts that try to steer the fetch) and a bounded
worst case the docs can state honestly: a hostile prompt can waste
rate-capped public GETs and tokens, and nothing else.

## Done when (if ever scheduled)

The tool menu exists as typed job-kind extensions with the inverted
SSRF policy conformance-tested; `TOOLS_SELF_ONLY` is a MUST with a
check; the ingress log carries every tool invocation; and the
security docs state the bounded worst case in plain language.
