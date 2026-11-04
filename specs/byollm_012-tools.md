# byollm_012 — Tools: declared and run by the site, called by the model

**Status: v1, ruled. Written 2026-11-02 and rewritten 2026-11-03 by Kevin
Samsoe for decision #6933 (card #6758), under #6756's ruling as written out
at #54358. Todd ruled #6933 on 2026-11-03 (#55201), and this version is the
one commit that ruling names, with the six branch fixes CW's #55220 lists
(from Owl's red team passes #54911 and #54949). Nothing here is built, and
under rule 34 nothing in this repo changes until the cards that follow the
ruling are filed.**
**Replaces `byollm_012-tools.stub.md`. The stub's position stands, and v1
keeps it more strictly than the stub's own "narrow maybe" could: no tool
runs on the device at all. The stub's closing note is kept as written.**
**Read with: `specs/research/2026-09-04-site-hosted-tools.md` (the proposal
this specs), byollm_009 §6–§8, byollm_016 Amendments J and L, byollm_004 §2,
and byollm_021 (images, and the rollout for both specs).**

**What changed on 2026-11-03.** The first version made v1 the stub's "narrow
maybe": the daemon ran `web.search` and `web.fetch` itself, or the vendor's
CLI ran its own search. The author's position after review is that **only
site-executed tools are trustworthy enough for a first version.** The other
designs put an adversary-chosen action on the person's machine or inside a
vendor CLI with tools switched on, and each needs more consideration than a
first version can give it. §11 records them and why they are held. That
earlier design, with Owl's review applied, is commit 488cb02 on this
branch.

## What Todd is asked to rule

1. **v1 is site-executed tools (§2–§10), as one decision.** One new kind,
   `llm.tools`. The site declares its tools in its manifest against a
   purpose. The model on the person's device may call them. The device never
   runs a tool: each call is sealed to the site, the site runs it on its own
   infrastructure and account, and seals the result back. Off until an owner
   turns it on for a service.
2. **Teammates' devices may serve it** (§6). Nothing runs on the device, so
   the machine-safety argument for self-only does not apply. What remains is
   a risk to the site, which §6 states.
3. **`http`-class backends only in v1** (§7), as #6756 ruled (shape 2), with
   the CLI containment untouched and named. On `claude-cli` and `codex-cli`, calling
   a site's tool needs a bridge inside the vendor CLI with tools switched on.
   That is the same isolation question that holds back provider-native
   search, so it waits with it.
4. **Three designs held from v1** (§11): daemon-run tools (the stub's narrow
   maybe), provider-native search (CW, 09-04) and the self-scoped agent
   backend (B191). Each is held with its risks named, not refused.
5. **Whether 0.1.5 carries this.** byollm_021 §Rollout has the order, the
   coexistence story and what each repo needs.

---

## 0. Where this starts

Four sources, all of them on the record:

- **The stub** (CW, 2026-08-14, fa0e114). Tools never cross the shared
  plane. Even on `self` they are not obviously safe. The narrow maybe is a
  short menu the daemon runs itself: read-only, self-only, with an address
  table instead of a metaphor.
- **Kevin's 09-04 proposal**, "Site-Hosted Tools", now in
  `specs/research/2026-09-04-site-hosted-tools.md`. Tools are declared and
  run by the site. The call travels back to the site in the middle of a
  generation, and the runner stays a model and nothing else.
- **CW's smaller v1** (byollm-cloud `specs/icebox.md`, 09-04, ab9d55b). For
  search in particular, the backends ship their own search, so it can run
  inside the model call on the person's own subscription.
- **B191** (Todd, 09-11). Claude with tools on, bound to a directory, for
  Todd's own projects. A fourth backend class.

And one integrator, whose code states the acceptance test. Press's
`llmSearch` (`packages/byollm/src/index.ts`) always spends Press's own key
for the fact checker's verification step, and its docstring says: *"If
byollm later gains a kind that carries a tool grant, this becomes a thin
wrapper over `llm` and every caller stays as written."* v1 is done for Press
when that sentence comes true (§10).

### How the four compare on trust

| | site-executed (Kevin) | daemon-run (the stub) | provider-native search (CW) | self-scoped agent (B191) |
|---|---|---|---|---|
| what runs on the person's device | the model, and nothing else | network requests chosen by the model | a vendor CLI with a tool switched on | a vendor CLI with every tool on, in a real directory |
| who chooses the action | the model, from a list the site declared and the person saw | the model, from a fixed menu | the model and the vendor | the model |
| where the action happens | on the site's servers, on the site's account | from the person's IP, into a network the person shares | at the vendor, on the person's subscription | on the person's files |
| what the device can verify | every call and every result, since both cross it | every call it runs; DNS and address rules are a hard, growing list | only what the vendor's stream reports | needs a log of what it *did* |
| what the isolation rests on | byollm's own envelopes and schemas | a deny-list over IANA's registries, kept current | the vendor CLI's flags, across its versions | per-platform confinement, not yet designed |
| who pays for the tool | the site | the person (search key, bandwidth) | the person (subscription) | the person |
| wire change | a kind, a suspended job, four endpoints | a kind | a kind | none |
| in this spec | **v1** | held, §11.1 | held, §11.2 | held, §11.3 |

The rows that decide it are the first and fifth. Site-executed tools are the
only design where nothing new happens on the person's machine, and the only
one whose isolation rests entirely on things byollm already builds and
tests.

## 1. The first consumer, its plane, and the position

**The first consumer is Press's fact checker**, its verification step: the
`fact-checker` purpose in `@oftomorrow/byollm`'s `PURPOSES`, which today
calls `llmSearch` on Press's own key. **Its plane is `team`.** Press routes
jobs to teammates' devices (#5738, #5726). #6756's ruling (shape 3) says a
consumer on that plane is the 09-04 site-executed design, a separate design
from the daemon menu. This spec is that design. The daemon menu is held in
§11.1, and nothing of it is in v1.

### The position, unchanged, and kept more strictly

**Jobs are typed data, never code** (`KIND_NO_CODE`). **Output is inert**
(`OUTPUT_INERT`). The child gets a fixed argv, a stripped environment and no
tools. A byollm job can waste compute or return garbage. It cannot *act* on
the device, and that property is the product.

v1 keeps all of it **without amending `OUTPUT_INERT`**. A tool call is
output: text the model produced in a typed shape. The daemon does not act on
it. It seals it, as it seals a result, to the one party that may act on it,
the site that declared the tool. The stub's worry was that tools turn
"somebody else's text through a model" into "somebody else's text driving
actions on your machine". Under v1 there are no actions on your machine. The
actions are the site's, on the site's machine, which is where they would
happen anyway if the site ran its own model.

**What v1 does move.** The tool runs at the site, so a hostile model, or a
hostile device, is now one more caller of the site's tools. That is a risk
to the site, not to the person, and §6 says how a site carries it.

## 2. v1 in one paragraph

A site declares tools in its manifest, under a purpose that lists
**`llm.tools`**: for each one a name, a one-line description and the shape of
its arguments. The person sees those tools on the consent screen and maps the
slot to one of their services that has tools turned on. The site enqueues an
`llm.tools` job whose sealed payload carries the conversation and the
declarations. A device claims it. The control plane's grant carries a digest
of the tools the person consented to, and the device refuses a payload whose
declarations do not match it. The device runs the model with the
declarations. When the model calls a tool, the daemon checks the call
against its declaration, logs it, seals it to the site and sends it through
the upstream. The site's pump collects it, runs it, and seals the result
back. The daemon hands the result to the model, and generation continues
until the model answers or the job's tool budget runs out. The result comes
back sealed, as today.

## 3. The kind: `llm.tools`

**Why a kind and not a flag.** byollm_004 §2: *"If a future kind needs tools,
that is a new kind with its own spec and its own threat review — not a
payload flag."* A kind is also what routing can act on. A device that cannot
run a tool loop never advertises `llm.tools`, so it is never offered one
(`CLAIM_REQUIRES_CAPABILITY`). `kind` is already in the stub, so
`STUB_METADATA_EXHAUSTIVE` is untouched.

**The payload** is `llm.chat`'s, plus two fields:

```
{ messages, system?,                 // as llm.chat, same PAYLOAD_LIMITS
  tools: ToolDeclaration[],          // 1..16, exactly the purpose's tools
  maxToolCalls?: 1..20,              // at most the purpose's budget (§4),
                                     // which is also its default; the
                                     // owner can only lower it
  purposeLimits: {                   // the purpose's two limits, as
    maxToolCalls,                    // registered; inside the digest (§4)
    maxToolResultChars } }

ToolDeclaration = {
  name,          // /^[a-z][a-z0-9_]{0,63}$/
  description,   // 1..1024 characters, the renderable rules of a manifest label
  parameters     // a JSON Schema subset, below
}
```

`parameters` is an object schema with at most 16 properties, each a
`string` (with `maxLength` ≤ 4096 and an optional `enum`), `integer`,
`number`, `boolean`, or an `array` of one of those with `maxItems` ≤ 32.
No nesting beyond that, no `$ref`, no `additionalProperties: true`. One
declaration serialises to at most 8 KiB. The subset is small on purpose: the
daemon validates every call against it strictly, so it is a schema the
daemon can check completely, not one it has to trust.

**What the site still cannot do.** It cannot hand the model a forged tool
result in the payload. `ChatMessage.role` is a closed enum with no `tool`,
and the object is `.strict()`, so a payload carrying `tool_calls` or a
`tool` turn is refused at parse time. Tool turns exist only inside the
daemon's loop, and every one of them arrived as a sealed, signed envelope
for a call the daemon itself sent (§5).

**The result.** `outcome: "ok"` and `text` as today. `RunMetadata` gains,
on `llm.tools` results only:

- `toolCalls`, the number of calls the job made, which is what the budget
  counts;
- `toolOutcomes: { answered, errored, timedOut, refused }`, how those calls
  ended: answered by the site, answered with the site's error, timed out
  waiting (§5.3), or refused by the daemon before sending (§12, C036). A
  site can then tell "answered from search" from "every call timed out",
  which `toolCalls` alone cannot (Owl, #54911 part 2 point 4).

`StopReason` gains `tool-budget`, for a job that reached its call budget or
its context cap (§8). All of it is sealed, like the rest of the result.

**The label.** `llm.tools` renders as **"Using the site's tools"** on every
user surface, with the site's name in place of "the site" where the surface
has it. It joins "Chat" and "Generation" in the one kind-label table
(byollm_016, "Consent-screen copy: approved").

## 4. Declared in the manifest, matched at the device

**The manifest.** A `Purpose` gains three fields, required when its `kinds`
include `llm.tools` and refused otherwise:

- `tools`, a record from tool name to `{ description, parameters }`, 1 to 16
  entries. The descriptions follow the manifest's renderable rules, since
  the consent screen shows them;
- `maxToolCalls`, the purpose's call budget, 1 to 20, default 8. It is the
  number the consent screen states (§10);
- `maxToolResultChars`, how much tool-result text one job may read, 1 to
  256,000, default 32,000. It is what makes the context cap (§8) part of
  the job's size before the job runs.

**The grant carries the digest.** Amendment J's grant gains `toolsDigest`:
SHA-256 over the RFC 8785 (JCS) canonical form of `{ tools, maxToolCalls,
maxToolResultChars }` for the purpose, as the person consented to it. The
limits are inside the digest so that the numbers a person was shown bind
(Owl, #54911 part 2 point 2): without them, a site could send
`maxToolCalls: 20` to a person who was shown 8. It is present on grants for
`llm.tools` jobs and absent on every other grant. That matters for
coexistence, because a 0.1.4 daemon parses grants strictly and must never
meet the key. It never claims `llm.tools`, so it never gets such a grant
(byollm_021 §R2). The field is signed like every other grant field
(`GRANT_SIGNED_FIELDS` is derived from the schema).

**The device compares.** The payload carries the purpose's limits it was
built against (`purposeLimits`, beside `tools`). At admission, after the
grant's own checks and before the backend sees anything, the daemon
canonicalises `{ tools, ...purposeLimits }` from the payload (tools as a
record keyed by name) and compares its digest with the grant's. A mismatch
is refused (`tools-not-consented`). So is a payload whose `maxToolCalls` is
above `purposeLimits.maxToolCalls`. Either way the payload never reaches a
backend. So a site cannot add a tool, or raise the budget,
past what the person saw, and a relay cannot either, since the payload is
signed by the site and the grant by the control plane.

**The site's code and the manifest of record cannot drift silently.** The
payload's declarations come from the site's code (Press's `PURPOSES`). The
digest comes from the manifest of record, which Todd registers by hand. If
the two differ by one character, every device would refuse every job after
claiming it, and the site would see only no-runner (Owl, #54911 part 2 point
3). So the site SDK computes the same digest over what it is about to send
and puts it in the **enqueue request** (`toolsDigest` beside the stub, not in
it, so `STUB_METADATA_EXHAUSTIVE` is untouched and a device never sees it).
The hub compares it with the digest of the manifest of record and refuses a
mismatch at enqueue, with nothing queued: `tools-manifest-mismatch`, "the
tools <site> declares in code for <purpose> differ from its registered
manifest — register the manifest, or fix the declaration". The digest is
of public consent text, not job content, so `RELAY_BLIND` is untouched. The
key is sent only for `llm.tools`, which a 0.1.4 hub refuses anyway.

**A changed tool list is a changed consent.** When a manifest's tools for a
purpose change, the digest changes, and the person's mapping for that
(purpose, `llm.tools`) slot is suspended until they confirm the new list.
That is Amendment L's rule for a new slot, applied to a slot whose contents
changed: nothing widens quietly. The site learns `slot-unsatisfiable` until
the person acts, not `slot-waiting`, because waiting alone will not fix it:
somebody has to look at the new list. This answers the 09-04 proposal's open question "does a tool
need its own consent?": the tool list is part of the purpose's consent, and
changing it asks again.

**The direct lane has no control plane** and is kind-only (byollm_009 §6).
There, the person consents to the site when they pair, and the owner turns
`llm.tools` on per service. There is no grant to carry a digest, so the
device checks the payload's declarations against the schema rules above,
and `maxToolCalls` against the protocol ceiling and the owner's cap, and no
more. Drift cannot happen there either: the declarations and the server are
the same deployment. That is weaker, and acceptable for this reason: on the direct
lane the site *is* the upstream the person paired with, and nothing the
declarations say can make anything run on the device.

## 5. The suspended job

This is the hard part the 09-04 proposal named: a one-shot job becomes a
conversation with a suspended middle, on a lane where everything is outbound
and polled.

### 5.1 The envelopes

Two new directions join `payload` and `result` inside the envelope signature
(byollm_009 §6): **`tool-call`** (device to site) and **`tool-result`** (site
to device). Each is signed with the sender's identity key and sealed to the
recipient's encryption key, exactly like a payload or a result. Because the
direction is inside the signature, a tool result can never be replayed as a
payload, and a call can never be passed off as a result.

```
ToolCall   = { callId, seq, name, arguments }          // sealed device → site
ToolResult = { callId, seq, ok: true,  content }       // sealed site → device
           | { callId, seq, ok: false, error }
```

- `callId` is chosen by the daemon, random, single-use, and recorded with
  the job. `seq` counts calls in the job from 1.
- The daemon accepts a `ToolResult` only if it opens, verifies against the
  site's pinned identity key, carries the `tool-result` direction, and
  names an outstanding `callId` of *this* job with its `seq`. Anything else
  is dropped and logged, and the model never sees it.
- `content` is text, at most 256 KiB. `error` is at most 1 KiB. A call's
  `arguments` serialise to at most 64 KiB. All three are measured on the
  plaintext. Sealed sizes stay well inside `MAX_ENVELOPE_BYTES`.
- Every call is sealed separately with an ordinary envelope. When streaming
  lands (byollm_006, and byollm_009 §8's per-job key), tool traffic may move
  onto that channel. v1 does not wait for it, because a sign and a seal per
  call is cheap and already built.

### 5.2 The endpoints

Four, all outbound and polled, like everything else in this product.

| plane | endpoint | who calls it | what it carries |
|---|---|---|---|
| daemon | `tool-call` | the daemon holding the job's lease | one sealed `tool-call` envelope, with `jobId`, `leaseId`, `callId` |
| daemon | `tool-results` | the daemon, while any job of its waits | the sealed `tool-result` envelopes for its held jobs |
| site | `calls` | the site's pump | the sealed `tool-call` envelopes for its jobs |
| site | `tool-result` | the site's pump | one sealed `tool-result` envelope, with `jobId`, `callId` |

The relay checks only what it can check without opening anything: the
caller's signature, that the lease is live and held by the caller, that the
job is the site's, that the `callId` is outstanding, and the per-job count
(§8). It sees the number, timing and size of tool calls, as it already sees
the size and timing of payloads and results. `RELAY_BLIND` holds: it never
opens one.

**The direct lane uses the same four endpoints** on the site's own handlers.
The site is the upstream there, so `@byollm/server` can run the site's tool
handler as soon as the call arrives, and the result is waiting for the
daemon's next poll. One shape on both lanes, faster on one. The 09-04
proposal asked for exactly that: two implementations would be worse than
one that is merely slower on the cloud lane.

### 5.3 The state, the lease and the clock

A job waiting on a tool result is still `running`. It holds its lease, and
the heartbeat renews the lease as it does for any held job. The relay
records the wait as a sub-state, `waiting-on-site`, so that
`NO_RUNNER_SIGNAL` can tell "running" from "the site has not answered".
The 2026-09-17 lease lapse (jobs over a minute died because a relayed lease
was never renewed) is the failure this invites first, and check C041 is
written against it.

- **`TOOL_CALL_TIMEOUT`** is 60 seconds per call. If no result arrives in
  time, the daemon gives the model a tool error ("<site> did not answer in
  time") and generation continues. The call still counts toward the budget.
- **The job's `deadlineAt` bounds the whole loop**, as it bounds any job.
  A site that stops answering costs the device at most its timeout per call
  and never more than the deadline.
- **The daemon polls `tool-results` about once a second**, and only while
  one of its jobs is waiting. An idle daemon makes no extra requests.
- **The site answers at its pump's cadence.** Press turns its pump every 1.5
  seconds while a request waits (`PUMP_INTERVAL_MS`), so on the cloud lane a
  call costs roughly 2 to 4 seconds before the tool itself runs. A job with
  eight calls spends perhaps half a minute waiting on the round trips. That
  suits verification and research. It does not suit interactive chat, and
  the docs say so. The build card measures it.
- **A site whose pump stops** (a serverless request that timed out, a
  deploy) leaves its calls unanswered. They time out one by one, the model
  answers with what it has, and the job ends normally or with
  `tool-budget`. The result waits to be collected like any other, and its
  `toolOutcomes` say how many calls timed out (§3), so the site never
  mistakes it for an answer from search.
- **So a site must keep its pump turning for as long as its tool jobs run,
  not only while one request waits.** A serverless route has a platform
  ceiling (Press's fact-checker routes are already at the 300-second
  maximum), so a pump tied to the waiting request dies with it mid-job (Owl,
  #54911 part 2 point 4). The site SDK therefore gives the site two pieces:
  the pump cycle it has today, and `toolJobsInFlight()`, which says whether
  any of the site's tool jobs is still running. A site runs the cycle from
  its waiting request *and* from a scheduled job that keeps cycling while
  `toolJobsInFlight()` is true. A site that cannot schedule work runs one
  tool job per request and sizes `maxToolCalls` to fit its route's ceiling.
  byollm_021 §Rollout R3 says which of these Press does.

## 6. Who may run it: teammates included

**Self-only is not needed for the device's safety.** The stub required it
because a tool on the device would let somebody else's text drive actions on
the owner's machine. v1 has no tool on the device. A teammate's `llm.tools`
job costs the owner's device what a teammate's `llm.chat` job costs it: model
time, bounded by budgets, plus up to `maxToolCalls` more turns of it. So
`llm.tools` follows the service's offer like any other kind, `private` or
`team`.

**What the device owner is told.** The daemon's first-job line for a site
gains "with its tools" for `llm.tools`. The owner's offer settings say, for a
`team` service with tools on: "Teammates' jobs may use the site's tools. The
tools run on the site's servers, not on this device. What they return is
read by your model, on this device."

**The risk this moves to the site, stated plainly.** Once a model can call a
site's tool, every argument is chosen by a party the site does not control:
a model that a page or a prompt has talked into something, or, on a
teammate's device, a device owner who modified their daemon. The calls are
signed by a real device under a real grant, so the site knows *who* called.
It cannot know the arguments were the model's honest choice. So:

- **A site treats a tool call as untrusted input,** and authorises it no
  wider than the job, never as itself.
- **On any purpose a teammate can serve, a tool is scoped to the job, not
  to the user** (Owl, #54911 part 2 point 5). The test: a tool may return
  only what the site would have been willing to put in that job's payload.
  Authorising as the job's user is not enough there, because the caller may
  be a teammate's modified daemon, and the user's authority reaches further
  than the job does. A tool that reads "the user's manuscript" reads the
  manuscript this job is about, not any manuscript the user can open. A
  tool that would act for somebody else is not a tool to declare at all.
  The site guide (byollm_021 R5) says this with an example, and Press's
  first tool, `web_search`, reads nothing of the user's.
- **The site SDK runs each handler with the job's id, `user` and `purpose`**,
  so a handler can scope to the job, and refuses calls past the job's budget
  (§8), so a modified daemon cannot buy more calls than the job allowed.
- **The docs recommend read-only tools for a first integration.** Nothing
  in the protocol requires it. What a site's tools do on the site's side is
  the site's business, as it is when the site runs its own model, but the
  docs say what a write-capable tool means when the caller is a model.

## 7. Backends

**Backends of class `http` run the loop in the daemon.** That is every local
server (Ollama, LM Studio, llama.cpp and the rest), `openai-http`, and the
hosted APIs on the person's own key. The daemon's HTTP client gains function
calling for each wire format it already speaks, and sends the conversation
with the declarations as functions. When the model answers with tool calls, the daemon handles each
in order (§5), appends the results as tool turns, and asks again. Parallel
calls in one turn are allowed, and each one counts. The model never touches
a tool runtime. The daemon owns the loop, the budget and the log.

Capability is detected, not declared (`CAPABILITY_IS_DETECTED`,
byollm_013). The probe offers one function, `echo_number`, and asks for 7.
A service advertises `llm.tools` only if the model calls `echo_number` with
`7` and then uses the result in its answer. An owner turning tools on for a
model that cannot call functions sees why in `byollm backends`.

**The `process` backends, `claude-cli` and `codex-cli`, do not serve
`llm.tools` in v1.** To reach a
site's tool, the vendor CLI would have to call out mid-generation, which
means an MCP server the daemon supplies (a stdio bridge that forwards calls
to the daemon) and the CLI's tool machinery switched on with every built-in
tool switched off. Whether that holds rests on the vendor's flags
(`--tools`, `--allowedTools`, `--strict-mcp-config`) behaving the same in
every CLI version. That is the same question that holds back
provider-native search (§11.2). The bridge is the first thing to spec once
the corpus can show, per CLI version, that no built-in tool runs under it.
Until then, a person whose only service is a subscription CLI sees "nothing
of yours can use the site's tools yet", with the fix named (byollm_013's
rule: a refusal names its fix).

## 8. Budgets

| what | protocol ceiling | default | who enforces it |
|---|---|---|---|
| tool calls in one job | 20 | the purpose's `maxToolCalls` (in the digest, §4); a payload may ask for fewer | the daemon, the relay (cloud lane), and the site SDK |
| the owner's cap per job | ≤ the ceiling | none | the daemon: the lower of the owner's cap and the payload's number wins |
| one call's arguments | 64 KiB | — | the daemon before sealing; the site SDK after opening |
| one result's content | 256 KiB | — | the site SDK before sealing; the daemon after opening |
| tool-result text the model reads, summed over the job (the context cap) | 256,000 characters | the purpose's `maxToolResultChars` (32,000 if unset), counted in the job's size class | the site SDK when it sizes the job; the daemon before handing each result to the model |
| waiting on one call | `TOOL_CALL_TIMEOUT`, 60 s | — | the daemon |
| the whole loop | the job's `deadlineAt` | — | as today |

**Three counters, on purpose.** The daemon's counter keeps an honest device
honest. The relay's counter keeps a modified daemon from spending more of the
site's tools than the job allowed. The site SDK's counter covers the direct
lane, where there is no relay, and a relay that is wrong. Each one has its
own check (§12).

**The context cap** (Owl, #54911 part 2 point 1; CW's finding 2 on the old
fetch design). The owner bounds what their device takes from other people
with the size class and `community.maxPayloadChars`, and admission measures
the opened payload (`payloadTextLength`). Tool results arrive *after*
admission. Twenty results of 256 KiB would put about 5 MiB of site-chosen
text into the model's context, re-sent on every later turn, on the owner's
key if the service is hosted, and no limit of the owner's would see it. A
site can do that without being hostile: one `get_chapter` tool returns a
whole chapter. So the result text a job may read is counted **before the
job runs**, in the measure the owner already set:

- For `llm.tools`, `payloadTextLength` is the payload's own characters
  **plus `purposeLimits.maxToolResultChars`**. The site computes the stub's
  `sizeClass` from that, so a job that may read 32,000 characters of results
  is classed by its whole possible context, not by its prompt alone.
- Admission then works as it does for any job: a teammate's device whose
  `community.maxPayloadChars` is below the job's total refuses it, at the
  stub when the class's floor already exceeds the limit (#5743).
- While the job runs, the daemon keeps the result total and holds it to
  `maxToolResultChars`. A result that would take it past is not handed to
  the model. The daemon logs it, counts it as `refused` in `toolOutcomes`,
  and moves to the closing turn below.

So the owner's limits see everything the model will read, and a site that
wants a `get_chapter` tool declares a large `maxToolResultChars`, which puts
its jobs in a larger class that each owner can accept or refuse. Fetching results by reference later (021's
blobs) would change how the bytes travel, not what the model reads, so it
does not replace this cap.

**At the limit, the job finishes and does not fail.** When a job reaches its
call budget or its context cap, the daemon asks the model once more *with no
tools offered*: "Answer from what you have." The result comes back `ok` with
`stop: "tool-budget"`, so the site can tell a short answer from a complete
one.

**Spend.** A tool job costs the person up to `maxToolCalls + 1` model turns,
each with the conversation so far. The daemon's existing daily budgets count
every turn, not every job, for `llm.tools`. Tool spend itself is the site's,
which is the economics the 09-04 proposal named: compute moves to the
person, tool spend stays with the site.

## 9. Logging

`INGRESS_LOGGED_BEFORE_EXECUTION` grows a clause: **every tool call is
written to the ingress log before it is sealed and sent.** One line per
call: job id, site, tool name, and the arguments. When the result arrives,
or the call times out, a second line records the outcome, the size and a
hash of the content.

- **Arguments follow the job's prompt retention.** For the owner's own jobs
  they are kept as prompts are. For a teammate's job they follow
  `communityPromptDays`, the rule byollm_004 Rev 1 already applies to a
  teammate's prompt, because an argument is the model's rendering of that
  prompt.
- **Result content is not logged**, only its hash and size. The owner can
  turn on keeping content for their own jobs.
- `byollm log` shows tool calls nested under their job. An owner can read
  every request their model made of any site.

The site logs the same calls on its side, with the device's key id, which is
what lets a site answer "who called this, under which grant".

## 10. What the consent screen says

The `llm.tools` row of a purpose lists the tools by description, from the
manifest:

> **Using Of Tomorrow Press's tools**
> Search the web for a claim · Look up a book in the catalogue
> Up to 8 uses each time. The tools run on Of Tomorrow Press's servers,
> never on your device. What they return is read by your model.

When the person maps the slot to a teammate's service, the last sentence
names whose model it is (Owl, #54911 part 2 point 5): "What they return is
read by Dane's model, on Dane's device."

The number is the purpose's `maxToolCalls`, which the digest binds (§4), or
the owner's cap if it is lower. When the tool list or the number changes, the
row says "Of Tomorrow Press changed these tools" and waits for the person
(§4).

**Press, concretely.** The fact checker's verification step becomes an
`llm.tools` job with one tool, `web_search`, which Press declares and runs
on its own search key. `llmSearch` becomes a thin wrapper over `llm` with
`llm.tools`, as its docstring promised, and every caller stays as written.
Press pays for the searches and the person's model does the reading and
judging, which is the split the proposal argued for.

## 11. Held from v1, with their risks

Each of these is held, not refused. Each would need its own spec and its own
threat review before it reaches a release.

### 11.1 Daemon-run tools (the stub's narrow maybe)

**What it is.** The daemon implements `web.search` and `web.fetch` itself
and runs them for the model. The full design is commit 488cb02 on this
branch: a closed menu, self-only in four places, an address allow-list over
IANA's registries with nineteen checks, the provenance rule, and a fixed
check order so that a refused URL is never looked up.

**The risks that hold it.**

- **The person's machine makes requests an adversary chose.** Every fetch
  leaves from the person's IP, inside whatever network the machine sits on:
  a home LAN, a tailnet, an office. The address policy is the only thing
  between a prompt-injected model and the router admin page, the NAS or the
  cloud metadata endpoint.
- **The address policy is a list that has to be right forever.** Owl's
  first read found six missing blocks and a DNS exfiltration path in a
  design that had already been through two drafts. IANA adds blocks. Every
  new encoding, tunnel prefix or resolver behaviour is another row. That is
  the shape of filter that fails eventually.
- **Content leaves through side channels.** A lookup's name, a search query
  and a URL's query string each carry job content to a third party. The
  provenance rule narrows this and does not close it.
- **The person answers for traffic they did not choose.** Requests from a
  residential IP are attributed to the person: scraping, rate-limit bans,
  or worse, fetched at a hostile page's suggestion.

### 11.2 Provider-native search (CW, 09-04)

**What it is.** The vendor's own search, run inside the model call: Claude
Code's WebSearch on the person's subscription. (Ollama's web search is a
REST API the client calls, so it belongs to 11.1, not here.)

**The risks that hold it.**

- **The isolation becomes the vendor's flags.** Today's subscription
  backends run with no tools, and the corpus pins that argv. Switching one
  tool on means trusting `--tools`, `--allowedTools` and `--strict-mcp-config`
  to keep every other tool off in every CLI version a person might have
  installed. Those flags are the vendor's to change.
- **The device cannot see what happened.** It can log only what the
  vendor's stream reports. What the vendor fetched, and how many queries one
  call ran, are the vendor's. Owl's review showed that even the budget
  cannot be stated exactly.
- **Job content goes to the vendor's search** on the person's account, for
  a site's work, under the vendor's terms for a personal subscription.

### 11.3 The self-scoped agent backend (B191, Todd, 09-11)

**What it is.** A fourth backend class: `claude` with tools on and a real
working directory, so Todd can point services at projects on one machine.
The consent model carries most of the weight already: a grant names a
service exactly, and `runner.ts` refuses an unmatched service.

**The risks that hold it.** It is a write-capable agent on the owner's files.
It needs per-platform confinement to the directory, budgets for a run with
no natural output cap, a log of what it *did*, and a rule that no site can
map a purpose to it unless the site is the owner's own. None of that exists.
It is an owner feature under its own name, not a tool menu, and it shares
nothing with v1 except the word.

## 12. MUSTs and their checks

Registered by card 1 of byollm_021 §Rollout R8 (#7053). This section first
wrote the MUSTs in bold rather than as table rows, because
`musts-match-specs.test.ts` counts any table row that starts with a
backticked id as a declared MUST and fails while the registry lacks it. The
registry entries and this table landed in one commit.

**Each is `pending`.** It is adjudicated and nothing verifies it yet, because
the checks that will are built by cards 2 to 4. A `pending` MUST names the
checks assigned to it and the kinds they will verify it as (`Must.planned`).
The card that builds a check promotes its MUST to that kind and edits the
"Verified" cell below in the same commit: a kit check that claims a
`pending` MUST fails `miscoveredMusts`, and so does a daemon test that cites
one. `scripts/pending-musts-hold-the-cut.mjs`, run by `tag.sh`, refuses any
release while one of byollm_021's MUSTs is `pending` and a stable release
while any is: these four may ride on the beta, as the cut line allows, and
the card that applies the cut line takes them out with `llm.tools` (Owl,
#55886).

| MUST | Statement | Verified | Checks, and the kind they verify it as |
|---|---|---|---|
| `TOOLS_RUN_AT_SITE` | A daemon never executes a tool. A tool call leaves the device only as an envelope signed by the device and sealed to the job's site. Daemon. | conformance + adversarial | C033, C034: the kit (#7116) and the daemon's suites (card 3, #7055) |
| `TOOLS_MATCH_CONSENT` | On the cloud lane, an `llm.tools` payload whose declarations or limits do not match the grant's `toolsDigest`, or whose `maxToolCalls` is above the purpose's, is refused before any backend sees it. An enqueue whose `toolsDigest` does not match the manifest of record is refused at the hub with nothing queued. A call to an undeclared tool, or with arguments that fail its schema, is a tool error to the model, and nothing is sent. Daemon and hub. | conformance + adversarial | C035, C036: the kit (#7116) and the daemon's suites (card 3, #7055); C035's grant-digest cases, the daemon's suites only; C047: conformance, planned |
| `TOOL_ENVELOPES_BOUND` | `tool-call` and `tool-result` are directions inside the signature, and a result is accepted only for an outstanding call of the same job. Daemon. | conformance + adversarial | C037: the kit (#7116) and the daemon's suites (card 3, #7055) |
| `TOOLS_BUDGETED` | §8's per-job call ceiling, enforced before the call that would exceed it, by the daemon, the relay and the site SDK; and the context cap, counted in the job's size class before it runs and enforced by the daemon before each result reaches the model. | conformance + adversarial | C038, C041, C046: the kit (#7116) and the daemon's suites (card 3, #7055); C039, C040: conformance, planned |

**Card 3 (#7055) built the daemon's half as the daemon's own suites, not
as kit checks.** This section planned them as `conformance`, and the kit could
not carry them then: its target had no tool endpoints (card 2, #7054) and
`ConformanceTarget` gave the kit no way to open a call sealed to the site or
to post a result as it. So C033–C038, C041, C042, C043 and C046 drove the
shipped daemon (`packages/daemon/src/tools-at-the-site.test.ts`) against an
upstream that played the site with the site's own keys, and the MUSTs they
verify were `adversarial`.

**#7116 lifted them into the kit.** `ConformanceTarget.site` gives the kit
the lane's own two site-plane endpoints (`calls`, `tool-result`) and the
site's keys; the kit opens each call verifying it against the device key it
paired itself, and answers through the target. The daemon's `llm.tools`
service is the shipped `openai-http` adapter, its model answered in-process,
so no socket is opened and nothing is started for a tool. The ten checks keep
#7055's assertions and run against any target; the MUSTs are `conformance`
and `adversarial` both, and the daemon's suites stay. Two limits, stated:
C035's three grant-digest cases need the cloud lane's grant, which a direct
target does not route, so they stay the daemon suite's alone; and the kit
cannot prove from outside that a cloud-lane relay keeps no copy of the
site's keys — on the direct lane the server is the site and holds them by
right. The checks the relay, the site SDK and the hub owe (C039, C040, C047)
stay `planned` on their MUSTs, and the cut gate refuses a stable release
while any tool MUST has a planned check.

The first run of the kit's C033 found that `@byollm/server` parsed every
sealed result as a text kind's, so it refused every `llm.tools` result on
both lanes; it now parses by the job's kind (`sealed-outcome.ts`).

Beside the table, and not rows of it:

- **`INGRESS_LOGGED_BEFORE_EXECUTION`**, amended: each tool call is logged
  before it is sent. Its row is byollm_001's, since a MUST has one home. The
  registry's statement gains the clause, its source names §9, and C042 holds
  it in the daemon's suites. Daemon; conformance (check 10, the prompt
  clause) + adversarial (C042, the tool-call clause).
- **byollm_004 §2's "No prompt-driven tools"** becomes: "The daemon exposes
  no tools, functions, retrieval or MCP to the model, **except the
  declarations of a site's own tools on an `llm.tools` job, which the daemon
  never executes: a call is sealed to the site.** Any tool that would run on
  the device is a new kind with its own spec and its own threat review, not
  a payload flag." `OUTPUT_INERT` is unchanged (§1).
- **byollm_016's "Kept out, deliberately" (line 206) is amended in words**
  (Owl, #54911 part 2 point 6). It keeps out "payload-influenced request
  fields, ever", and on `llm.tools` the payload's declarations become the
  function declarations in the backend request, and `maxToolCalls` shapes
  the loop. The amended line reads: "payload-influenced request fields,
  ever — **except a site's tool declarations and call budget on an
  `llm.tools` job (byollm_012), which on the cloud lane are bound by the
  grant's `toolsDigest` to what the person consented to, and on the direct
  lane are the paired site's own; they never name a model, a parameter of
  the model or anything that runs on the device**." The amendment is
  deliberate, not argued away: the declarations are site-chosen request
  content, and the consent binding is why they are acceptable, not a reason
  to pretend they are something else.

The check ids are assigned: byollm_012's are C033 to C047, as proposed, and
byollm_021's follow from C048 (byollm_021 §10).

| # | id | what it does | passes when | mutation that must fail it |
|---|---|---|---|---|
| 1 | C033 a tool call leaves sealed | an echo backend calls `lookup` once | the kit's upstream receives one `tool-call` envelope; it opens only with the site's key, verifies against the device's identity key, and carries the `tool-call` direction | send the call in the clear |
| 2 | C034 nothing runs on the device | a hostile site declares `shell`, `read_file` and `fetch`; an echo backend calls each with plausible arguments | the injected process spawner and socket factory record no spawn and no connection except to the upstream; three sealed calls reach the site | a daemon helper that runs a declared tool locally |
| 3 | C035 tools match consent | a payload that adds one tool to the purpose's set; one that changes a description; one whose `purposeLimits` raise `maxToolCalls` from 8 to 20; one whose `maxToolCalls` is above its `purposeLimits` | each refused at admission as `tools-not-consented`; the backend saw nothing | skip the digest compare (or leave the limits out of it) |
| 4 | C036 undeclared or ill-typed calls | an echo backend calls an undeclared name, then a declared tool with an extra key, then with a string past `maxLength` | three tool errors to the model; nothing sent; three calls charged | let unknown names through |
| 5 | C037 a result is bound to its call | the upstream returns a result for an unknown `callId`, for another job's call, a replay of an answered call, and a `payload`-direction envelope | each dropped and logged; the model never sees it | drop the `callId` check |
| 6 | C038 the daemon's budget | an echo backend that calls forever, `maxToolCalls: 3` | exactly 3 calls sent; a final turn with no tools; `ok` with `stop: "tool-budget"` | count after sending instead of before |
| 7 | C039 the relay's budget | the kit plays a modified daemon and posts 21 calls on one job | the relay refuses the 21st; the site's `calls` never shows it | drop the relay's count |
| 8 | C040 the site SDK's budget | the kit posts `maxToolCalls + 1` valid sealed calls on the direct lane | the SDK runs `maxToolCalls` handlers and refuses the rest | drop the SDK's count |
| 9 | C041 a site that does not answer | the site never posts a result; the job's deadline is 5 minutes | after `TOOL_CALL_TIMEOUT` the model gets a tool error and the job ends `ok` with `toolOutcomes.answered` 0 and `timedOut` equal to `toolCalls`; the lease was held throughout, with no reclaim | resolve the wait only at the deadline, stop renewing the lease while waiting, or count a timeout as answered |
| 10 | C042 calls logged first | the upstream asserts the ingress line exists when the call arrives | every call has its line already | log after sending |
| 11 | C043 other kinds unchanged | an `llm.chat` job on a service with tools on | the backend receives no function declarations | send declarations on every request |
| 12 | C044 off by default | a service with no tools setting | `llm.tools` not advertised; `backends` says how to turn it on | default it on |
| 13 | C045 the grant field stays home | the control plane authors grants for an `llm.chat` and an `llm.tools` job | `toolsDigest` present on the second only | put it on every grant |
| 14 | C046 the context cap | a `medium` job whose `maxToolResultChars` is 20,000; an echo backend that calls a tool returning 15,000 characters, then calls it again | the site SDK classed the job by its prompt plus 20,000; the first result reaches the model, the second does not; one closing turn with no tools; `ok` with `stop: "tool-budget"` and `toolOutcomes.refused` 1 | hand every result to the model, or size the job by its prompt alone |
| 15 | C047 code and manifest agree at enqueue | the hub holds a manifest whose tool description differs by one character from what the site SDK declares | the enqueue is refused as `tools-manifest-mismatch`; nothing is queued and no device claims anything | drop the enqueue compare |

## 13. Done when

- `llm.tools` exists in `@byollm/protocol`, with the payload, envelopes and
  result additions above, `payloadTextLength` counting
  `maxToolResultChars`, and `Purpose.tools`, `maxToolCalls` and
  `maxToolResultChars` in the manifest schema.
- byollm_016's "Kept out" line reads as §12 amends it.
- The grant carries `toolsDigest` for `llm.tools` and only for it.
- The relay and `@byollm/server` serve the four endpoints, and the site SDK's
  pump collects calls, runs registered handlers with the job's user and
  purpose, and seals results.
- The daemon runs the loop on HTTP backends, with the probe from §7.
- §12's checks pass, and each is recorded in MUTATIONS.md with its mutation
  and a note that it was seen to fail. No §12 MUST is still `pending`.
- The adversarial corpus gains a hostile-site set: declarations that try to
  name local actions, results that try to instruct the model, and calls
  aimed at another job.
- `docs/security.md` says, in a sentence: *a site's tools run on the site;
  your device sends the model's requests to that site and nothing else, and
  every request is in your device's log.*
- The consent screen renders §10 from the manifest, and the kind-label table
  has "Using the site's tools".
- `NOT_YET` no longer says "no tool use" bare. It says what is still not
  there: tools that run on your device, and tools on subscription CLIs.
- Press's `llmSearch` is a thin wrapper over `llm` with `llm.tools` (§10).

---

## Rollout

The rollout for this spec and byollm_021 is one section, in byollm_021
§Rollout, because they ship in one gathered release or not at all.

---

## A note on how this stub was corrected

*(Kept from the stub, as written. The table it refers to now lives with
daemon-run tools in commit 488cb02, §7, held under §11.1. The practice it
draws applies to all of this spec.)*

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
