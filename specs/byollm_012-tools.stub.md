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
  for): outbound GET to the public internet only. No cookies, no
  credentials, no headers the daemon didn't set. Response returned as
  data, size-capped. The address policy is **not** the model-endpoint
  policy inverted — see below.
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

### The address policy, as a table

An earlier draft of this stub called the tool policy "the SSRF policy
from execution isolation, inverted." That was wrong, and wrong in the
one cell where wrong is catastrophic: `checkBaseUrl` **refuses**
cloud-metadata and link-local addresses, so an implementation that
inverted it would *allow* `169.254.169.254` — handing a
prompt-injected fetch a straight path to the machine's IAM
credentials.

The two policies are not mirror images. They share a floor and differ
on locality:

| destination                  | model endpoint (today) | tool fetch (proposed) |
| ---------------------------- | ---------------------- | --------------------- |
| loopback (`127.0.0.1`, `::1`)| **allow** — Ollama's default lives here | refuse |
| private LAN (`10/8`, `192.168/16`, …) | **allow** — a model server on the next desk | refuse |
| public internet              | **allow** — `api.openai.com` is a legitimate backend | allow |
| cloud-metadata, link-local   | **refuse**             | **refuse**            |
| non-http(s) scheme, credentials in URL, wildcard address | **refuse** | **refuse** |
| redirects                    | **refuse outright**    | **refuse outright**   |

No metaphor, and every cell is a fact a check can assert. When this is
built, that table is the conformance matrix directly — the way the
audience × offer-scope matrix became `C005`.

### Why they differ: trust the value as much as whoever set it

`checkBaseUrl` is permissive on purpose, and its docstring says why:

> the base URL comes from the machine owner's config and from nowhere
> else — no payload field can set it, redirect it, or append to it.
> There is therefore no attacker-controlled input channel into this
> value at all.

That is the whole justification, and it does not survive the move to
tools. **A tool fetch URL is model-produced** — derived from a prompt,
and on the shared plane that prompt is a stranger's; on `self` it is
still site-authored (see above). The value is adversary-influenced by
construction.

So this is not one policy pointed two ways. It is one rule —
*trust a value as much as you trust whoever set it* — evaluated
against two different setters, which happens to produce opposite
answers about locality and identical answers about everything else.

Three consequences follow from adversary-chosen URLs that the
owner-config case never had to face, and all three are load-bearing:

1. **DNS rebinding / TOCTOU.** Validating a hostname and then
   connecting is a gap when the attacker chooses the hostname: it can
   resolve public at check time and `127.0.0.1` at connect time.
   Resolve first and pin the address, or enforce at socket level.
   `checkBaseUrl` never needed this — a static owner-set value cannot
   change between check and use.
2. **Redirects stay refused outright, not "refused across the line."**
   Following redirects except across a boundary means re-validating
   every hop, which is exactly where SSRF filters classically fail.
   The HTTP backend already sets `redirect: "error"`; inherit that
   rather than loosen it.
3. **Address encodings.** Decimal and octal IP literals,
   IPv6-mapped IPv4, `0.0.0.0`, trailing-dot hostnames. An
   owner-config check can ignore these because an owner is not trying
   to smuggle anything past themselves.

### What this does to `OUTPUT_INERT`

Worth naming now rather than discovering it when someone reads the two
documents together. `OUTPUT_INERT` says model output is inert. A tool
call **is** model output that causes the daemon to act — mediated and
read-only, but an action.

So `OUTPUT_INERT` would need scoping rather than quiet contradiction:
output remains inert *with respect to the app and the host*, and tool
invocations are a separate typed channel the daemon parses, validates
and executes itself. The distinction that keeps it honest is that the
model never names an operation — it fills in parameters for one the
daemon already implements, from a menu the owner switched on.

If that scoping cannot be written in a sentence a reader believes,
that is a signal the tool menu is too wide.

Even this narrow shape ships only with its own adversarial corpus
(injection attempts that try to steer the fetch) and a bounded
worst case the docs can state honestly: a hostile prompt can waste
rate-capped public GETs and tokens, and nothing else.

## Done when (if ever scheduled)

The tool menu exists as typed job-kind extensions; the address table
above is a conformance matrix with a check per row; `TOOLS_SELF_ONLY`
is a MUST with a check; the ingress log carries every tool invocation
with its URL; and the security docs state the bounded worst case in
plain language.

Specifically, and none of these are optional:

- **Resolution is pinned**, so a hostname cannot resolve public at
  check time and loopback at connect time. Tested with a name that
  changes answer between calls.
- **Redirects are refused outright**, matching the HTTP backend's
  existing `redirect: "error"` rather than loosening it to
  "refused across the line."
- **Address encodings are normalised before checking** — decimal and
  octal literals, IPv6-mapped IPv4, `0.0.0.0`, trailing-dot hostnames
  — each with an adversarial-corpus row.
- **`OUTPUT_INERT` is explicitly scoped** in the same change, not left
  to be reconciled by a reader.

## A note on how this stub was corrected

The error fixed above — "the SSRF policy, inverted" — was written as a
description and would have been read as an algorithm. It is the
security-grade sibling of the rule this repo already had about naming
repos and packages rather than concepts: **in a spec, a metaphor is an
implementation instruction.** A table has no metaphor in it, which is
why the policy above is one.

It was caught because the author of the stub flagged the author of
`ssrf.ts` as the person who would see if the inversion was wrong, and
it was. Worth keeping as a working practice on any component where a
single-author mistake ships a credential-theft path.
