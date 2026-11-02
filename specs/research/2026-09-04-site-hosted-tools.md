# Site-Hosted Tools

*Proposal · byollm · tool support*
*Kevin Samsoe · 4 September 2026 · for discussion*

> Kept here as the record behind byollm_012's "Beyond 012", B1 (decision
> #6755). It was written as a web page and shared and discussed with Todd on
> 09-04, and CW logged it in byollm-cloud `specs/icebox.md` the same day. It
> was converted to Markdown on 2026-11-02 with the text unchanged. The
> page's diagram is redrawn below as text.

Let a model running on somebody's laptop use a site's tools, without that
laptop ever running one.

## The gap

byollm carries a prompt and a system string. `JOB_KINDS` is `llm.generate`
and `llm.chat`, and byollm_004 §2 forbids a tool flag on a payload. A site
can ask a runner to think. It cannot ask it to look anything up.

Of Tomorrow Press hit this in the fact checker and had to write the
limitation into the code as a comment, because the workaround is invisible
at the call site otherwise:

> Verification has to look things up. The byollm protocol carries a prompt
> and a system string and nothing else — byollm_004 §2 forbids a tool flag
> on a payload — so there is no way to ask a runner to search, even one
> backed by a `claude-cli` that plainly could.
>
> — `apps/fact-checker/src/lib/model.ts`

The result is backwards. Extraction and triage — the cheap, tool-free half
of the pipeline — run on the author's own hardware. Verification, which
needs the web and costs the most, runs on the site's own Anthropic key,
because there is no way to ask for anything else.

**The work that most deserves to run on somebody's own machine is exactly
the work byollm cannot carry.**

## The obvious fix is the dangerous one

Add a `tools` array to the payload and let the runner execute them. It is
the shortest path from here, and it turns every participating machine into
one that runs programs and makes network calls chosen by a website.

The consent screen is where that fails hardest. byollm's whole model rests
on a person reading a screen and deciding. *"This site may run tools on your
machine"* is not a sentence anybody can evaluate — not because people are
careless, but because the sentence genuinely does not bound anything. The
tools can change after consent, and the risk is unbounded by construction.

## Turn the arrow around

Tools execute on the **site**, never on the runner. Mid-generation the model
emits a tool call; that call travels back down the same pipeline that
delivered the job; the site runs it against its own infrastructure and its
own credentials; the result returns and generation continues.

The runner runs a model and nothing else. The site sends a declaration of
what exists — names, arguments, descriptions — and never code.

```
TODAY
  The site ──prompt + system──▶ Relay ─────────▶ Their machine
  (tools live here)            (outbound only)   (model only)
     ┆
     └┄┄▶ tool work falls back to the site's own API
          — the site pays, on the site's hardware

PROPOSED
  The site ──prompt + tool declarations──▶ Relay ─────────▶ Their machine
  (tools run here)                        (carries both ways) (model only)
           ◀────────── tool call ─────────────────────────────┘
     ┆
     └┄┄▶ result returns, generation continues ┄┄▶ Their machine
```

The only thing that moves is where execution happens. Nothing new reaches
the runner: it receives a description of tools it may ask for, and asks.

## The round trip

Six steps, and only two of them are new protocol. The rest is the pipeline
that already exists.

1. **Site.** Declares its tools in the manifest it already registers,
   attached to a purpose. Names, arguments, one-line descriptions. No
   endpoints, no code.
2. **Site.** Enqueues a job as it does today. The tool declarations ride
   with the payload, sealed to the claiming device like everything else.
3. **Runner.** Generates. When the model calls a tool, the daemon does not
   execute it — it has no idea how — and returns it as a *pending call*
   rather than a result.
4. **Runner.** Sends the call back through the relay, sealed to the site,
   exactly as a finished result travels today.
5. **Site.** Executes it. Its search account, its rate limits, its cache,
   its audit log. It returns the output the same way it sent the job.
6. **Runner.** Resumes generation with the result in context, and loops
   until the model stops calling tools.

## Why the boundary belongs here

**The capability is already on the site.** A site with a search tool has
the API key, the quota, the cache and the compliance story for it. A laptop
has none of those. Asking the laptop to run the tool means provisioning all
of it onto every participating machine.

**The trust is already on the site.** A person has connected to that site
and mapped a purpose to a service. They already accepted that the site sends
them work. "It may also ask itself to search on your behalf" is strictly
less than what they have already agreed to.

**The risk is describable.** That is the part that matters most. *"This
purpose can search the web using the site's own search account"* is a
sentence a person can weigh. It bounds what happens, says who pays, and
stays true after consent.

## What it costs

**Adoption — more setup for sites.** A site must host and expose tools, not
just declare a purpose. This is the real cost of the design and most of it
is mitigable: tools attach to the manifest that already exists, and the
library ships a handler mounted the way `/byollm/*` already is. A site with
no tools declares none and nothing changes for it.

**Latency — a round trip per call.** Every tool call crosses the relay
twice. Fine for one lookup; a multi-step agentic loop pays it repeatedly.
Worth measuring before promising anything about interactive use.

**Economics — the site pays for tools.** Compute moves to the person; tool
spend stays with the site. That is the honest split — the site owns the
tool — but it changes the pitch, which today reads as though the site's
costs go to zero.

**Protocol — generation has to pause.** This is the hard part. A job is
currently one shot: sealed out, result back. A tool call makes it a
conversation with a suspended middle, on a lane where everything is
outbound and the site polls. The pump has to carry tool traffic promptly,
not hourly.

## Open questions

Raised rather than answered, because each is a decision for the protocol
rather than a detail of this proposal.

- **Is a tool result sealed?** byollm_009 §10 says nothing between the
  endpoints holds plaintext. A tool result is content, so presumably it
  obeys the same rule — which means the relay carries it opaquely and
  cannot cache, inspect or dedupe it.
- **Who caps the loop?** A model that calls search forty times spends the
  site's money on the site's account. A per-job tool budget probably belongs
  in the enqueue, enforced at the site, and visible on the consent screen as
  a number.
- **Does a tool need its own consent?** Purpose-level may be enough, since a
  purpose already describes what work happens. But a site that adds a tool
  to an existing purpose changes what a person agreed to, which sounds like
  a re-consent event.
- **What does a daemon do with a tool it was never told about?** Refuse and
  say so, presumably — the same shape as `purpose-not-declared` at enqueue,
  which is already the pattern for a manifest that has drifted from the
  code.
- **Direct lane too, or cloud only?** On the direct lane the site is
  reachable by the daemon, so the round trip is shorter and the design may
  simplify. Two implementations would be worse than one that is merely
  slower on the cloud lane.

---

*Written up from a call. The comparison to MCP is deliberate but inverted:
in MCP the client hosts the tool servers, and here the site does, with the
model as the consumer rather than the host.*
