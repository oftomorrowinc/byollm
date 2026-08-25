# byollm_016 — Services: the config's first-class noun

**Status: design review, 2026-08-24. Direction approved by Todd; open
for working-group reaction (Kevin) before implementation. Supersedes
the backends+routes config shape when ruled final.**
**Blocks: byollm_015 Phase 1 (the wizard writes config, so it waits
for this shape to settle). Does not block the Lis/press walk, which
runs on the current shape with one voice.**

## Why the current shape is wrong

`backends` + `routes` creaks in four places, found in one afternoon of
real use:

1. **The model has no single home.** For Ollama the backend is a
   server and the route's `model` selects among many — the two levels
   earn their keep. For MLX with an adapter, the model is baked into
   the server process and the route's `model` is a magic string
   selecting nothing. One shape, opposite meanings per transport.
2. **Users name the backend after the thing it actually is.** The
   first real config called its backend `gwen-voice` — a voice, not a
   transport. The config fought the mental model and the human won by
   naming. Listen to that.
3. **Offer granularity is wrong.** `offer` sits on the backend, but
   the sentence owners mean is "Lis can use gwen-voice" — per-voice,
   not per-port. Three voices on one device makes per-service
   audiences a real need the current shape cannot express.
4. **One route per kind collides immediately.** gwen-voice,
   dane-voice and pub-professor-voice all serve `llm.generate`;
   `routes` can hold one of them. The owner's own Claude use of the
   same kind collides identically.

And a fifth, delivered by the field the same day (press 033 §8):
mlx-lm 0.31.3 silently ignores `--adapter-path` (`_adapter_map` looked
up after the model name is rewritten — misses for every request
shape), and the only working invocation names the adapter **per
request**. The current config has nowhere to put a request parameter.
A shape whose first production model cannot be expressed is not the
shape.

## The shape

The **service** is the first-class noun: a named, owner-defined
servable thing. Transport is its detail.

```json
{
  "services": {
    "gwen-voice": {
      "type": "openai-http",
      "baseUrl": "http://127.0.0.1:6999/v1",
      "request": {
        "model": "default_model",
        "adapters": "/Users/todd/VoiceLoom/adapters/Gwen-DeMarco/best-A-1400"
      },
      "kinds": ["llm.generate"],
      "offer": "named"
    },
    "claude": {
      "type": "claude-cli",
      "request": { "model": "claude-opus-5" },
      "kinds": ["llm.generate", "llm.chat"]
    }
  },
  "defaults": { "llm.generate": "gwen-voice", "llm.chat": "claude" }
}
```

- **`request` is the owner's request template** — model, adapter
  path, any fixed parameters the serving stack needs. Owner-written
  configuration for the owner's own server. It is never influenced by
  a payload; jobs cannot reach into it.
- **`kinds` declares what the service answers.** Detection still
  rules (byollm_013): declared-but-undetectable drops the kind with a
  loud config problem, never a silent advertisement.
- **`offer` moves to the service** — per-voice audiences, which is
  what owners actually mean. `apiKeyEnv` and `spend` ride the service
  too; cost class still comes from the registry via `type`, never
  from config (COST_NOT_CONFIGURABLE unchanged).
- **`defaults` is optional and earns its place only under
  ambiguity.** One service offering a kind → it serves, no stanza.
  Two or more → config load demands a default, loudly, in the owner's
  terminal — never a job-time mystery three hops away. This preserves
  the protocol's core property: a generic site says "I need
  llm.generate" without knowing any owner's service names.

## The wire

A job is **(kind, service?)**. The kind owns the payload shape; the
optional service selects who serves it, from the menu the device
advertises. Unset falls to the default. Selecting an unadvertised or
unoffered service is a refusal.

`NO_PAYLOAD_ROUTING` is amended in letter, preserved in spirit: a job
still never names a model, a vendor, or a parameter — it names a
**menu item the owner published**, the same trust shape as kinds. The
owner owns the mapping and can repoint `gwen-voice` at a new
checkpoint without any site changing a line.

The existing law already polices the corners for free: enqueue stamps
the job's owner from the session, `mayRunFor` + the self-lock refuse a
member's job selecting a subscription service, and the effective offer
means a member's menu only shows what they may select.

## What must not change

Cost from the registry; SSRF checks on baseUrl; the subscription
self-lock; community budgets; ingress retention; detection per
byollm_013. And one lesson this same day taught, recorded as an
obligation on adapter-class services: **liveness cannot distinguish
adapter-loaded from base** — mlx-lm returned 200 and generated
happily with a nonexistent adapter path, and a correct in-code guard
still lost because the miss was inside the dependency. The only proof
is differential: temp-0 output compared against base. Walks involving
an adapter verify by comparison, and the docs must teach that check,
not just the setup.

## Migration

Pre-1.0 liberty: the working group is three people, notice is a
message, the daemon reads the new shape only. No dual-read. The
byollm_015 wizard writes this shape from birth. The "type" field
rename (already ruled) lands with it.

## Naming ruling: the un-retirement of "service"

"Service" was retired once — the dashboard used it for *sites*, Todd
ruled that wrong, and the one-noun lint has banned the word since.
This spec un-retires it with exactly one meaning: **a service is a
named servable thing a device runs.** It is never a site, never an
app, never the daemon. The lint flips from "never say service" to
"service means only this"; docs use it for nothing else. Recorded so
the collision is a decision, not a drift. (Runner-up "models" is what
everyone says but lies about future non-model offerings;
"offerings" is precise and dead on arrival.)

## Open questions for the working group

1. Shared multi-model servers: does an Ollama box get one service per
   model (duplicated baseUrl, simple) or a referenced server stanza
   (DRY, but rebuilds the two-level shape under new names)? Current
   lean: duplicate the baseUrl; simplicity wins at this scale.
2. `request` passthrough bounds: free-form object (owner talks to
   their own server; SSRF already gates the URL) vs an allowlist of
   keys. Current lean: free-form, because the owner already runs the
   server — but the daemon must never merge payload fields into it.
3. Does `kinds` stay declared (checked by detection) or become fully
   detected? Current lean: declared-and-verified — detection proves,
   the owner still chooses what to advertise.
4. Per-requester defaults: rejected unless someone brings a use case.
   The default is the owner's answer to "generic work", singular.

## Done when

The shape survives Kevin's reaction; the daemon reads it; the wire
carries (kind, service?) end to end with contract cases for
select-unadvertised, select-unoffered-to-you, and default-ambiguity;
the lint and docs complete the un-retirement; byollm_015 Phase 1
unblocks.

---

## Additions from review (Todd + Cowork, 2026-08-24 evening)

Context: the walk gates on press's bake-off re-run anyway (a plumbing
walk serving a base model proves nothing worth proving), so the shape
gets the time to be right. Additions:

- **`system` is first-class on the service.** Press proved the
  training system prompt is part of the model — output visibly
  degrades without it — and today it travels to integrators as a
  verbatim incantation in chat. The service carries it as the
  default; a payload `system?` overrides it (content, not
  configuration); an owner may mark it **locked**, and then a job
  carrying its own system prompt is refused loudly — never silently
  ignored. Lock exists for persona integrity.
- **Generation parameters stay owner-side.** The kinds' payloads are
  closed (`{prompt, system?}` / `{messages, system?}`) and carry no
  temp/top_p/max_tokens on purpose; the `request` template is their
  home. Sites get generation knobs only if evidence arrives, as a
  deliberate protocol change.
- **Per-service `concurrency`**, with the global value as overall
  ceiling. Motivating case: two 14B MLX jobs swap a Mac Studio to
  death while claude-cli could take three.
- **`enabled: false`** — JSON has no comments; benching a voice must
  not mean deleting its stanza.
- **`label` / `description`** — what the team-facing menu and
  /devices chips display. Members choosing from a menu need the menu
  to say things.
- **Optional per-service community-limit overrides** (a 14B service
  reasonably serves fewer jobs/hour than an echo backend); global
  `community` remains the default.
- **Service ids are contract-ish.** Sites select by id, so a rename
  breaks integrations. Ids: stable, sane charset; renames free until
  the first outside consumer, then the compat boundary applies.
  `label` is where pretty names live, so renaming stops being
  tempting.

**Named future, not built: managed services.** A lifecycle stanza
(`command`, idle shutdown) letting the daemon start a model server on
demand and stop it idle — the answer to "five weekly models should
not run 24/7". Real process-management work with cold-start
semantics; out of scope now, but the shape is checked against it so
it lands as a stanza, not a redesign.

**Kept out, deliberately:** per-site ACLs on services (person-level =
allowlist, site-level = site approval; a third axis would re-implement
both); payload-influenced request fields, ever; verification stanzas
in config (the differential check is walk/detection discipline);
generation params in payloads.

**Open question 5 (added):** config format. JSON's commentlessness is
half of why `enabled` exists. JSONC (comments stripped at load) vs
staying strict-JSON with the wizard absorbing the hand-editing.
For Kevin's reaction alongside questions 1–4.

## Amendment: the `sampling` block (Todd's challenge, 2026-08-24)

Todd challenged the line between first-class `system` and
template-buried generation parameters as arbitrary. Partly upheld,
partly conceded — and the concession improves the shape.

The principled half stands: **a field is first-class when the daemon
must adjudicate it; overrideability follows the wire, not
importance.** `system` is in payloads, so override/lock semantics are
forced. Sampling parameters are in no payload, so no collision exists.

The conceded half: opacity has costs even for owner-only fields. An
opaque `"temperature": 9` typo spreads into the request and the server
does whatever servers do with input they don't understand — today of
all days, the answer is "return 200 and generate happily." And the
concept is the same cluster as `system`: how this service performs as
trained.

So the service gains a first-class, typed, optional **`sampling`**
block — `temperature`, `topP`, `topK`, `maxTokens` — validated at
config load, mapped per transport by the daemon. `request` shrinks to
genuinely transport-specific extras the daemon has no business
understanding (`adapters` is the founding example). Rules:

- Sampling stays owner-only on the wire. Payload override for
  sampling arrives only with evidence, as a deliberate protocol
  change — never by drift.
- `maxTokens` composes with `limits.maxOutputBytes`: the limit is a
  safety ceiling, the sampling value a tuning default; the stricter
  wins.
- A transport that cannot honor a set sampling field (claude-cli has
  no temperature) drops the service's kind with a loud config
  problem — never silently ignores a value the owner set to make the
  model perform correctly. Same law as the locked system prompt:
  nothing the owner wrote is quietly discarded.

Revised sketch of a service entry:

```json
"gwen-voice": {
  "type": "openai-http",
  "baseUrl": "http://127.0.0.1:6999/v1",
  "kinds": ["llm.generate"],
  "offer": "named",
  "label": "Gwen DeMarco prose voice",
  "system": { "text": "<training prompt, verbatim>", "locked": false },
  "sampling": { "temperature": 0.9, "topP": 0.95, "maxTokens": 400 },
  "request": { "model": "default_model",
               "adapters": "/Users/todd/VoiceLoom/adapters/Gwen-DeMarco/best-A-1400" }
}
```

## Simplification pass (Todd, 2026-08-24, late)

Three corrections after Todd pushed on weight:

**1. The honor rule is config-time, never job-time.** The previous
amendment's "drops the kind with a loud config problem" reads scarier
than it is, so said plainly: setting `temperature` on a claude-cli
service is a *config-load error*, caught the moment the owner writes
it, fixed by deleting one line. No job ever fails over it; no site
ever sees it. It is a typo check, the same class as an unknown field
under `.strict()`.

**2. No mismatch checking, because nothing can mismatch.** The
integration worry — an app whose OpenAI-path requests carry
`temperature: 1`, with byollm as the alternate lane — dissolves on
the wire: byollm payloads carry no sampling fields at all, so the
site's byollm client simply doesn't send them and there is no value
for the daemon to compare, honor, or reject. The two lanes are
allowed to sound different: on the API lane the app's knobs rule; on
the byollm lane the owner's tuning rules — that asymmetry is the
product ("the owner decides what serves it"), not a defect. If real
integrators need payload sampling parity, that is the evidence the
earlier amendment gates on, and it arrives as a deliberate change.

**3. Locks are cut from v1 of the shape.** Every field in `system`
and `sampling` is simply optional; unset falls to the transport's
default. The `locked` flag on `system` (and the loud-refusal
machinery it required) is removed — persona integrity was a
speculative use case, and lock semantics are exactly the kind of
weight this shape doesn't need until someone brings the case.
Evidence-gated, like payload sampling. `system` is a plain string
again in the sketch: `"system": "<training prompt, verbatim>"`.

**Named future #2: tool scoping.** byollm_012 holds the position on
tools (never on the shared plane; even `self` is not obviously safe;
the narrow maybe is daemon-mediated, read-only, self-only). If that
narrow maybe ever lands, the *service entry* is where its scoping
lives — which mediated tools a service may reach, bound by 012's
laws. Recorded so the shape leaves room; byollm_012 remains the
authority on whether and what. Like managed services: a stanza later,
never a redesign.

## Phasing ruling (Todd, 2026-08-24, night): build it now, in two phases

Todd ruled the re-shape happens now — the current shape cannot hold
two models of one kind, and every pre-stranger day makes the break
cheaper than it will ever be again.

**Phase A — the shape, wire-neutral.** Config (services, defaults,
system/sampling/request), the capability matrix advertising service
ids + labels, daemon internals, CLI (`services`, `offer <service>`),
detection per service, hub presence + /devices + web chips consuming
the new shape, docs rewritten. Enqueue stays kind-only; `defaults`
picks the server. Known ripple, accepted out loud: alpha.43's
`Presence.capabilities` changes shape again — pre-1.0 liberty, noted
not hidden. Acceptance: base Qwen on the Studio as a `named` service,
Kevin running real jobs against it — the config he integrates
against is final-shape and never rewritten under him.

**Phase B — the wire.** (kind, service?) on enqueue, the
NO_PAYLOAD_ROUTING amendment, hub matching, server SDK, and the full
contract suite (select-unadvertised, select-unoffered-to-you,
default-ambiguity), mutation-verified. Needed only when a second
service shares a kind — nothing does yet — and starts after Kevin's
review lands, which is exactly where his feedback bears.

Estimate: each phase on the order of a day of focused work plus test
churn (config fixtures thread through dozens of files; pinned copy
will fail loudly, as designed).

## Phase A minimized (Todd, 2026-08-24): the break, and only the break

Ruling: Phase A ships the reorganization with none of the review
additions. A service entry is today's information, re-homed:

```json
"services": {
  "qwen": { "type": "openai-http", "baseUrl": "http://127.0.0.1:6999/v1",
            "model": "<as listed by /v1/models>",
            "kinds": ["llm.generate", "llm.chat"], "offer": "named" }
},
"defaults": { }
```

`type`, `baseUrl`, `model`, `kinds`, `offer`, plus `apiKeyEnv` and
`spend` carried over unchanged. Nothing else. `defaults` required
only where a kind is ambiguous.

The additions (`system`, `sampling`, `request`, `label`,
`description`, `enabled`, per-service `concurrency`, per-service
community overrides) remain specced above and **deferred**: every one
is an optional field, and adding an optional field to a settled shape
is a non-event — each lands later, individually, when something needs
it, with its own small review. The breaking change is the
reorganization; do the break minimal, grow the shape additively.
(Consequence: the MLX-adapter path still waits — `request` is the
field it needs — which is consistent, since the LoRA itself is an
open question with Lis.)

## Phase B rescheduled + the defaults/audience corner (Todd, 2026-08-24, late night)

**Phase B moves up: immediately after Phase A ships**, not parked
until a second voice exists. The first real customer is Todd's own
Studio — qwen offered `named` to the team and claude for the owner's
work, both on `llm.generate`. Kevin's 016 feedback folds in in
flight. Clarified for the record: the two new integrators' out-of-box
case (claude-cli serving both kinds, one service per device) needs
only Phase A — selection has no ambiguity to resolve there.

**New Phase B requirement — defaults meet audiences.** A default may
resolve a member's unselected job to a service that member can never
use (e.g. default = claude, self-locked). That must never become a
wait. Either default resolution is audience-aware — resolved among
the services offered to *this* requester — or the job gets a terminal
refusal naming the reason. Silence never reads as pending; every new
refusal Phase B introduces (select-unadvertised,
select-unoffered-to-you, ambiguity, default-unusable) is terminal
and contract-cased, both sides of the wire, mutation-verified.

Why Phase B costs what it costs, recorded once: three parties (site
SDK, hub, daemon) must reason identically about the pair inside
sealed envelopes; matching gains a dimension; the daemon re-checks
per the both-sides rule; and NO_PAYLOAD_ROUTING — the load-bearing
security law — is rewritten precisely enough that "select from the
owner's menu" can never drift into "sites demand models." The full
contract price, paid once.

## Phase A progress (CCC, 2026-08-24 evening, 13ddc8c)

The config break is in: backends + routes → services + defaults, 1000
tests green. CCC's summary of the old shape's flaw is worth keeping:
the servable thing — the one an owner would actually name — existed
only as the intersection of a backends entry and a routes key.
Implemented property: one service answering a kind serves silently;
two or more and the kind is not advertised until the owner names a
default — a device never announces what it can't resolve
deterministically. Cowork's confirmation request on that property:
the withholding must be loud on the owner's side — the load problem
names it AND `byollm services` shows the kind as withheld-pending-
default, never merely absent — else the de-advertisement is the quiet
kind of correct (owner adds a second service, team jobs stop
matching, nothing says why).

Specimen kept (CCC's find): a bulk-regex fixture migration turned a
regex quantifier `{4,}` into `{4 }` — a comma-before-brace cleanup
rule applied to source, matching a quantifier — and the MUST-table
parser then found zero tables. Minutes instead of weeks, only because
a check existed whose entire job was noticing the tables had stopped
being read. Same class as every silent-success bug this week; the
checks are earning compound interest now.

Remaining Phase A, agreed order: capability carries service id →
per-service detection (incl. the :cloud-is-metered case) → hub
presence + /devices + chips → CLI renames → docs rewrite. Then the
alpha Todd promotes.

## Loudness closed + a Phase B guard on the wire shape (2026-08-24 evening)

Both surfaces confirmed (c66e5f8): the load problem already named kind, claimants, and fix; `byollm services` and `byollm status` now carry a withheld row naming the claimants and the stanza to write. State is carried, not inferred — resolveConfig returns `withheld` beside routes; every surface reads one source. Two mutations caught, the second worth keeping: resolving ambiguity by silently picking the first claimant — correct-looking, quietly decides the owner's routing — plus a control case against a surface that always warns. `byollm backends` → `byollm services`, rows led by service name.

/devices shaping agreed (withheld rides heartbeat → presence → /devices, shaped once), with one guard added by Cowork before the wire hardens: **"advertised capability = resolved default" is a Phase-A-only truth.** Phase B advertises every selectable service per kind — the menu — so advertised ≠ default by construction. No consumer may infer the default from row-uniqueness; capability rows carry an explicit default marker now (trivially true for the single Phase A row), so Phase B adds rows without any consumer changing its mind about what default means. One field today spares a second wire shape next week.

## Queued CLI addition: `byollm allow <app-url> --team` (Todd's question, 2026-08-25)

Todd asked whether the allowlist can say "full team by default." Layer
one already does: `offer: "named"` structurally means the whole
roster — a route cannot name a subset. Layer two — the device's local
allowlist, the enforcing side — stays per-person by design: the
roster decides who is *shown*, the device decides who it will *run*,
and that split is what keeps the hub (or a compromised account)
unable to add people your device runs jobs for.

Ruled: a **snapshot** command, `byollm allow <app-url> --team`,
resolving the current roster to individual allow entries at command
time — explicit, re-runnable, no delegation. The queued
roster/allowlist drift surface (web_004) is its companion: it names
exactly when a re-run is due. A **standing** roster-following rule
(device honors hub-asserted membership continuously) is deliberately
deferred — it trades the device's local say over who runs on it for
convenience, and gets ruled on only if roster churn makes snapshots
genuinely annoying in practice. Timing: after Phase B; not in the
critical path.

## Ruling (Todd, 2026-08-25): private or team — membership is central. Done.

Supersedes the `allow --team` snapshot ruled hours earlier (never
built — superseded at the cheapest possible time) and the queued
roster/allowlist drift surface (no drift when there is one list).

Todd's ruling, GitHub-teams analogy: an owner manages membership once,
centrally (the roster), not per-device. Offer is **private** (self)
or **team** (the roster). Cowork's earlier per-person-allowlist
defense is retracted on re-analysis: the laws that actually contain
the account-compromise threat already exist and are stronger than the
allowlist — the subscription self-lock is structural (no roster
change reaches a subscription service; the lock consults no list),
community budgets bound jobs/hour/day, wall-clock, and payload, and
jobs are sealed and inert. Worst case of roster-following is bounded
GPU burn on free-class services — not worth GitHub-without-teams
ceremony on every device forever.

The shape:
- Roster syncs to the device through the hub; the daemon's per-job
  re-check runs against the synced copy (both-sides preserved in
  form: the daemon still checks, against the centrally managed team).
- A roster change lands on the device as a **loud notice** ("X was
  added to your team; this device now runs their jobs") — the
  Amendment C pattern: no ceremony, two authorities, loud notice.
- `byollm disallow` survives as a local per-person veto — an
  emergency say with no enrollment ceremony. Per-person `allow` for
  team members is gone.
- Site approval (which apps may send work) is a different door,
  untouched.
- `public` stays parked for the community program (byollm_012/013
  cloud series), unbuilt, unaffected by this ruling.

Consequence for the wait-gap family: shown and runnable become the
same fact for team members; the rostered-but-refused class is deleted
rather than surfaced.

**Amendment (Todd, 2026-08-25, minutes later): the third offer form.**
`offer` is one of three shapes: `"private"`, `"team"`, or an array of
emails written directly in the config. Not a replacement for the
central-team ruling — its completion, and it restores per-service
subset audiences the team scope structurally could not express
("Lis's voice model is for Lis" is one config line). The GitHub
analogy completed: private repo / org team / named collaborators.
Mechanics: emails are the owner's vocabulary; the hub (owner of
identity) resolves them to accounts; the daemon re-checks jobs
against the resolved set (both-sides, same as team); an email with no
account is inert until that person exists — invite-by-email
semantics. Cost law unchanged: an array is named-class scope. The
config remains the single owner-authored source — sharing with a
person is editing config, not running enrollment commands.
