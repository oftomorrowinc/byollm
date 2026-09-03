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

**Correction (minutes later, Todd + Cowork): the email array is
deferred, not ruled.** Todd asked for the honest assessment; the
answer is good design, no customer. Its motivating case (a
one-person voice service) lost its artifact when the LoRA failed;
current sharing needs are fully covered by `team`. Its cost is real:
a third branch in mayRunFor, email→account resolution, identity edge
cases, per-service re-check sync, three-form contract cases, and a
third concept in wizard and docs — hours after "private or team.
Done." removed per-person ceremony, the array would reintroduce
per-person listing through a different door. Deferral costs nothing:
accepting an array later is a pure schema widening. So it joins
system/sampling/label on the deferred list, evidence-gated: revived
the first time someone real needs to share a service narrower than
their team. Phase A ships `offer: "private" | "team"` (+ parked
`public` in the enum) with roster-follow.

> **Correction (2026-08-25).** It did not. Phase A and Phase B both
> shipped with `team` enforced by the per-person local allowlist, and
> the daemon says so at load. Roster-follow was specified here and
> built nowhere, which made this line a description of an intention
> that a reader would have taken for a description of the product.
>
> The rule it broke is the one this project keeps re-deriving: a
> sentence and the thing it describes ship together, or the sentence
> waits. A spec is not exempt — it is the document somebody checks
> the code against, so a spec that runs ahead of the build turns
> every later reader into somebody reconciling two truths.
>
> Roster-follow is now byollm_001 Amendment G, RATIFIED 2026-08-25
> and awaiting its build. The in-product notice retires with that
> build and not with the ratification: a daemon whose `team` is still
> local must keep saying so. Cowork's note for the
record: the previous entry committed the array as ruled when it
deserved this gate — caught by Todd asking "good idea or overkill?"

## Consequences sweep (Cowork, 2026-08-25, before sending to CCC)

What falls out of private-or-team + two-static-views, stated so none
of it becomes an accidental discovery mid-build:

1. **One wire revision, not four.** Phase A's capability changes now
   include: the service id, the explicit default marker, withheld,
   and the renamed offer scopes. Bundle them in a single protocol
   rev. On naming: rename enum values once, now — `self` → `private`,
   `named` → `team` (`public` parked, unchanged). MUST *ids* stay
   stable per law; MUST text updates to the new words in the same
   pass.
2. **Roster sync rides the projection — the fence decides this.**
   The roster lives in the control plane; the hub and daemon may
   learn it only through the sanctioned projection path that already
   carries devices and grants (cloud_001 fence: no writer crosses;
   one reader each way). Roster membership becomes a projected
   entity beside device rows. No new channel, no direct read.
3. **Sync the resolved roster, never re-derive it.** Invite expiry
   (14d) is a control-plane read-side predicate. The daemon receives
   the resolved member list; neither hub nor daemon re-implements
   expiry. One source, or the predicate forks.
4. **The authorization matrix is now two independent axes.** Site
   approved (device-side, per app) × roster member (central). The
   old allowlist's per-(site, person) cell granularity is gone —
   deliberately. "Kevin may use app A but not app B on this device"
   is no longer sayable; if someone real ever needs it, that is the
   email-array's evidence gate reopening, not a bug report.
5. **Team jobs remain community-budgeted.** COMMUNITY_BUDGETS keys
   on job-owner ≠ device-owner, which is unchanged by membership
   being central — a teammate's runaway loop still hits the
   jobs/hour, wall-clock, and payload caps. Worth one conformance
   case so the rename can't silently widen the budget exemption.
6. **Phase B's defaults-meet-audiences corner survives the
   simplification.** A device whose kind-default is a *private*
   service still receives member jobs kind-only; resolution for a
   member must be audience-aware among team services (or terminally
   refuse). Two static views simplified the *display*, not this
   resolution rule.

Also mooted by tonight: open question 4 (per-requester defaults) is
dead — the team view is uniform by construction. The wizard's offer
question (byollm_015) speaks the new vocabulary: "Offer this to your
team? [y/N]".

## Three confirmations + the intermediate state (2026-08-25)

1. **`public` — legal on the wire, refused by config in Phase A.**
   Confirmed as CCC read it, with the manner specified: a loud
   config-load refusal naming why ("the community program isn't open;
   offer will gain public when it is") — never silently ignored. A
   sharing decision must not be makeable by typo, and its refusal
   must not be mistakable for a broken config.
2. **Withheld wire shape `{kind, claimants: [{service, offer}]}` —
   confirmed.** Names alone can't decide the team-view predicate;
   offers ride the wire for computation and are filtered for
   display — the established pattern. Daemon-internal shape stands.
3. **The intermediate state: CCC's plan approved.** The single
   protocol rev lands tonight (OfferScope renamed, Capability gains
   service + isDefault, withheld on the wire); roster-follow is a
   new subsystem — projection-path sync, daemon re-check, loud
   notice, NAMED_LOCAL_ALLOWLIST amendment — and gets its own build
   and report. Until it lands, `team` enforces via the local
   allowlist. Two guards make the gap honest rather than flattering:
   the alpha is **not promoted as "team sharing works"** (promotion
   gate, Todd's), and the gap announces itself **in-product**: when a
   config contains a team offer, config load and `byollm services`
   print "team enforcement is local-allowlist in this build; roster
   sync lands next" — the build describes its own limitation where
   the owner is looking. Holding the rename was considered and
   declined: it would split the wire rev in two, and the only flow
   the gap blocks is the Studio team walk, which roster-follow
   precedes anyway; the integrators onboard on `private`.

Open item for CCC's judgment, with data: `Audience` shares the
self|named|public literals and is not renamed — accepted bilingualism
for now, but if leaving it means every OfferScope↔Audience seam
carries a mapping and docs forever explain "self vs private," say
what riding the same rev would cost. One vocabulary is worth a
bounded price; CCC has the numbers.

**Ruled (Todd, 2026-08-25): one vocabulary — `private | team | public` — everywhere.** The Audience open question is resolved by ruling, not cost accounting: Audience's shared literals rename with OfferScope in the same single rev. "self" and "named" were insider vocabulary — meaningful after reading the spec; private and team mean the right thing to someone who never has. Bilingualism dies in the one release already reshaping the wire. MUST ids remain stable per law (SUBSCRIPTION_SELF_LOCK keeps its id; its text learns to say private), and the type-aware rename CCC scoped covers both types now.

## public: ruling 1 withdrawn on evidence (2026-08-25)

CCC declined to implement the config-load refusal of `public` and
brought the evidence: `byollm offer <service> public` is a shipped,
tested (six invocations), README-sold capability of the open-source
daemon, working today in direct mode, bounded by CommunityBudget —
which exists precisely to make it safe. Refusing it at config load
would delete a working OSS feature, not park a future surface. The
refusal ruling was made without the direct-mode evidence and is
withdrawn; CCC's disposition stands: `public` accepted and
documented. "No product surface" means what is true — the cloud
dashboard does not offer public sharing and the hub does no community
matching until the program (cloud_012/013) exists — so public is
inert in cloud mode and functional in direct mode, as the README
promises. Todd raised removing `public` entirely for now; Cowork
recommended against on open-source-first grounds (the daemon's
promise predates the cloud; removal breaks it for any direct-mode
user while buying simplicity the dashboard vocabulary already
provides). Pending Todd's final word; default is keep-as-is.

Also recorded from the same report (fbef3ba): the one-vocabulary
rename landed type-aware (compiler named 98 sites; tests caught what
it couldn't see — the division of labour both exist for), and CCC's
notices-vs-problems channel split is adopted as a rule: a *problem*
means the config is wrong and something was dropped; a *notice* means
the config is fine and the build is behind it. Merged, every
limitation reads as the owner's mistake — and a real mistake gets
harder to spot. A control case keeps the team-gap notice from
becoming wallpaper for private-only owners.

**Closed (Todd, 2026-08-25): ruled as CCC built it.** Todd was
agreeing, not overruling — public leaves the *cloud's supported
list* for now (no dashboard surface, no hub community matching, and
the cloud docs teach private | team, mentioning public only as an
open-source direct-mode capability awaiting the community program)
and stays fully supported in the daemon and direct mode. Phase A's
docs rewrite (stage 5) carries the docs half. Item closed.

## Capability wire landed (CCC, 2026-08-25, 9a6d17e)

One rev, deliberately bundled — three separate revs would have meant
three rounds of every consumer re-agreeing what a capability row
means. `service` (a device says which service answers a kind),
`isDefault` (stated, not inferred — the Phase B guard implemented),
and withheld as `{kind, claimants: [{service, offer}]}` (carry for
computation, filter for display). Optional-with-a-default: a daemon
withholding nothing sends nothing, and an older daemon against a
newer hub reads as "no withheld kinds," not a parse failure. 1006
tests green.

On CCC's flagged trap for per-service detection (one Ollama endpoint
serving both free local and metered :cloud models): resolved by the
shape, not by a new ruling. Cost is a property of the *service*, and
a service pins one model — two services may share a baseUrl and
classify differently, each from its own configured model name. The
suffix check runs against the config value, not the server listing;
aliasing to evade spends the owner's own quota (already ruled
self-punishing). The old backends shape had this trap; the
reorganization removes it. Endpoint-level cost is dead; long live
service-level cost.

## alpha.44 cut; the fail-open catch; two rules minted (2026-08-25)

Detection landed (70454a7 — a service is one thing, asked once; the
half-advertised-machine bug dies with the route-walk). alpha.44
tagged on 2745d9a, CI green; Todd pushes the tag and promotes per the
ritual — with CCC's hold recommendation on the record: until the hub
deploy, an alpha.44 daemon's private/team jobs queue and never run
(fails closed, silently), so the latest move belongs after the hub
report.

**The serious catch:** both hub sharing filters were written against
the excluded value (`audience == 'self'` in claim Lua, `offerScope
!== "self"` in devices-api) — the one-vocabulary rename would have
made them fail OPEN, and the Lua one decides where work physically
runs: a job whose owner chose "my own machine" claimable by every
roster device. Both are now allowlists of the widening values.
CCC's mechanism sentence, kept: "every fixture in both files says
self and named, which is exactly how a rename walks past a green
suite." Two rules minted: **sharing filters enumerate the widening
values — an unknown value keeps work at home**; and **every
audience/offer filter carries an unknown-literal case asserting
closed** — the fixture for a value that can't exist yet is the one
that catches the rename.

## Phase A: hub + web deployed end-to-end on alpha.44 (CCC, 2026-08-25)

Hub on sha256:1988b6f5, twelve posture checks green, real `audience:
"private"` job through hub.byollm.cloud — enqueued, claimed, sealed
both ways, run, opened. Dashboard and docs live, verified by served
HTML rather than build logs. byollm 2745d9a + tag, byollm-cloud
e9c061c, byollm-cloud-web 6049bbe. Todd's latest promotion unblocked
by this deploy.

Ratified judgment calls: (1) not rolling back a healthy hub when the
proof harness — not the thing it measures — was what failed (the
round-trip/long-job/kill-test scripts still built retired-shape
configs, so the prover was refused by the daemon it drives); (2) the
deliberate scope widening to the docs guides, for the right stated
reason: "an error message pointing at the config it just refused is
worse than no pointer."

Honest-control note, kept as the standard: the edge watch died with
the script, so this deploy has no during-rollout edge line; CCC ran
the real watcher after (58 probes / 121s, all 401) and reported "a
weaker claim than the deploy normally makes, and it's the one that's
true" — including the confessed 404s from a guessed path. That
sentence is the house style for controls that didn't report.

Rules minted: **proof harnesses are consumers too** — a breaking
change's migration checklist includes the scripts that prove
deployments, or the prover blocks the proven (roll.sh's rollback
advice was correct as a default and wrong here; the fix is harnesses
that ride the migration, not softer advice). And **deploy-critical
pipelines don't hide state**: two `| tail` mistakes cost visibility
twice — a piped background deploy silent until exit, and a pipeline
exit code masking a real failure with 0. Deploy paths run unpiped or
with pipefail, never both buffered and trusted.

Boundary relocation from the pin bump, recorded: every hub fixture
said `audience: "self"`, so CLAIM_ATOMIC — a concurrency test — went
red at parse. The Lua allowlist is the *second* line of defense; a
stub carrying an old spelling is refused at parse and never reaches
it. The mid-upgrade window is now a test rather than a paragraph.

Phase A remaining, unchanged: presence carrying
service/isDefault/withheld, /devices owner/team split, dashboard
defaults row, stage-5 docs rewrite (the two lint rulings land there).

## Stage 5 live; release-ordering rule minted (2026-08-25)

Docs rewrite deployed and verified against served pages (the house
style): glossary at /guides/glossary; the team guide carries "does
not open your device", `byollm allow`, and the roster-sync caveat.
byollm at 1925399, tag v0.1.0-alpha.45 held for Todd's push;
everything left in Phase A sits behind it — including a store
contract that intentionally fails against Valkey until the package
exists, which is the contract doing its job.

**Rule minted (second occurrence graduates it from advice):** when a
release changes the wire, `latest` moves only after the hub speaks
it. Sequence: push tag → npm publish → hub deploy → verify → promote.
The alpha tag suffices for anyone deliberately tracking between
those steps. alpha.44 paid this rule's tuition (a live window where
daemons vanished and jobs silently queued); alpha.45 is its first
application. Joins the release ritual beside "promotion is Todd's,
all-or-nothing."

Era note for the 1.0 file: alpha.45 adds a *required* field to
Presence — legal now, and exactly the class of change the compat
procedures (N/N+1 wire) forbid the day the first stranger arrives.
Pre-1.0 liberty is being spent on schema shape deliberately, while
it's cheap.

## PHASE A COMPLETE (2026-08-25)

Hub on sha256:afc05fe3 running alpha.45, twelve posture checks green,
real job sealed both ways, and the edge watch reported in full — 143
probes over 301s, all 401 — restoring the control that had no line
last round. Dashboard Ready, three repos clean, npm latest moved to
alpha.45 by Todd *after* the hub deploy, per the release-ordering
rule's first application. It held.

What shipped, end to end: withheld travels the whole path — daemon
computes, protocol parses, relay stores, Valkey persists, devices
page renders — with the store contract forcing the last step (the
pairing-ceiling lesson working structurally rather than being
remembered).

Design principle minted from the /devices split, CCC's phrasing kept:
**disclosure boundaries are types that diverge, not filters that
subtract.** OfferedDeviceView extending DeviceView would have handed
every teammate the claimant names the moment withheld was added;
"inherit-then-delete works until someone forgets the delete, which is
exactly the shape of the filter that failed open earlier tonight."
The views share a base and diverge — owner gets claimants because
they're choosing between them; member gets kinds alone.

Ops note for the release ritual: verify stamps HEAD, so the working
order is commit → verify → push. The gate was right both times it
refused.

Queue after Phase A, per the ruled pipeline: **Phase B** (the (kind,
service?) wire, with Kevin's feedback folding in), then roster sync
(before anything is promoted as "team sharing works"), then the
gemini/openai CLI backends, then the wizard. Also open: terminal-
"gone" rides the next seam change; 21 ratcheted DB-read casts.

Immediate consequence worth acting on: **the Qwen walk is unblocked
today.** alpha.45 daemons + alpha.45 hub means Todd can write the
services config on the Studio, pair, and hand-allow Kevin via the
still-present local allowlist — which is not a workaround but the
shipped, in-product-documented behavior of this build. Kevin tests
against a real service on the final config shape.

## Phase B step 1 recorded; two scrutiny returns (2026-08-25)

The wire may name a service. The design reduced to the key-versus-
value distinction, endorsed as the formalization NO_PAYLOAD_ROUTING
needed: a *key* resolves through the owner's config or nowhere and
cannot carry description power (even convergent naming across owners
resolves per-owner — sovereignty holds); a *value* means the same
thing everywhere and stays forbidden. Selection permitted,
description forbidden, and an unadvertised name is **refused, never
substituted** — substitution being the decay path from "pick from my
list" to "ask for anything and get something." Amendment D lands in
byollm_009; both spec-guards were satisfied by argument rather than
edit, and the parser learned optionality instead of the spec dropping
its `?` — "editing a commitment to make a test pass, one level up" —
kept as a specimen. The refusal invariant is adopted as law: **a
refusal may deny; it may never assert** — a refusal carries no
envelope and no output, and authoring one is denial by a shorter
route the trust model already grants.

Two returns from review:

1. **Refusal indistinguishability.** Unadvertised and
   advertised-but-not-offered-to-you must present identically to the
   requester — one opaque "not available to you" — or refusal wording
   becomes an inventory oracle (probe names, sort refusals, enumerate
   a device you were never offered). The distinction lives only in
   owner-side surfaces. Same family as redirect-versus-refusal.
2. **The non-goal needs a forwarding address.** Excluding
   terminal-"gone" from refusal-authoring is correct — "gone" asserts
   about history, and no router assertion is backed by an envelope.
   But the ruling stands as product law (a lost job surfaces as an
   answer, not a wait), so "gone" needs its named home: presumably a
   store-derived answer — the store-keeper reporting its own
   emptiness is the one party that can know — designed on its own,
   riding a later seam change. The exclusion must not quietly park
   the requirement.

## Both returns closed, better than asked (CCC, 2026-08-25)

**The oracle was real, and the fix is structural.** Both select
causes had distinct wire values under a comment claiming they
"disclose identically to a stranger" — prose reassuring auditors
while the bytes said otherwise (the comment named as the worse half).
Fix: REFUSED_SELECTION is a frozen constant — no builder takes the
cause, because "a builder is a place to put a branch, and a branch is
where the oracle grows back." The precise cause survives as
SelectionFailure, a type with no schema, for owner tooling only.
Contrast kept as a paired rule: REFUSAL_MESSAGES (owner-side) — four
truths must never share a message; REFUSAL_TEXT (requester-side) —
two truths must share a message exactly. Same project, opposite
requirements; getting them backwards is the live risk.

Kind-level refusals deliberately NOT collapsed, criterion recorded:
the line is whether a requester can walk a namespace. Service names
are unbounded and asker-supplied; kinds are neither, and
awaitingDefault is already member-visible. Collapsing would cost apps
a real distinction — the owner can fix "hasn't chosen"; nobody can
fix "cannot serve you" — and buy nothing.

**"Gone" found its true shape.** Not a tombstone (which "put history
in the party that had discarded it, to be read by the party that
still held it") but a present-tense report: the store says "I do not
hold this job," asserting nothing about history; the site supplies
the history (it enqueued and was acknowledged); absent + enqueued is
terminal, and neither party claims more than it can know. This
handles the motivating case with no special-casing — a flushed
Valkey genuinely holds nothing, says so, and every affected site
learns its work is gone instead of waiting out a deadline. **The
full-flush rehearsal is unblocked by this design.** D.4 is now an
address: a per-job query on the site plane (pending/results are
batch polls with no per-id ask), riding the next change to that
surface.

## Phase B functionally complete; the ruling and two rules (2026-08-25 morning)

Published: alpha.46 (wire + matching), .47 (wizard + codex), .48 (SDK
selection; Todd set latest). Hub on sha256:2a98901e, twelve posture
checks, edge held 144 probes. Selection proven in production:
advertised service runs, unadvertised stays queued — verified against
the deployed hub.

**The proof that passed while the opposite was true, recorded
precisely:** the first selection proof asserted `state === "ok"`
while the state was `claimed`, and its own output showed the
"must never run" job had run. Two defects, one in the check (now
reads `seen`, the device's own record, with a control: if the
advertised name didn't run either, the negative proves nothing) and
one in the run (the hub's pinned SDK predated `service` and dropped
the field — the Lua was never exercised, so selection was never
actually violated in production; the proof was simply about nothing).
The fixed check was validated by running it against .46, where it
fails on exactly what the old one called a pass, and now runs on
every deploy. Third control-needed instance in one night: codex's
canary, the escaped mutation, this.

**Ruling — terminal refusals live with the site's deadline, never on
the wire at enqueue.** Services exist only while advertised;
advertisement rides presence; therefore every selection-failure cause
is entangled with transient absence, and enqueue-time terminality
would make a device reboot fatal to jobs that would have run.
Instead: enqueue accepts, the availability report answers at t=0
("nothing currently serves this selection") so silence never occurs,
and the site's deadline/onNoRunner policy is the sole terminal
authority — only the site knows its urgency. Constraints: the
requester-facing advisory uses the same opaque collapse as
REFUSED_SELECTION (one state for unadvertised and unoffered, else the
advisory is the oracle through a side door), and deadline expiry of
an unmatched selected job carries the same opaque cause — the
post-mortem isn't silence either.

**Rule — SDKs refuse what they don't understand.** An alpha.46 SDK
silently dropped `service`; a JS site believing it was selecting
wasn't, with no error anywhere. From .48 the SDK parses enqueue
options strictly: unknown field throws, never drops.

Wizard refinements queued (Todd's first human run): example name
`my-computer`; "to verify" over "to check it"; codex caution note
removed citing the passed probe; and server discovery by **probe,
not ps** — hit well-known local ports with /v1/models and
multi-select from what answered (byollm_013 applied to onboarding;
cross-platform for free).

## CCC's side-door catch and the strict-enqueue guard (2026-08-25)

Applying the indistinguishability ruling, CCC found the deeper leak
themselves: no-such-service kept distinct from audience-admits-nobody
had been defended as safe "because a site asks about its own users'
devices" — an argument that dies on a team job, where the site holds
capabilities for other people's devices and is free to relay the
reason onward. The RefusalReason collapse defeated by a helpful SDK.
Now one `selection-unavailable`, with a test asserting the two
answers are *equal objects*, not merely similar. The oracle rule's
reach is thereby extended on the record: indistinguishable means
indistinguishable through every relay, because sites repeat what
they're told.

Strict enqueue shipped with a compile-time exhaustiveness guard
(Record<keyof EnqueueInput, true>), and CCC's failure-mode note is
kept: "an allowlist falling behind its type starts rejecting the
field somebody just added, which is worse than the bug it prevents."

Fourth measurement failure of the session recorded (grep -c returning
exit 1 on zero matches, && short-circuiting before the tests ran —
the mutation was fine, the measurement wasn't). Rule minted:
**a harness asserts its own execution** — every mutation/proof run
reports that its tests actually ran (a count, not just verdicts);
a measurement that can silently not-happen is the silent-success bug
pointed at ourselves.

## The devices "bug": Cowork's misdiagnosis, the real cause, and the instrument lesson (2026-08-25)

The owner-view-swap diagnosis was Cowork's, and it was wrong. Real
cause (CCC, confirmed against the running process, not inferred): the
launchd plist set no environment, so the daemon ran with
/usr/bin:/bin:/usr/sbin:/sbin and could not find claude in
~/.local/bin — the health probe failed, claude-cli was never
advertised, and the card correctly showed only the server the daemon
could reach. The hub's owner-view predicate was right all along; the
"missing" mutation control existed and passed. Cowork had the
launchd-environment hypothesis first, then abandoned it on the
strength of `byollm services` — having described that surface as "your
shell's prediction, not the daemon's report" one message earlier, and
then treating it as daemon truth anyway. The card was the honest
surface; the CLI was the flattering one. Recorded with attribution
because the record catches everyone's errors or it catches no one's.

Fixed by CCC: the installer captures the shell's PATH into the plist
(system directories appended); systemd user units get the same
treatment, since fixing only macOS leaves the same bug in a different
hat. Reinstall required once shipped (rides alpha.50). Also landed:
`byollm status` lists every service — idle services name the default
that displaced them, and defaults have their own section — and the
card leads with the service name. The status-mutation harness earned
itself within an hour (a header-rename survivor correctly reported as
a finding, the real mutation caught).

**Instrument rule queued (survives the PATH fix):** a prediction
surface must not speak in the daemon's voice. `byollm services`
either queries the running daemon's actual view or labels itself
("your shell's view — the daemon's is in byollm status"); shell-vs-
daemon divergence has more sources than PATH, and "healthy and will
be advertised" is a promise only the daemon can make.

## Status cleanup ruling + the advertisement question (Todd, 2026-08-25)

Codex resolved: healthy, idle — displaced by defaults for both kinds,
stated in words by the new status display. But Todd's cleanup
observation exposed the sharper question: **"serves nothing right
now" and "not on the menu" are different facts, and no surface states
which is true.** Post-Phase B an idle service must be advertised with
isDefault: false — that is the menu; it is what makes selecting a
non-default service possible at all. Whichever way the wire answers,
a surface is wrong: codex advertised → the owner card (showing 2 of
3) violates owner-sees-everything; codex unadvertised → Phase B
selection is quietly broken for every non-default service and the
card honestly renders a bug. CCC answers from the wire, not the card.

Ruled: **the `routes` section of byollm status is removed** — it is
the old shape's ghost, every row derivable from services + defaults
restated. Three sections describing two facts is how displays drift,
and a display lying while its siblings don't was this morning's whole
story. Status = identity/state, paired apps, services (inventory:
every service, health, kinds, offer, idle-and-why), defaults
(resolution), audience, budgets, history. Wording: "offered to
private" → "private (only you)"; "team" likewise unprefixed.

## Roster-sync MUST amendment: ruled properties (2026-08-25)

CCC's pause-before-build was correct and its proposed wording almost
right — it preserved the real property (the routing party cannot
grant access per job) but left one hole and one bound unstated.
Ruled: CCC drafts the NAMED_LOCAL_ALLOWLIST amendment against four
properties, Todd/Cowork rule on the text:

1. **Admission is decided by a list the daemon holds** — never a
   per-job assertion.
2. **The list is authored and signed by the owner's control plane;
   the relay delivers but can never author it.** An unsigned synced
   roster is a bulk assertion from the routing party — a compromised
   hub editing membership in transit — which silently widens the
   accepted trade from control-plane compromise to hub compromise.
   The daemon verifies against a pinned control-plane key; Amendment
   C's rotation machinery gives that key its succession story. The
   hub retains only the denial it always had (delay, drop).
3. **The local veto subtracts; nothing local adds.**
4. **The held roster has a maximum age (protocol constant,
   ROSTER_MAX_AGE-shaped), and stale fails narrow** — admit nobody
   new; the owner always admits. Staleness is revocation latency:
   the fired-teammate case must not wait on an unbounded sync.

The amendment carries the accepted-trade sentence in plain words
(a compromised control plane can add a member; bounded by the
structural self-lock and community budgets) rather than eliding it,
per CCC's own instinct. C006 is renamed rather than read generously.
The Phase A sequencing drift in this spec is corrected in the same
pass, and the in-product team-gap notice retires with the build.

## The invisible-device incident (2026-08-25 afternoon)

The .51 daemon's heartbeats failed hub schema validation every ten
seconds for hours; the hub logged 400s as ordinary traffic, the
dashboard rendered stale presence as a normal card, `byollm status`
said "state: running" — true and useless — and the only detector was
Todd noticing a missing chip, twice. Third instance today of "the
system knew and no surface said so." A device whose every heartbeat
is rejected is strictly worse than offline: offline renders as an old
last-seen; this renders as a normal-looking card with frozen data.

Fixes ruled, both before Amendment G:
1. **Persistent heartbeat rejection is a STATE, not a louder log.**
   After N consecutive rejects the daemon enters a state that
   `byollm status` renders as its headline ("running, but the hub has
   rejected my last N heartbeats — this device is invisible").
2. **A timestamp rendered without comparison to now is decoration**
   (rule minted). Liveness surfaces derive freshness — online /
   stale / gone — from age; raw lastSeenAt is never styled as status.
   This is the never-seen fix one step further out, as CCC put it.

Queued (operator-alerting lane, open-door list): the hub-side leg —
persistent schema rejects from a *paired identity* are an anomaly
signal, never ordinary traffic.

Process finding: the release-ordering rule should have made this
window impossible; .51 went latest while the hub couldn't parse .51
heartbeats. Whether the hub deploy was wrongly believed complete or
the rule was skipped, the durable fix is mechanical: **the hub
advertises the schema version it accepts, and a pre-promotion check
refuses the dist-tag move when the hub is behind.** The rule has been
paid for twice; it graduates to a check.

Also recorded: CCC's self-correction on codex ("I told you the
reinstall would fix it... I was reasoning from the last bug I'd fixed
rather than from evidence — exactly the thing this morning was
supposed to have taught me") — beside Cowork's morning misdiagnosis,
same day, same lesson, both self-caught.

## Observability fixes in; the gate goes mechanical (CCC, 2026-08-25 evening)

NOT REPORTING shipped as a state that leads byollm status, with the
line CCC rightly defends hardest — "anything below is what this
device believes, not what the hub has been told" — without which a
healthy-looking service list reads as evidence against the warning
above it, when the list is exactly what the hub hasn't heard. Rule
minted from it: **a status surface declares whose knowledge it
shows** — device-belief and hub-confirmed are different facts and are
labelled as such. Threshold six consecutive rejects; PAUSED
precedence (a paused device needs no telling it stopped reporting).

Liveness is now derived and named — online / stale / gone / never /
unknown, stale coloured — and the mystery date from Todd's screenshots
is explained: approved_at had been sitting unlabelled beside a
liveness word, two facts dressed as one. Timestamps are labelled by
what they are.

#4's honest answer, recorded: the release-ordering rule was not
skipped — it was *underdefined*. Three consecutive conscious
wire-or-not calls were made from a model where a registry addition
was not a wire change; the hub's schema validates the registry enum,
so it was. Fix is mechanical and definition-free: /healthz advertises
the accepted backend registry verbatim; ready-for-latest.mjs compares
it against the registry in the published tarball — **sets, not
versions, so the two sides need agree about nothing.** Proven against
stubs and production. Standing instruction: the gate runs on every
promotion including releases believed display-only — belief is the
thing that failed.

alpha.52 ruled: cut it (daemon + card fixes; the NOT REPORTING state
only helps the installed). #3 (hub-side paired-identity reject
anomaly) stays queued in the operator-alerting lane.

## The glm offer bug: partial application is the second implementation (2026-08-25 evening)

Real bug, found by Todd's real offer: `byollm offer` called resolveCost
with two of its three inputs (no model), saw loopback, classified
free — no consent asked, `--cap 2500` silently dropped, `offer:
"team"` written with no spend block. The daemon, asking with all
three inputs, saw the :cloud tag, classified metered, found no
consent, narrowed. Both right about what they were asked. **Rule
minted: a shared rule's signature admits no partial askers** — the
no-re-derivation law was defended against copy-paste and breached
through a signature; optional inputs on a classification function are
two implementations wearing one name. Fix at the signature (model
required) or by consuming the fully-resolved service.

Riders, each its own class: an accepted flag with no effect on the
taken path errors, never vanishes (strict-options extended to CLI
flags); error/notice strings join the one-vocabulary lint scope (the
narrowing message still said "self"); error messages are docs and get
walked like docs (the message named a command without --cap —
following it exactly looped).

Status formatting landed (three lines per service, 68 cols; backend
id beside scope as the same kind of fact — how the service behaves —
model as the recognisable long part). On the :cloud reclass: CCC
confirming where the interim lives before coding — expected answer
per the spec history is that code was metered throughout and the
interim was paper-only, resolved before it became code. Then .52 with
ready-for-latest.mjs run on it, per the standing instruction CCC is
already applying to the release they'd have called display-only.

## alpha.52: gate's first run; consent-wording finding; Amendment G values (2026-08-25 night)

The promotion gate's first production sentence — "the hub accepts
everything this version sends — safe to promote" — produced by a
check rather than judgment, as the standing instruction intended.
CCC's two record items kept: CI caught an environment-dependent test
written hours after CCC named that exact failure mode ("knowing the
rule and writing the code are apparently separate acts, and the check
is what closed the gap"), and the --cap bug's anatomy — one root
cause, three layered defects, each individually invisible; the
signature fix prevents recurrence, the other two are why it stayed
hidden.

**Consent-wording finding (Todd's read of the live ceremony), ruled:**
the offer ceremony interpolates the registry's display label ("Any
OpenAI-compatible server") where the consented-to thing belongs, and
gives the type's boilerplate as the reason — wrong twice. The type
doesn't bill per token (local qwen is the counterexample the same
owner can see); the :cloud tag does. Ruling, under consent-wording-
is-product-law: consent names the specific service (id, model,
endpoint), states the TRUE classification reason (the rule that
fired — here, :cloud → Ollama cloud account), and keeps the ceiling
sentence, which is already right ("up to $25.00 a day, every day,
until you change it"). Mechanism confirmed correct — the spend block
is per-service; prose queued. Registry labels may classify; they may
not be the object of consent.

**Amendment G values (Cowork's recommendations to Todd):**
ROSTER_MAX_AGE = one hour — stale-fails-narrow makes the constant a
trade between revocation latency (removed member keeps access up to
the window) and outage tolerance (a hub incident longer than the
window silently stops admitting team members); one hour bounds the
first at sixty minutes and rides out every incident we've actually
had. Pin-at-pairing = yes — pairing is the ceremony where human
judgment enters (fingerprint read, approval given); the pin anchors
there, Amendment C succession handles rotation; a later pin arrives
over the channels it exists to protect.

## Offer-refusal wording ruled; alpha.53 (2026-08-25 night)

CCC found three defects in the offer refusals (the consent ceremony
itself was already fixed in c6681da): circular advice — the cap
message implied sharing was possible and the subscription refusal ran
second, costing two round trips to the real answer; internal class
vocabulary on a user's screen; and the registry-label-not-service
defect again. Both proposed messages approved with one addition:
the free-class message ends with the exact runnable command
("Drop --cap: `byollm offer my-ollama team`") — error messages are
docs and get walked. The subscription message needs no command;
that is its point.

Two rules minted: **the fundamental refusal runs first** — a fixable
detail never precedes an unfixable fact; and **class vocabulary stays
off user surfaces** — "subscription-class"/"free-class" are spec and
code words; the screen says what the class means ("a subscription
whose terms cover your work," "runs on this machine"). Nobody's
mental model has classes in it.

alpha.53 ruled: cut now — a waiting reader (Kevin's npm README still
teaching the wrong owner in the package's own voice) is the release
trigger; the promotion gate decides the hub question mechanically.
Housekeeping: the Pulumi digest bump is committed by its deployer;
Cowork's spec records ride the next push.

## Ruled (Todd, 2026-08-25 night): the device follows the consent — the site door de-duplicates

Todd caught the two-door friction on the first real cross-user test:
cloud consent (user authorizes the site) and device-side site
approval (owner authorizes the app) demand the same yes twice from
the person who is both. Same disease as the per-person allowlist the
private-or-team ruling removed; same protections make the fix safe
(sites registered + DNS-verified, jobs sealed and inert, budgets,
structural self-lock). Ruling:

- **Cloud route: the device follows the consent.** The owner's own
  consent to a site approves it on the owner's devices — one click,
  both doors. For team services, the offer already said the
  sentence: offering to the team means roster members' consented
  sites may deliver those members' jobs — every edge authorized by
  its own party; a third redundant edge asks nobody anything new.
- **Loud device-side notice** on a site's first delivery ("<site>
  sent its first job here, for <member>") — the C/G pattern: no
  ceremony, two authorities, loud notice. `byollm forget` survives
  as the local per-site veto, the sibling of disallow.
- **Direct mode unchanged** — no cloud consent exists there; the
  daemon's door is the only door and stays load-bearing.
- **Mechanism: Amendment G's machinery, not new machinery.** The
  owner's consents are the same class of fact as the roster — signed
  at authorship by the control plane, delivered but never authored
  by the relay, max-age bounded — on the same synced channel.
  Drafted as the next amendment after G's build lands, against G's
  own properties, with its own accepted-trade sentence.

Interim: today's walk uses the shipped two-door state (byollm
approve) — a counted annoyance with a death date, not a design.

**Correction (minutes later, Cowork's error, confirmed from code):**
the two-door ruling above addressed a door that does not exist.
`byollm approve` acts on a *waiting* queue of direct-mode site
requests; on the cloud route there is no per-site device ceremony —
the daemon serves the hub it paired with, and a site's authorization
IS the consent row ("nothing waiting matches" was the daemon saying
so). The cloud route was already one-click; Kevin's checklist was
complete; Cowork's "step 4" and the amendment plan derived from it
are withdrawn. What survives of the ruling: the **loud first-delivery
notice** ("<site> sent its first job here, for <member>") stays
queued as a worthwhile addition, and direct mode's approve ceremony
stays load-bearing and unchanged. Second unverified-assumption error
by Cowork this week, recorded beside the first; the code was, again,
the honest surface. Minor polish note for CCC: the `byollm sites` hub
row prints id and fingerprint as two identical lines — technically
true, reads as a stutter.

## Roster-sync survey finding + phasing instruction (2026-08-25 evening)

CCC's survey found the load-bearing fact: rosters flow control-plane → hub → relay, but the hub assembles them from rows — the routing party authoring them in bulk, exactly G.1.2's forbidden shape. Implementation is therefore a three-repo lockstep wire change: dashboard signs roster documents at authorship, hub projects, daemon pins (at pairing), holds, verifies, ages, admits. Instruction: **write the phasing against G's four properties first** (draft-then-rule; the artifact everything hangs off), sequenced protocol → daemon → control plane + hub as CCC proposed. Design steer carried into it: **the property is non-authorship, not opacity** — the hub may read rosters (it holds the rows; its filter was always advisory under the both-sides rule); what G requires is that the daemon's admission list arrive signed at authorship so a tampering hub is caught at the device. RELAY_BLIND covers payloads; roster opacity buys nothing the signature doesn't.

## Daemon pass landed; alpha.54 ruled (2026-08-25 night)

isDefault fixed (83ab6cc): hard-coded true on every row, under a
comment whose last sentence predicted the break — Phase B shipped the
menu and left the line. The check asserts both halves (one default
per kind AND the menu intact), because a "fix" advertising only the
default would satisfy the first while deleting selection. Second
self-predicting comment of the week (the USER allowlist's was the
first) — noted: comments that predict breaks should graduate to
checks at writing time. Approve stutter covered by rule, not memory.

Health work (f9d7afc) built to the ruled shape, improved: the paid
canary probes with the CONFIGURED model, so it also catches
account-lacks-access — a second failure class for the same bounded
call. Free leg withdraws after one auth-shaped job failure. Rules
kept from the build: **withdrawal patterns are word-anchored — a
false positive withdraws a working service, worse than the silence
replaced** (includes("not logged in") matched prose a model can
write; caught by CCC's own negative test); and **test call sites,
not just mechanisms** — three surviving mutations shared the shape
(predicate had a corpus, branch had no test; canary flag deletable;
polling loop free to spend), closed by lint because a unit test of
the runner can never see its caller. Incidental logged: missing
timeoutMs renders "within undefinedms" — same genre, minor.

alpha.54: cut — stutters, USER, isDefault, health all reach installed
daemons only by release; gate decides the hub question; Todd
reinstalls after promotion (the plist PATH capture already landed
in .50, so `byollm install` alone suffices).

**alpha.54 closed (2026-08-25, late):** published, gate said promote
(19/19 backends), Todd set latest and reinstalled. His Studio now
runs everything the first cross-user job taught: keychain-reachable
claude, both health legs, honest isDefault, no stutters,
fundamental-first refusals, and no-time-limit refused rather than
mislabeled a timeout. CCC's standing instincts recorded on their
side: predictions become checks (both of the week's cases sat
directly above their bug), and test the call site, not only the
mechanism. Next artifact: the roster-sync phasing doc against
Amendment G's four properties, non-authorship-not-opacity carried
through, doc before code as ruled.

## Ruled: sign-on-read (2026-08-25, closing the day)

G.5's one open decision: **sign-on-read** — the dashboard exposes a
hub-only, read-only, hub-authenticated endpoint; signatures minted on
demand; the hub polls as it already polls. Reasoning ratified from
CCC's own doc: issuedAt is the only honest age anchor (receipt-anchored
age hands a withholding relay the forever-member attack), and once the
anchor is issuance, freshness must be structural — a re-signing cron
is a silent metronome whose slipping narrows and recovers devices in
a rhythm nothing names, and a cron floor equal to the max age leaves
zero margin by arithmetic.

Riders: (1) the fence blesses this explicitly — hub-reads-control-
plane is the sanctioned direction; same reader, new transport, not a
new crossing; read-only and hub-authenticated keeps the ledger clean.
(2) The bad hour is a STATED hour — hub keeps delivering the last
valid document through sub-hour dashboard outages; the daemon holds
and ages as designed; and a device that narrows says so ("roster
stale — serving owner only until refreshed"), never a silent shrink.
(3) The roster key inherits Amendment C's succession law — pinned at
pairing, rotated by the existing ceremony, no bespoke treatment.

Phase A builds on this word; lockstep applies; C006 rename and the
in-product notice ride Phase B as phased.

## G Phase A built (fc18631); the unsigned-field attack (2026-08-25, late)

Shipped: ROSTER_MAX_AGE_MS, SignedRoster, sign/verify with their own
domain separator, both wire fields; all three riders in G.5.

**Rule minted from the fifth self-catch — the first live hole:**
dropping `owner` from the signed statement passed every test, because
the explicit owner check read the very field it protects — unsigned,
relay-rewritable. Alice's roster, owner rewritten to dave, delivered
to Dave's devices: comparison matches, signature verifies, Dave's
machines serve Alice's teammates — the bulk-authorship attack alive
inside G's first implementation. Fixed (owner inside the signature)
with the catching test. Law, generally: **everything a verifier
trusts lives inside the signature — the statement signs what the
check reads, completely.** "Signature valid" without "valid over
what" is the flattering half of cryptography.

Deploy-order constraint, recorded as progress: strict response
schemas make roster safe-to-add, unsafe-to-send-early — a .54 daemon
receiving it fails the whole parse and stops heartbeating for reasons
naming nothing. Phase C deploys one way: publish → daemons update →
hub sends. Third appearance of the schema-window class — .44 and .51
as incidents, this one as a constraint with tests in both directions
before anything shipped. The class moved from suffered to pre-empted.

Phase B (daemon pins, holds, verifies, ages) proceeds on G + riders,
no ruling needed. Reconcile summary-log fix with CCC (Todd can't
copy the cron secret; the report stays unread until the log line
lands — the right fix anyway).

## Morning after B1 (2026-08-26): two ratifications and a contradiction to resolve

B1 shipped (32fbfef) as the safe half: pin at pairing, hold, verify,
age, all visible; admission flips in B2 when Phase C makes the
sentence true (C006 rename and notice retirement moved there —
correct, claims ship with their proof). The veto finding recorded:
today's allowlist is purely additive and disallow removes an allow,
so "the veto subtracts, nothing local adds" requires a deny list
that isn't that list — built as such.

**Ratified into Amendment G, with their mutations:** (1) a refused
roster does not replace the held one — else a relay narrows a device
on demand, the accepted denial sharpened into targeted membership
removal; (2) an older document is not an update — else a relay
replays yesterday's membership over today's inside the age window
with a perfectly verifying signature; issuedAt is monotonic per
holder. Siblings of the unsigned-field law: the signature proves
authorship; these prove sequence and survival.

**Contradiction flagged as the first act of the onboarding day:**
CCC's overnight observation ("a new cloud user compares a fingerprint
twice… the second — site to device via byollm approve — is what
refused Kevin's first job") contradicts CCC's own conclusive
investigation of that refusal (no route because no consent — the RLS
bug; approve had nothing waiting; no per-site device ceremony on the
cloud route; one consent click made pong flow with no approve ever
run). Both accounts cannot stand. To resolve from evidence before
any simplification design: show the refusal that stopped Kevin's
first job, and show whether an awaiting-consent state can occur for
a cloud-routed site. The answer decides whether the withdrawn
device-follows-consent ruling stays withdrawn or revives as real
work. Docs fixes from the night recorded: the reference page carried
the owner bug on the page meant to be pasted into a coding assistant
verbatim — fixed; Phase B selection documented at last; glossary
gained the own-id entry.

## Contradiction resolved by firsthand testimony (Todd, 2026-08-26 morning)

Todd's account of the walk settles it: consent (dashboard, post-RLS
fix) → the hub THEN offered press to the daemon → byollm sites showed
it → byollm approve succeeded → then the claude/keychain failure and
the default switch → pong. **The per-site device ceremony exists on
the cloud route, ordered after consent.** Cowork's withdrawal was the
error — "nothing waiting matches" during the pre-consent attempts
meant nothing had been OFFERED yet, not that no door exists; an empty
queue read as a nonexistent queue, the evidence-of-absence class,
fourth instance, by its own chronicler. CCC's overnight fingerprint-
pair observation is vindicated.

**The device-follows-consent ruling UN-WITHDRAWS, with better
evidence than it originally had:** two ceremonies ask the same person
the same question and the second cost the first walk a round. Revived
as originally shaped, on Amendment G's real machinery — the owner's
consent delivered to the daemon as a signed control-plane fact on the
Phase C channel, loud first-delivery notice, byollm forget as the
local veto, direct mode's ceremony untouched and load-bearing there.
This is onboarding item #1 for today, Amendment-H-shaped, drafted
against G's properties once C lands.

*Completing the file (2026-08-26): the primary evidence was a named
refusal — Kevin's retry came back `this device has not approved
site…`, seen live by CCC, which disproved Cowork's withdrawal in
real time; the overnight observation already reflected that
corrected view. The refusal did what refusals were taught to do this
week: name the truth loudly. Phase C proceeds, starting where the
wire meets the relay.*

## Phase C: two of three halves (2026-08-26 morning)

alpha.55 published — A + B1 + the relay half; no behavior change,
nothing sends rosters, the daemon still states the allowlist truth at
load. Latest is safe to set NOW (the hard rule binds the hub's later
roster-sending deploy, pinned as tests both ways, not this
promotion).

**The relay half's design is the amendment made structural:** two
lists — the advisory copy the relay routes on, and the control
plane's signed statement carried untouched — with a carriage test
that makes them disagree on purpose (the routing copy names someone
the signed document doesn't). Non-authorship as a test fixture.

**The control-plane half's best refusal:** an unconfigured signer
answering {rosters: []} would tell every device every team is empty,
and they would narrow within the hour BELIEVING it — fail-narrow
poisoned by an honest-looking answer. It refuses loudly instead.
Empty and unconfigured are different truths; only one may route.

**Rule minted: a mutation must be deterministic or it measures
nothing** — CCC's third mutation was flaky enough to pass by luck,
and "a flaky mutation reports covered exactly like a real one." The
harness-asserts-execution rule's sibling: the instrument's own
variance is part of the measurement. Also: the call-site class
recurred twice more (heartbeat roster lookup → undefined, 162 green;
pair response key removed, 163 green — every roster test started
already-paired); both now drive real exchanges. The lint from last
night plus real-exchange tests is the standing answer.

Todd's two actions: latest → .55; mint the roster keypair (his
secret ritual; script single-use by design). Hub half proceeds
unconfigured meanwhile — remainder of the current build, not a
second workstream.

## Phase C complete, unconfigured (2026-08-26)

Hub half (5a65d14): fetches, holds, authors nothing. Ratified: the
one-minute poll — cadence buys margin against the age bound, not
freshness (signed-on-read made freshness structural); 60× margin at
1/400th the requests of 2s. The failed-fetch-never-clears rider built
and mutation-checked both paths. The database reader returns
signedRosters: [] with a why-comment (assembling there = the hub
authoring) — **graduation suggested per the predictions-become-checks
rule: a lint asserting hub code never imports signRoster; carry and
verify only.** Rule minted from the caught test: **an instrument that
doesn't touch the thing it measures reports success identically**
(Object.assign onto a private field, passing while exercising
nothing; rewritten as swappable fetch, two polls, one instance —
mutations bite only against that version).

Todd's configuration run-book: mint (with the root-dep resolution
fix), env:push, then — before pulumi config + hub deploy — **confirm
no live daemon below .55 anywhere** (the .strict() hazard protects
every paired daemon; Kevin's test machines included; a message
closes it). After deploy: B2 (admission flip + deny-list veto)
unblocks, then Amendment H on the same channel.

## ROSTER SYNC LIVE END TO END; the migration ruling (2026-08-26)

The chain works: control plane signs on read → hub fetches with its
bearer → carries untouched → daemons verify against the key pinned at
pairing. Three failures on the way, each recorded with its lesson:

1. **The roll smoke assertion** (offered.length !== 1) — a fixture
   fact encoded as a wire property; Todd's press consent legitimately
   gives the smoke device two keys. Fix: membership-not-count.
2. **The real bug:** /api/hub/rosters (bearer, no session) redirected
   to /login by the dashboard guard — the hub handed HTML, logging
   Unexpected token '<'; every device would have narrowed in an hour
   naming nothing. The redirect-vs-refusal comment sat directly above
   the line. **Third comment-predicted bug in two days — conform now
   checks the property: a route comparing a secret in constant time
   expects no session, therefore its path must be public.**
   Mutation-checked. The prediction graduated at last.
3. **B1 was three unwired links** — connect never wrote the key, the
   run loop never read it, the held roster never landed where status
   (a separate process) could see it. A correct, well-tested
   implementation doing nothing on a real device: "mechanism covered,
   every caller not — the rule I minted yesterday, broken by me
   today" (CCC). Fixed ec056b6; status now speaks the stale-narrowing
   sentence the one-hour bound exists for. Found by Todd's real walk,
   again.

Also from the configuration leg: the mint script rebuilt on
node:crypto per the documented convention one file over (CCC:
"I violated a documented convention sitting next to me");
--check shipped and passed first; the format contract moved to a
cross-repo test, which caught a FALSE negative — a flaky assertion
(base64 vs base64url differ only when bytes contain + or /) claiming
a failure mode Node doesn't have. **Two rules kept: a negative needs
verifying before it's written down, exactly like a positive; an
intermittent test is a wrong test until proven otherwise.** And the
Pulumi mapping gap (config accepted, mapped to nothing — healthy hub
carrying no rosters, diagnosed four layers away) caught before the
mint: the only-fails-when-real class, now wired, public key
deliberately NOT a Secret ("hiding it would say it's something it
isn't").

**Migration ruling (Todd's find: install didn't set the roster):**
every pre-G pairing lacks the control-plane key — the key is offered
only in the pair response, so existing devices are silently unable to
hold rosters. Ruled: **option 1 now** — install and status say
"this pairing predates roster sync; byollm connect to enable team
routing" (a notice, within the loudness laws, no amendment needed);
**option 2 later with its boundary drawn today** — byollm repair
re-runs the FULL ceremony including dashboard approval (fresh code,
human fingerprint moment); keeping pins means continuity, never
bypassing approval — a repair that fetches the key without a human
is option 3 in a trench coat; **option 3's rejection ratified**
(G's own rejected alternative). install stays install: folding a
pairing ceremony into upgrades would be hostile, per CCC.

Operational note for open-door: the rollout recreated the Valkey pod
(~2min ECONNREFUSED, self-healed) — a deploy briefly drops
routing-state connectivity; examine before real traffic.

Todd's next walk step: re-pair the Studio (byollm connect) to pin
the key — which also walks option 1's notice the moment it exists.

## Pre-.56 close-out (2026-08-26)

Todd's empty roster status explained honestly: the re-pair was
correct against a hub that offers the key — but the .55 daemon's
storing wire is unreleased, so it dropped the offer on the floor.
Expected, not a bug; the release boundary is the missing link. .56
ruled cut before B2 — a verifiable roster on a real device before the
thing that depends on it.

Keepers: (1) the smoke assertion now checks membership plus
every-offered-key-is-a-self-consistent-identity — preserving what
the count was reaching for (catching an unverifiable upstream
insertion) without encoding how many consents Todd happens to have.
(2) **The option-1 notice fires on evidence, never a guess:** the
daemon can't know whether an upstream has a control plane, and a
standing roster line on every direct-mode pairing would be wallpaper
— the trigger is "this upstream sent a roster AND this pairing holds
no key," which can only mean the pairing predates it. Notices earn
attention by firing only when they know. (3) **no-pinned-key
unfolded from bad-signature** — bad-signature describes a
verification that never happened and sends someone hunting a
forgery, and no-pinned-key is the only refusal with a remedy;
collapsing them lost the actionable sentence. The refusal laws'
two sides navigated correctly in one change: requester-facing
refusals collapse (disclosure); owner-facing refusals split by
remedy (action). A mutation proved the split worth its own test.

Todd's sequence on publish: latest → byollm install → one byollm
connect → status shows a signed roster of 2 held. Then B2.

## Roster held on a real device (2026-08-26); the fourth link; a composition question before B2

.56 verified from the published tarball (all five B1 pieces in the
artifact installed, not the commit). Todd's status shows the chain
live: "a signed roster of 2 is held, under a minute old — it does not
decide yet; this device's own list still does" — the
claims-with-proof discipline living in a parenthesis.

**The ordering bug, found by Todd running connect→install against
instructions:** a daemon started before connect wrote the key kept
refusing rosters it had the key for, and overwrote the file's good
state with its stale refusal every heartbeat — "a re-pair that
worked, undone once a second by the process it was for." Fixed
(1afce6f): the key reaches the running loop through the shared file,
like approvals — **adopted only when none is held**, because a key
replaceable from disk is a downgrade path (anything writing the file
could swap the authority this device checks rosters against). The
file is transport; first-write is the pin; the ceremony stays the
only door. Both directions mutation-checked. Fourth one-line unwired
link, all four the same shape — two correct processes, nothing
carrying a fact between them; three found by walk, one by instinct;
the source-level check now covers all four.

**Composition question raised before B2 flips:** the roster counts 2
("you and Kevin") and the team's story has 3 — Lis accepted by email
(A2's wild proof) and rode the resubscribe. Verify who the signed
document NAMES, not the count, while it's advisory: a member
silently absent becomes a refusal the moment B2 makes the document
decide. Todd ruled: B2 now, then .57 with everything folded.

## Composition resolved; first-person rule's second instance (2026-08-26)

The roster is CORRECT, read by name from the signed document: owner
tsampson, members Kevin and Lis. Owners are never in their own member
list — a three-person team yields a two-member roster; "2 of 10
seats" counts seats sold, the roster counts people who may route to
the owner's devices. Same fact, two frames. The earlier "you and
Kevin" reading was wrong; B2's document admits Lis and carries no
redundancy. B2 unblocked.

**The duplicate was real — the first-person-filter rule's second
instance in two days, wider blast (b41a866):** "Teams you are on"
filtered by role !== admin and nothing else — two teammates, two
rows, your own group listed twice with Leave buttons; the rosters
page variant would have shown a co-admin's roster as their own.
Connections needed a platform admin; this needed only a teammate.
The broad memberships read is correct (every member may read the
group) — the defect is always the reader filtering by role and
forgetting the person. Kept for permanence: **tsc stays green with
the ownership predicate deleted** — no type or lint catches
"filtered by role but not by person"; the predicates are extracted
and tested as rules, signed-out pinned (empty-string viewer matches
NO row, never every row).

Go: B2 finishes (C006 rename + in-product notice retiring in the
release whose flip makes the sentence true), then .57 with the
ordering fix folded, gate deciding the hub question as always.

## B2 shipped in .57; promotion gated on one probe (2026-08-26)

B2's design recorded in CCC's words: with a key pinned, the roster
admits minus the local veto, nothing local adds; stale-or-absent
narrows to owner; without a key, the per-person allowlist decides —
"not a fallback but the other half of the design." **The veto is a
new list, not a missing row**: where a roster decides there is no
allow entry to remove, and "removing nothing would have reported
success while the person went on being served." C006 keeps its id
with the true title; the notice retires in the release whose flip
makes its opposite true. Three mutations caught: allowlist widening
a roster, veto ceasing to subtract, stale falling back instead of
narrowing.

**Promotion gate:** Todd's .57 status shows "nobody else" AND
"(2 more, from a roster…)" — contradiction; if display-only, promote;
if the flip isn't engaged, stop-ship. Ten-second probe: `byollm
allow` must REFUSE and point at the team page. Evidence before
latest, per the house rule.

**The superseded-code finding (Todd's early walk):** a second
pair-start replaces the first code by design (mistyped-code
recovery — correct), but the first terminal keeps displaying the
dead code, counting down its ten minutes — "correct behaviour,
silent about it," the day's shape. CCC verified replacement is
scoped to one keypair. Ruled: .57 ships with the already-paired
guard; **option 1 for .58** — the abandoned terminal's poll notices
its code is gone and says so ("this code was replaced by a newer
one — check your other terminal"); option 2 (hub refuses the second
start) rejected because it breaks the deliberate recovery path to
fix a messaging problem. Riders still open in the same output: the
pinned rows remain unlabeled; the run-summary denominator (4 vs
3+1+1) remains unfixed — both queued.

**STOP-SHIP (2026-08-26): the promotion probe failed.** On Todd's
.57 install — key pinned, roster of 2 held — `byollm allow` did not
refuse; it began the old consent flow, and status renders "nobody
else" as the operative answer. Evidence: the flip is not engaged on
a real machine. Latest holds at .56. Hypothesis for CCC to verify,
not assert: the fifth unwired-caller of the week — flip and
allow-guard correct as mechanisms, CLI and loop not wired to reach
them — with the added question of why the source-level check built
for this class didn't fire. Precision kept: the paste doesn't show
whether allow completed or awaited confirmation; refusal was due
before any consequence text either way. If an entry recorded for the
probe address, cleanup once fixed. The gate worked exactly as
designed: ten seconds of probe spared a promoted release whose
headline feature wasn't reachable.

*Stop-ship evidence completed (Todd, minutes later): the allow ran to
completion — y/N prompt, confirmation, "allowed … on
hub.byollm.cloud" — and status now lists the new entry as operative
("toddsampson2008@… on hub.byollm.cloud") with the roster still
parenthetical. The allowlist governs; the roster decorates; the flip
is dark, confirmed by two surfaces and a state change B2's design
forbids. Clarified for the record: the team page not showing the
entry is CORRECT — the roster and a device allowlist are different
lists and were never meant to sync; the confusion could only arise
because the bug let a forbidden state be authored. The probe entry
stays in place as diagnostic state until CCC has read the specimen;
cleanup after the fix. Incidentally confirmed live in the same
screenshot: Connections and Docs shipped into the nav.*

### Ruling clarification: local allow vs the seat limit (2026-08-26)

Todd asked what `byollm allow` does on the cloud route, and whether it could admit
users beyond the subscription's seat limit. Recording the answer because it sharpens
what the stop-shipped bug actually is.

`byollm allow <site> <user>` is direct-mode law: the device-local allowlist, the whole
admission mechanism for OSS sites that never touch the hub. On a hub-keyed site it must
refuse (B2), because Amendment G property 3 — "veto subtracts, nothing local adds" — is
the billing boundary as much as the trust boundary. The roster is authored by the
control plane, and the control plane authors it from the subscription; the seat limit
is enforced at roster authorship, nowhere else. If a local allow can admit on the cloud
route, it admits a user the subscription never counted — an unmetered side door around
the team size limit.

So the unengaged flip is not just a ceremony error. On alpha.57 as it stands, a device
owner can admit arbitrary users on hub sites past any seat cap, with no billing
counterpart. This upgrades the stop-ship's severity framing: the probe entry
(toddsampson2008@gmail.com) is a live demonstration of a seat-limit bypass, not merely
a wrong prompt. The fix restores both boundaries at once, because they are the same
boundary.

### Amendment I — one admission law: devices approve sites, authorities govern users (2026-08-26)

Todd, reacting to the seat-limit clarification: "I think we may have our design wrong.
I could see someone having multiple relays with their own users — one of which is hub.
But I don't think local allow for users makes sense. Can you imagine if github and git
worked that way?"

The analogy holds and the deeper reason is already in our own law. A git client makes
one trust decision: which remotes it has. Who may push is GitHub's decision, made in
GitHub's namespace, enforced where the namespace lives. No git client keeps a local
list of allowed GitHub users, because the client has no way to know who those users
are — it would just be trusting the server's per-request claim.

That is exactly what `byollm allow <site> <user>` always was. The daemon cannot verify
a foreign site's user identities; a local allowlist entry admits whatever the site
asserts per job about who the user is. Amendment G property 1 outlawed per-job
assertion for the cloud route — the direct-mode allowlist was the same thing wearing
an allowlist costume. The user-granularity was illusory: against a dishonest site it
gates nothing, and against an honest site it second-guesses the one party who actually
owns the namespace. The enforceable trust decision was always the site.

**The law.** One admission chain, every route:
1. The fundamental refusal runs first (unchanged).
2. The site is approved — the pairing/approve ceremony, key pinned at pairing. This is
   the device owner's grant, and the only additive grant a device owner has.
3. If the site's pinned authority publishes a roster (a relay with a control plane —
   hub is the first instance, not a special case): the user is in the signed roster,
   under G's four properties, held per-relay.
4. The user is not vetoed. `byollm disallow` survives as the uniform subtractive
   control on both routes. Recorded with its trust status: a veto binds a name only as
   strongly as the authority that asserts it — real against a signed roster, honest-site
   policy in direct mode.

`byollm allow` is removed entirely — not refused on hub-keyed sites, gone. It leaves a
tombstone with remedy (owner-facing refusals split by remedy): devices approve sites;
sites and relays govern their own users; `byollm disallow` still vetoes.

**Relays generalize.** Multiple relays, each with its own users and its own pinned
roster key, is the intended shape; nothing in admission may hardcode hub's identity.
Pin-at-pairing (already ratified) is what makes N relays safe: the roster authority is
whoever was pinned when this site was approved.

**Effect on the stop-ship.** The dark flip dies with the branch it lived in. B2 tried
to route hub-keyed sites to a second admission law and left the router unwired — the
fifth unwired caller. The remediation is no longer to wire the branch but to delete
it: with one law there is no flip to leave dark, and the seat-limit boundary becomes
structural (nothing local adds — now with no command that could even try). CCC still
owes the diagnosis lesson: why the source-level call-site check did not fire. Every
lesson becomes a check, and that lesson survives the redesign that mooted the bug.

**Effect elsewhere.** Amendment H strengthens: `byollm approve` is now the sole device
grant, which is also what cloud_015 wanted — onboarding loses an entire class of
per-user steps. Migration is pre-1.0 liberty, but existing allowlist entries retire
loudly on the notices channel, never silently; Todd's probe specimen
(toddsampson2008@gmail.com) rides that retirement. Status's "who can use this device"
becomes: you, always; then per approved site — for rostered relays, the roster count
with its signing age, minus any "refusing …" rows; for direct sites, the site itself.

### Amendment I, rider: CLI add-user as a client of the roster authority (2026-08-26)

Todd: "We made the relay open source for this reason. I can see the CLI allowing you
to add a user to a hub you are a member of."

Recorded as the completion of the git analogy. `gh` can add a collaborator — but it
does so by calling GitHub's API, never by editing a local list. The convenience lives
in the client; the authority stays where the namespace lives. Same here:

- The command is a control-plane client, not admission machinery. It writes nothing
  local and the daemon never sees it. It calls the relay's roster API, authenticated
  as the person (their cloud identity — the device's pinned keys play no part; two
  credentials, never mixed), and the change reaches devices only as a newly signed
  roster through G's ordinary channel. "Nothing local adds" survives untouched — the
  add is not local.
- Two doors, one law. The CLI does exactly what the team page does: same API, same
  authorization, same refusals split by remedy (over seat cap → upgrade; not
  authorized → ask the team owner). The door count may grow; the law count may not.
- Authorization is role, not membership. Being on a team does not confer the right to
  add to it — owners/admins add, per the relay's own rules, enforced at the API. The
  seat limit is enforced there too, as always, at roster authorship.
- It targets a relay, plural-ready. "A hub you are a member of": defaultable when
  there is one, explicit when there are several, fails closed on an unknown name. The
  open-source relay is the point — anyone's relay, own namespace, own signing key,
  pinned at pairing; the command hardcodes nothing.
- Naming stays away from the corpse. It must not be `byollm allow` reborn — the
  tombstone may not point at a near-twin that silently acts remotely. It is the team
  page's CLI twin and should read that way (e.g. under a team/hub noun).

Build order: design recorded now; the build rides after the Amendment I remediation
lands, naturally alongside cloud_015's onboarding work. Auth mechanics for
person-level CLI credentials (keychain, connect-flow assertion, or login ceremony)
are CCC's to propose when it's picked up.

### Amendment I, second rider: the veto moves too — daemon holds no user-level state (2026-08-26)

Todd: "I think disallow goes away too. You can't veto a github user for your repo
locally."

Correct, and the analogy again shows where the capability goes rather than deleting
it. GitHub has blocking — but you block at GitHub, and GitHub enforces it. The veto
is not removed as a capability; it moves to where the namespace lives. The control
plane authors an owner's blocks into the roster it signs for that owner's devices:
the roster arrives already subtracted, inside the signature. mayRunFor already reads
rosters per device owner, so this is the existing document shape — no new type, the
subtraction just happens at authorship.

What this buys:
- The daemon holds zero user-level state. Site approvals and pinned keys only.
  Admission on a rostered relay is now one question: is the user in the signed
  roster. The daemon becomes a pure verifier.
- The unsigned-field law is finally fully satisfied on this surface. A local deny
  list was a thing the verifier trusted that lived outside every signature —
  tolerated under G because it only subtracted. Now nothing local adds OR subtracts.
  G property 3 is amended accordingly: the signed roster is the whole answer.
- The split-brain surface dies. Status's "refusing …" rows showed local knowledge
  the control plane couldn't see; a status surface declares whose knowledge it shows,
  and this one now shows only the control plane's, labeled by its signing age.
  Blocks appear on the team page (and its CLI twin) — one source of truth, two doors.
- B2's deny list, built days ago, is deleted along with the flip. Pre-1.0 liberty;
  both retire loudly on the notices channel.

Direct mode: no per-user controls of any kind. A direct site is its own user
authority — approve the site or don't; take a user complaint to the site, or
`byollm forget` the site. Same as git: you cannot locally veto a user of someone
else's server.

Emergency brake, recorded honestly: blocking at the control plane requires the
control plane. If the hub is unreachable, a held roster keeps admitting until stale
— bounded by ROSTER_MAX_AGE_MS (1 hour). The immediate local remedies are site-level
and total: `byollm forget`, or stop the daemon. That is the trade: per-user control
is the relay's, on the relay's availability; the off-switch is the owner's, always.

Tombstones now cover both commands: `byollm allow` and `byollm disallow` each point
at the team page / CLI twin. The re-probe on Todd's machine updates once more: both
commands must hit their tombstones; a block placed on the team page must reach the
device as a smaller signed roster and show in status as such.

### Amendment J — the roster was a cache: per-job signed admission (2026-08-26)

Two rulings from Todd, the second one large.

First, closing the block question: "We don't need that. Each owner has their own team
and only shares their devices. So keeping a user on my team without access to my
devices lets them do nothing." Block == removal, and not as a v1 simplification — as
structure. A team IS access to its owner's devices and nothing else, so
"member-but-blocked" is not a deferred feature, it is an empty state. Owner-scoped
blocks are deleted from the design space entirely.

Second: "If the hub routes you something you should just run it, right? We shouldn't
need a copy of roster locally at all? If we add or remove a user to hub, or someone
else adds them to a relay, it should just work or stop working instantly."

Yes — and the reason it's safe is worth stating precisely, because Amendment G
property 1 said "never per-job assertion" and this looks like per-job assertion. It
isn't the thing G outlawed. G outlawed trusting the *relay's or site's unsigned*
per-job claim. What replaces the roster is the *control plane's signed* per-job
admission: at claim time — where we already gate consent by routeKey — the hub
attaches a signed grant to the job: site, user, owner, job id, issuedAt, short
expiry. The device verifies it against the key pinned at pairing and runs. Everything
the verifier trusts still lives inside a signature; the signature now covers one job
instead of a membership window.

The held roster was a cache, and the cache bought nothing. On the cloud route the job
path and the roster path share fate: jobs enqueue through the hub, so if the hub is
down there are no jobs to admit — a locally held roster adds no availability, only
staleness. And staleness was the whole cost: ROSTER_MAX_AGE_MS existed to bound how
long a removed user kept running. With claim-time grants the bound collapses to the
grant expiry — add a user and the next job works; remove them and the next claim
fails, including jobs already queued, because the grant is authored at claim, not at
enqueue. Instant in both directions, which is what Todd asked for.

What survives of Amendment G — the properties were right; the mechanism moves:
- The trust root: pinned-at-pairing control-plane key. Grants verify against it.
  N relays each sign their own grants with their own key; nothing hardcodes hub.
- Relay delivers, never authors. The relay cannot forge a grant; RELAY_BLIND intact.
- The unsigned-field law: the grant is self-contained; nothing outside its signature
  is trusted, including anything the site or relay says about the user.
- Monotonicity/refused-document reasoning becomes replay protection: a grant binds to
  its job id (single-use at the device) and carries a short expiry.

What dies: the daemon-held roster, sign-on-read, /api/hub/rosters polling,
ROSTER_MAX_AGE_MS, first-delivery notices, the roster parenthetical in status. The
B1/B2 sign-on-read machinery, live for under a week, retires with it — the build is
sunk but the properties it proved carry straight into grants (author-side signing,
pinned verification, deploy-order lesson all reuse). Pre-1.0 liberty; loud
retirement on the notices channel.

Status surface consequence, ruled by existing law ("a status surface declares whose
knowledge it shows"): the device can no longer display who *would* be admitted — it
never knows that anymore. Device status shows the device's own knowledge: approved
sites, pinned authorities, recent jobs and their grant verdicts. Membership is the
team page's knowledge, and status points there. "Who can use this device" becomes
"you, always; and whoever <relay> admits for approved sites — see your team page."

Consolidation note for CCC: consent gating already happens hub-side at claim
(routeKey). Membership now checks there too. One signed claim-time grant can carry
what three mechanisms did — consented, member, admitted — one signature, one verify
at the device. Design space is CCC's; the law is that the grant is control-plane
signed, claim-time authored, job-bound, short-lived, verified against the pinned key.

Direct mode: untouched. No hub, no grants — site approval is the whole law per
Amendment I.

### Amendment K — the daemon's four verbs; per-user resolution; the BYO-compute story (2026-08-26)

Todd ratified moving site approval (and all people/site policy) to the relay's control
plane, in his words: "pair with relays, offer services, cap spend, pause feels so
right to me." That sentence is now the daemon's whole local law and should be treated
as spec language. `byollm approve`, the offered-sites queue, and the per-site local
state retire with it (cloud route; direct mode keeps its pairing-per-app shape, which
is the same verb). The defense-in-depth trade is recorded as accepted: site policy
now moves at account speed, and the retained machine-side root is the pairing
ceremony itself — plus one mitigation, reusing the first-delivery pattern
legitimately: the first grant naming a site this device has never served fires a
notice ("now serving <site>, enabled from your dashboard"), so account-driven change
is always loud at the machine. Notices fire on evidence — the grant is the evidence.

**Per-user model selection.** Todd's probe at where sharing falls down: he needs
llm.generate = claude for himself, qwen for Lis via the same site, and the site needs
a fallback for everyone else — "the site needs to know to call qwen-14-4b only for
her." It doesn't, and the reason is that selection was already audience-scoped; it
just needs to resolve per user:

- The candidate set is per user by construction: what's advertised to a user is the
  union of services offered to them across every device that mayRunFor them. Todd
  sees claude (private) + qwen (team); Lis sees qwen only. If the site enqueues
  llm.generate with no service name, Lis's set has one member — she gets qwen with
  the site knowing nothing. Offer scoping IS the per-audience routing.
- Resolution therefore moves hub-side, and necessarily so: a user with their own
  device AND a team share has candidates from multiple devices — no single device's
  `defaults` block can see that set, so per-user resolution cannot live in device
  config on the cloud route. It happens at claim, where everything else now happens.
  Order: one candidate → it; several → the user's own preference (a byollm.cloud
  account setting — "when several services can serve a kind, prefer X"); none set →
  loud refusal to the site under the existing ambiguity law (withheld, carried not
  inferred). The owner's device `defaults` remain law for direct mode and for the
  owner's own machine-local resolution — they no longer speak for other users.
- The grant carries the resolution: (kind, service) arrives resolved and signed; the
  device verifies the named service is one it actually offers at a scope that
  includes this user, then runs. Selection is the hub's; offer-consistency is the
  device's. Key-vs-value law untouched — sites may still select by advertised name,
  they just never need to.
- "Locks one model for the team" is thereby false in both directions: one team
  service → members get it automatically; several → each member's own preference
  picks, per member, no site involvement.

**Fallback for users without byollm.** The site's branch, already in the design:
a user who never connected has no assertion — site uses its own API. A connected
user with nothing capable online gets the availability advisory at t=0 / terminal
refusal at deadline — site falls back then. Refusal indistinguishability holds; the
site learns "unavailable," never why.

**The story, per Todd (recorded as given).** Eric's coaching-management app wants
each of HIS users to bring their own compute so Eric never pays for, marks up,
limits, or thinks about inference — the user decides their own spend. "If they do
that on two or more sites they need pro." Developers wanting their own compute
across their own sites are the second pro case. So the primary product is
BYO-compute per user (free: one site; pro: many), and sharing is an overlay for the
Lis/family/team case — consistent with demoting the Teams branding to "sharing."
Open question, not ruled: what plan gates sharing your devices with N other people,
now that per-user pro, not team seats, is the primary meter.

### Amendment L — site need manifests and user-authored mappings: the mapping is the consent (2026-08-26)

Todd, on learning K's resolution model assumed few candidates ("I'm actually
advertising qwen and soon glm. I plan to offer a bunch more"), proposed the missing
piece: sites declare what they NEED; users map needs to services at signup.

The manifest: a site declares its needs as purposes, each listing kinds —
`{ "writing_assistant": ["llm.chat","llm.generate"], "revenue": ["llm.generate"],
"advertising": ["llm.generate","llm.image"] }`. A site with no purposes declares a
flat kind list, which is sugar for one site-wide purpose. Declared at site
registration, so the consent page can render it.

The mapping: at signup, the user fills each (purpose, kind) slot from a pulldown of
the services available to them — their own and team-shared, e.g. "Your llm.generate
(Claude)" or "Team toddsampson/qwen-14-4b". A slot with exactly one candidate
auto-maps and shows no control ("and only 1-to-1" — Todd's rule, and it is the
existing ambiguity law wearing its consent clothes: choice is authored, never
inferred, but a set of one is not a choice). The mapping lives at the control plane,
per (user, site); grants carry the resolved service exactly as in K; the device
verifies offer-consistency and runs. K's global account preference is superseded —
preference was always per-site and per-purpose, and now it is authored where it is
scoped.

**The disclosure win, larger than the problem it solves.** The site's vocabulary is
now its own purposes; the user's vocabulary is their services; the control plane
joins them. Sites never see service names at all — the capability-row surface that
exposed advertised names to sites retires on the cloud route, and with it the
site-selects-by-name path (Phase B's cloud surface, superseded a week after
shipping; pre-1.0 liberty, noted plainly). Key-vs-value law reaches its strongest
form: the site cannot describe OR name; it can only ask for what it declared.
Refusal indistinguishability improves too — a site learns "slot satisfiable or
not," never why. Direct mode is untouched: no control plane to hold a mapping, so
OSS keeps Phase B selection and device defaults as shipped.

Ratified laws riding with this:
- The mapping is the consent. Authorizing a site and wiring it are one act on one
  screen; the consent page shows exactly which of your services each site purpose
  will drive. Consent wording remains product law; it gains structure, not less
  scrutiny.
- A manifest change never silently remaps. New purposes/kinds start unmapped
  (auto-map only at exactly one candidate); an unmapped slot makes that purpose
  unavailable, never the site broken; the site learns "unmapped," sends the user to
  their mapping page. Existing slots keep their author's choice until the author
  changes it.
- Services stay under the device (Todd's phrasing, ratified): config.json remains
  the owner-authored definition of what exists; offers choose what is shared; the
  control plane holds only needs, mappings, and grants — never service definitions.

**Parked, not ruled** (Todd thinking out loud): reversing the money — device owners
offering compute and getting PAID for it, public offer as the paid tier where team
is the free guest list. Marketplace scope (payments out, metering, pricing) parks it
on the open-door deferred list; noted that it would reframe the pro meter again.

**Origin, for the record and the future video.** Todd, watching Satya Nadella note
that AI gives software real marginal cost for the first time: the inversion is users
bringing their own secured compute — including team-shared — so each new site ships
with zero marginal inference cost. The second seed: Todd wouldn't push his local
apps to the web because they were powered by his Max subscription and the web would
orphan it — byollm lets a subscription follow its owner onto the web. Both sentences
are the pitch; refinement into a video script is queued work Todd wants help with.

### Amendment L, rider: mapping notifications, pulldown defaults, direct-mode answer (2026-08-26)

Three rulings from Todd closing the mapping design:

**Value-add notifications are a product category.** When a site's manifest update
leaves a slot that no longer auto-maps, the control plane notifies the user to come
update their mapping — "another value add notification just like letting them know
if their daemon goes." Ruled as a category: control-plane-to-user notifications
(daemon offline per the health canary, mapping needed, and future kin) are product
surface, delivered by the hub, never the device's job on the cloud route.

**Pulldown preselection.** A slot's pulldown preselects your own private
llm.<kind> service if you have one; otherwise team services sorted by team name
alphabetically, top item preselected (within a group, service id alphabetical as
tie-break). Reconciled with choice-is-authored: preselection is visible on the
consent screen and the act of consenting authors it — a default the user confirms,
never a choice made behind them.

**Direct mode.** Todd: "assume the user just sets their llm.generate/chat/whatever
to match what their site needs for one site running server w/o a relay/hub.
Otherwise they map in the relay." Ruled yes, with the consequence stated: direct
mode is kind-only — the site asks for kinds, the owner's config and defaults
answer, the ambiguity law applies as shipped; manifest purposes collapse to their
kinds. Per-purpose mapping is what a relay is FOR, and the relay being open source
means "use a relay" is an architecture step, not a paywall. Consequence accepted
plainly: site-selects-by-name retires on BOTH routes — one story everywhere, sites
speak needs, never names. Phase B's selection machinery (REFUSED_SELECTION, capability
rows, isDefault) retires with it; Amendment D's key-vs-value law is not weakened but
completed — the name vocabulary no longer crosses any boundary at all.

Paying device owners: parked, captured, confirmed ("1000% park paying").

### Holes pass, ruled (2026-08-26)

Seven holes were put to Todd with proposed answers. Rulings:

1. RATIFIED: removal stops future claims (queued included); in-flight jobs finish;
   pause is the kill switch for running work.
2. RATIFIED: a mapping that loses its referent (team removal, service rename or
   deletion, consent revocation) degrades to unmapped, never silently remaps; the
   value-add notification fires; the slot's purpose goes unavailable and the site
   falls back. A service id is contract-ish once mapped; renaming is
   deletion-plus-creation. Revoking consent deletes the mapping — the mapping is
   the consent, so un-consenting unmaps.
3. RATIFIED (Todd: "love that"): same (owner, id) on multiple devices = replicas of
   one service; hub routes to whichever is online; keeping them identical is the
   owner's responsibility.
4. RATIFIED as security posture: private is device-enforced absolutely (grant user
   must equal paired owner — no control-plane compromise can grant a private
   service to anyone else); team scope rests on the control plane's word; damage
   bounded by offer scopes, spend caps, pause. Todd's reasoning recorded: server,
   relay, daemon, protocol, and conformance are all going open source for community
   audit, and the hosted product uses the same audited pieces under the hood.
   ADDED for v1.2 (Todd proposed, agreed): a platform-side progressive daily spend
   ceiling per account — e.g. $100, rising with account age/history to $500, $1000,
   the Anthropic/OpenAI pattern — bounding blast radius when an owner lazily acks an
   absurd spend authorization. Scope: it caps spend incurred by OTHERS' jobs on
   your metered services via the cloud route; what an owner spends on their own
   machine for their own jobs is not the platform's to cap. Refusals must say which
   cap fired (owner-authored --cap vs platform ceiling), split by remedy.
5. RULED (not delegated): clock skew is checked against the authority whose
   timestamps we verify — each relay's control plane — because grant verification
   needs agreement with the signer, not true time. Checked at startup as Todd asked,
   and opportunistically on every poll since responses are free carriers of server
   time. Beyond threshold: warning in status/health and the problems channel; any
   grant refusal caused by skew names the clock and the remedy, never masquerading
   as denial. This is the pin-check law again: the clock is a layer that drifts
   independently, so it gets watched.
6. DEFERRED to v1.1, "really soon" (Todd): per-user spend attribution in the spend
   log and dashboard — whose jobs spent what on your metered services.
7. STRENGTHENED: no public services in the hub at all — not unsupported, absent.
   On the cloud route, public-offered services are simply never advertised to a
   relay; cloud surfaces speak private|team only. Public remains fully valid in
   OSS direct mode. `byollm services` says so plainly ("public: direct mode only").
   Revisited only if the parked paying-owners marketplace gets its session.

### Correction to hole 4's v1.2 scope (2026-08-26, Todd's, with attribution)

My scoping line — "what an owner spends on their own machine for their own jobs is
not the platform's to cap" — was wrong, and Todd caught it: "If a dev did a poor
setup on their server or leaked their hub keys I think we should do our best to cap
their damages for a while. Anthropic and OpenAI both limit your spend to start on
your own endpoints to prevent a foot gun as you learn."

The ceiling's purpose is protecting the account holder from mistakes, not only from
other people — a leaked site key or a runaway server loop enqueues the owner's OWN
jobs and burns their metered backend just as fast. The correct scope line is not
whose jobs but which route: the progressive ceiling governs ALL cloud-routed spend
on metered services — every job the hub authors a grant for, the owner's included.
What stays outside is machine-local and direct-mode spend, and for the correct
reason: the platform never sees those jobs, and a cap on what you cannot see is
either surveillance or fiction. The Anthropic/OpenAI analogy lands exactly because
their caps govern spend flowing through their platform — same here.

### Build directive: pull the bandaid off (2026-08-26)

Todd, handing I–L to CCC: no backwards compatibility. The architecture was wrong or
overly complex in places now known; nothing keeps two versions of the same thing
alive, no unused code survives, no compat shims or feature flags bridge old and new.
Rip and simplify; keep still-valid tests green; keep everything ultra secure.
Riders recorded with it: tests for deleted machinery are deleted with it, never
skipped — no .skip graveyards — and every surviving law keeps its test; re-pairing
is an acceptable ask (silent state migration is not required), but leftover state
files from deleted machinery are cleaned up or refused loudly, never half-read;
deploy/publish ordering for breaking wire changes is stated in the plan (the
.strict() lesson); the ready-for-latest gate updates in the same change that changes
what /healthz advertises — the promotion gate must never go stale. Code gets ripped;
laws do not: the fence, RELAY_BLIND, pin-at-pairing, the unsigned-field law,
private-is-device-enforced, refusal indistinguishability, and consent wording as
product law all survive by name. Kevin gets a press migration note before he starts
tomorrow — the rip lands while he's offline, which is the timing, not an accident.

### Stop-ship diagnosis lands: my hypothesis was wrong; the real class is worse (2026-08-26)

CCC's diagnosis, verified against cli.ts:1421 and allowlist.ts:228: the B2 guard WAS
wired and correct. The fifth-unwired-caller hypothesis — mine — is withdrawn with
attribution. The lookup key never matched: normalizeOrigin does new URL(input).origin
and, on throw, silently falls back to the raw string. Todd typed the schemeless form;
the pairing was stored under the schemed origin; two different strings, undefined,
and the guard read "no control plane here." The status line rendering the schemeless
string was the same fact showing through.

The real class, still live and surviving the redesign: **a normalizer that silently
degrades unparseable input into its own distinct identity makes every lookup built
on it a false-negative factory.** Nothing warns. Two checks minted:
- normalizeOrigin refuses input it cannot parse — it never passes raw strings through.
- A property test: any two spellings of one origin either normalize equal or both
  refuse.

Second lesson, CCC's, recorded plainly: the source-level grep check passed because
all four listed call sites were present — a hand-maintained list of call sites
cannot catch a wiring class, because it does not grow when the code does. What
catches an unwired (or mis-keyed) caller of any kind is one end-to-end test — real
Runner, fixture relay, real job. That is Phase 0, and it is the durable form of
"every lesson becomes a check" for this whole category.

### CCC's five pushbacks: all ratified (2026-08-26)

1. **Single-use binds to a grant id, not the job id.** A timed-out claim re-claimed
   means a second grant for the same job; a device that pinned the job id as spent
   would refuse its own retry. The grant carries its own id (single-use on that) and
   binds the job id. Ratified as non-optional — CCC is right that it isn't.
2. **The first-serve notice fires before the job runs.** Synchronous notice, then
   execution — loud first, not a receipt after the first drain job already ran.
   Ratified; this also makes the notice the detection surface for posture item 3.
3. **The compromise posture, stated in its strongest true form:** private-is-
   device-enforced protects private services from other USERS, not from arbitrary
   SITES. After approve moves to the control plane, a compromised control plane can
   author a grant for a site the owner has never heard of, as the owner, against
   their private service. Caps and pause bound the spend; the first-serve notice
   (now ordered before execution) is the detection surface; nothing bounds the
   fact. This is the largest single trade in the redesign and the record now reads
   like one. Hole 4's earlier wording is superseded by this paragraph.
4. **Auto-mapped slots are displayed, never controlled.** My "auto-maps, silently"
   wording was wrong — Todd's rule was no control, not no disclosure. A one-
   candidate slot renders as text ("writing_assistant → your Claude"); the consent
   screen always shows every mapping it authors. Corrected with attribution.
5. **The flat-kind sugar gets a reserved purpose id**, renderable label included,
   forbidden in explicit manifests. And the sharp edge said out loud for site
   authors: graduating from a flat list to named purposes unmaps every existing
   user once — correct under never-silently-remap, and in Kevin's migration note.

### Two constants, ruled (2026-08-26)

- **Grant expiry: 120 seconds.** Gates acceptance, not execution — a long job keeps
  running. Comfortably over claim-to-verify latency; a captured grant is worthless
  (and dead anyway under grant-id single-use); wide enough that ordinary drift
  doesn't refuse.
- **Skew: warn at 30s** in status/health/problems; **any expiry refusal with
  measured skew over 5s names the clock and its remedy** instead of reading as
  denial.

### Build phases: approved (2026-08-26)

Phases 0–5 approved as proposed, Phase 0 strictly first — no cutting before a test
that runs a job. One reorder inside CCC's own stated freedom: publish @alpha BEFORE
the hub flips, not after — @alpha is inert until installed, and it shrinks the
broken window on Todd's machine to just his upgrade rather than upgrade-plus-
publish. Deploy order otherwise ratified, including the rule that mappings exist
before grants resolve from them, and that old-daemon-against-new-hub refuses loudly
with a named remedy — a deliverable, not an accident. Phase 1's concentration of
risk into four device-side checks is acknowledged; over-testing them (each with its
own test and mutation) is endorsed over speed. Riding along in Phase 1: the CLI
help's stale offer vocabulary (self|named|public) dies with the machinery. Todd's
acceptance probe gains one item from the diagnosis: the schemeless spelling of any
origin must behave identically to the schemed one — normalize equal or refuse
loudly, never a silent distinct identity.

### Posture guidance and the usage surface (2026-08-26)

Todd, closing the compromise-posture discussion: the user-facing guidance is
"connect your compute to sites you trust" — trust in the site is the thing the
mapping ceremony asks for, and the product says so plainly (final wording is
Todd's, as product law). And the trend-level detection surface is ruled in:
**per-service usage attribution** — each service shows which sites (and, for
team-shared services, which users) are driving it, with an opt-in weekly or
monthly digest email. An abusing site sticks out like a sore thumb on its own
graph. This generalizes v1.1's per-user spend attribution into one attribution
surface: usage by site and by user, spend where metered. Detection now has two
layers: the first-serve notice (immediate, before the first job runs) and the
usage digest (trend). Disclosure check: this is the owner's view of the owner's
own services — sites never see it.

### Usage graph shows ALL usage (2026-08-26)

Todd: "I think we show all usage in the graph. If someone was using a local model
or a site was using my claude excessively even for me I would want to know for
sure." Ruled: the attribution surface covers everything a device runs — cloud-
granted jobs, direct-mode jobs, and the owner's own local use alike, by service,
by site, by user where teams apply. Mechanism split by who knows what: the hub
already knows what it granted; local and direct usage is device-reported — the
daemon sends usage aggregates (counts, kinds, site, spend estimates — metadata,
never content) to its owner's own account. Disclosure is clean: the subject and
the recipient are the same person; sites see none of it. A pure-OSS daemon with no
cloud account has no graph — status and the ingress log remain its surfaces.

Boundary kept explicit so earlier rulings stay coherent: **seeing is not capping.**
The platform ceiling still governs only what the hub grants; device-reported local
usage appears on the owner's graph but is never the platform's to limit. The graph
is the owner knowing; the ceiling is the platform protecting.

### Formal ruling: teams stay — mechanism and name (2026-08-26)

Todd flagged that after the mapping additions we never formally closed the
keep-teams-vs-rename-to-sharing question. Ruled: **teams stay, both the mechanism
and the word.**

The mechanism was never in doubt after Amendment L — mapping made teams the thing
that answers "whose model serves this slot," and Todd's own verdict stands in the
record: "makes teams really powerful while keeping it simple." The name now stays
too, and the deciding law is one-vocabulary: `team` is a MUST wire literal
(offer: private|team|public), the pulldowns say "Team toddsampson/qwen-14-4b", and
renaming the surface word while the wire says `team` is exactly the split
vocabulary the one-vocabulary rule exists to prevent. Renaming the wire literal
mid-bandaid would be churn with no buyer. The demote-to-"sharing" proposal (mine)
is formally withdrawn.

What survives from that discussion is the scope sentence, which stays law: a team
is an owner's guest list for the owner's own devices — nothing more. No org
features are implied by the word, and none should be built on its strength alone.

### Phase 0 complete; two record corrections; Phase 1 go (2026-08-26)

CCC's Phase 0 landed (two commits, verify green): normalizeOrigin parses or
refuses, scheme-less hosts get the scheme a person meant (https; http on
loopback), pairings normalize at load and quarantine what won't, and a bad
address is answered centrally with remedy and exit 2 — centrally because a
per-command version is a hand-maintained list, the exact shape that missed. Six
mutations caught; one exposed a false comment (an unreachable guard claiming
new URL("http://") parses — it throws), replaced by the invariant property-tested
over ~2,000 generated strings.

**Correction one (CCC's own premise):** the end-to-end harness already existed
(relay/test/harness.ts — real Runner, real ProtocolClient, claim→seal→fetch→run→
report). What was missing was narrower and worse: no test anywhere exercised the
device's admission decision. makeDaemon hardcoded offer:"public", under which
matchAudience returns ALLOWED without consulting any list — every cross-user test
inherited that default — and freeze-gate §6 carried a comment claiming the
opposite over setup whose deletion leaves all nine tests green. Measured, not
argued: mutating admission to () => true, the old suites caught nothing (15 ran,
0 failed); the new admission.test.ts catches it (2 of 4). The net states
invariants, not mechanisms — owner always runs; admitted stranger runs;
unadmitted stranger refused with the model never seeing the prompt; a grant for
one origin never admits the same name on another — so Phase 1 deletes against it
and only admit() changes.

Two rules minted from part 2:
- **A harness default is part of every test's claim.** A fixture that quietly
  supplies a security-relevant value (offer:"public") shapes the whole suite;
  such fields are forced explicitly per test or the harness refuses to default
  them.
- **A comment asserting coverage is a claim, and deleting the setup it praises is
  the proof.** The freeze-gate comment was a claim shipped without proof, sitting
  on dead code — which is worse than either alone, because it marks the hole as
  covered.

**Correction two (mine, ruled accepted):** the probe entry was inoperative. The
same pre-fix normalizer meant the typed schemeless entry could never match the
Runner's schemed DEFAULT_ORIGIN — the ceremony completed and lied; no admission
ever happened through it. The severity line in the local-allow-vs-seat-limit
clarification is corrected with attribution: not "a live demonstration of a
seat-limit bypass" but **"authored a false grant — the ceremony completed and
lied to the owner."** The stop-ship stands as correctly called (a guard that
didn't fire; a forbidden state authored). Noted for the record's honesty: the
bug neutered its own bypass — the hole protected the system from the hole.

**Open check, Todd's to run:** if any service is offered public, device-side
admission is a no-op by design (public means anyone) — which makes holes-ruling 7
load-bearing rather than tidy. `byollm services` on Todd's machine tells us what
qwen (and everything else) is actually offered at, i.e. what the pre-rip exposure
really was. Diagnostic, not a Phase 1 blocker.

**Phase 1: go.** Kevin's migration note is written
(docs/press-migration-note.md); the purpose vocabulary is his one open decision.

### Pre-rip exposure answered — and a display finding (2026-08-26)

Todd ran `byollm services`. Verdict on CCC's worry: **nothing is offered public.**
Claude and codex are subscription-class and "locked to your work" (the class law
doing its job); glm-5.2 shows the narrowing warning working exactly as designed —
authored offer "team" narrowed to "private" because it is metered and no spend
consent is recorded, with the remedy printed (`byollm offer glm-5.2 team --cap`).
So the public no-op admission path was never live on this machine, and the only
cross-user-capable services are deliberate team offers. Pre-rip exposure: bounded
and intended.

The finding the paste hands us for free: **`byollm services` does not print each
service's offer scope.** qwen-2.5-14b shows its cost class ("free — your
electricity") and health, but the question this whole check existed to answer —
"what is qwen offered at?" — is not answerable from the surface named services;
it takes reading config.json. The offer is explicit in config (Phase A requires
it); the surface just doesn't say it. Ruled as a Phase 1 item, riding the rip
since the surface changes anyway: every service row states its offer scope in so
many words ("offered: private" / "offered: team"). A surface whose name is
services answers "offered to whom" — the same law as a status surface declaring
whose knowledge it shows.

### Ruling: public is dead everywhere — offer is private | team (2026-08-26)

Todd asked whether to formally kill public; ruled yes, everywhere — OSS direct
mode included. This supersedes holes-ruling 7, which kept public as a direct-mode
feature; the "public: direct mode only" services line dies before it was ever
written.

The argument is Phase 0's own finding: public was never a scope, it was the off
switch for admission — matchAudience returns ALLOWED for a public service without
consulting anything, and that branch is what made the entire cross-user suite
blind under the harness default. The enum is now two values, both of which
consult something: private → owner check, team → grant check. There is no path
through the daemon where the answer is "yes, whoever." The public branch is
deleted as a class, with its tests, and the Audience wire literal goes with it
(breaking wire change, riding the rip).

Consequence, stated as the design's true shape: **sharing requires an authority
that can name people, and direct wiring has none — so it shares with no one.**
Direct mode is owner-only: your daemon powering your own apps with your own
subscriptions, which is the product's origin story verbatim. Cross-user always
goes through a relay, and the relay is open source precisely so that is an
architecture step, not a paywall. A `team` offer on a daemon with no relay paired
narrows loudly to private with a remedy — the same narrowing machinery the
metered rule already uses, observed working on Todd's machine today.

Vocabulary confirmed once more: `team`, not `shared` — scope values name the
audience, not the act. Private answers "who" (you); team answers "who" (your
team); "shared" answers "what happened" and leaves "with whom" dangling.

Revival path recorded: if the parked paying-owners marketplace gets its session,
public returns deliberately, designed with payment and abuse handling attached —
never as a loaded chamber kept around unused.

### Phase 1 checkpoint after commits 1–2; two laws minted; commit 3 go (2026-08-26)

Commit 1 (public is dead) surfaced three findings, all now recorded:
- The suite was running through the off switch: with every relay-test call site
  forced to its narrowest scope, one test of forty-one genuinely shares (freeze
  gate §6 — the only real cross-user case in the relay suite). Conformance C005's
  nine-cell matrix had two true cells, both produced by public; it is four cells
  now and every one is a refusal. C014 asserted a provenance label on a path that
  never reached the decision that makes the label mean anything.
- `byollm services` OMITTED offer scope entirely — kind, backend, model, address,
  who pays, but never who it's shared with. Confirms and sharpens the earlier
  display ruling.
- `byollm status` printed the CONFIGURED offer, not the effective one: Todd's glm,
  narrowed to private pending spend consent, printed "team (you and people you
  allow)" while refusing every one of them. Both surfaces now print effective
  scope and name the narrowing. **Law minted (CCC's words): a request is not a
  state.** A surface that prints an authored value where an enforced value
  differs is lying in the owner's voice — sibling of "a status surface declares
  whose knowledge it shows."

Commit 2 (grant, protocol half, additive): all three ruled constants in; grantId
separate from jobId as ratified. The schema-drives-statement test exceeded its
brief: signed bytes derive from SignedGrant.shape, and the test reads fields off
the schema and tampers with each — it covers fields nobody has written yet, so
the unsigned-field attack cannot arrive via a list that doesn't grow. Mutation
testing then found a live gap: nothing asserted the four domain-separation
contexts differ — GRANT_CONTEXT set equal to ROSTER_CONTEXT passed all 256
protocol tests, and a collision would let a captured roster replay as a grant.
**Law minted: domain separation is asserted, never commented** — every context
constant in the codebase is tested distinct, namespaced, versioned, and leading
the bytes it protects, as a set that the test enumerates from the code, not by
hand.

The direct-mode consequence CCC asked to have on record as a decision: it was
one. The public-kill ruling stated it before Todd ratified ("direct mode becomes
owner-only... sharing requires an authority that can name people") and Todd said
yes to that text. Confirmed here in CCC's sharper sentence so no reader misses
it: **byollm without cloud is BYO-compute for one person; sharing a device
between users is a reason to run a relay** — an architecture step, not a
paywall, because the relay is open source. Sequencing the narrowing into the
daemon rip (it presumes allow is gone) is approved.

Commit 3: go. The rip lands against admission.test.ts with only admit()
changing; four device checks each with test and mutation — signature, replay,
offer-consistency, private-is-absolute. The domain-separation set law applies
across the rip: when roster contexts die with their machinery, the test's
enumeration shrinks with the code, which is the point.

### Exposure follow-up: qwen confirmed team; glm's "never worked" explained (2026-08-26)

Todd's dashboard screenshot confirms qwen-2.5-14b at llm.generate · team (Lis's
path is live) and glm-5.2 at private — the device page was already showing the
EFFECTIVE scope while local status showed the configured one, so the web surface
was telling the truth the CLI wasn't. All surfaces now agree under "a request is
not a state."

Todd's report that offering glm as team "never worked before" is explained by the
same defect compounding the guardrail: the narrowing to private was the metered
ceremony working as designed (a consent promise may not rest on a configurable
default — team-sharing a metered service requires `byollm offer glm-5.2 team
--cap <cents-per-day>` to record spend consent), but status simultaneously
printed "team," so a working guardrail read as a silent failure. The law's value,
demonstrated on the owner's own machine: the enforcement was right, the display
made it look broken.

Clarified for the record (Todd asked whether the offer is "managed by the site"):
no — offers are authored on the device, in config.json or via `byollm offer`,
per Amendment L's "services stay under the device" and the four verbs. The
dashboard is a view of device-reported truth. What the control plane manages is
membership, site enablement, mappings, and grants — never offers or service
definitions.

### Offer locality, refined not reversed; caps stop grants at the source (2026-08-26)

Todd challenged offers-live-on-the-device: strange to manage there, especially
after the replicas ruling — and shouldn't a hit cap mean the job never sends?

**Why the offer is per-device by nature.** The dashboard's own heading answers
him: "What this device runs." An offer doesn't describe the service, it describes
what THIS machine will do for whom — and the replicas ruling composes instead of
contradicting: the hub routes among devices that are online AND offer the service
at the needed scope; a service appears in a user's pulldown if ANY of the owner's
devices team-offers it. Studio offering qwen to the team while the laptop keeps
it private is not incoherence — it is the owner saying my Studio serves the team,
my laptop is mine. No narrowing rule needed; per-device offers are the feature.

**The security floor that forbids moving it.** Private-is-absolute — the one
check no control-plane compromise can defeat — works only because the device
knows locally what it offers. Hub-managed offers would let a compromised hub (or
account) flip private Claude to team and then grant it away; the strongest
sentence in the posture would quietly die.

**Ruled: management is asymmetric — narrowing from anywhere, widening only at
the machine.** The dashboard (and CLI twin) may narrow an offer or pause sharing
remotely — reducing exposure from a phone is safety-positive, like pause. But
widening (private → team) and spend consent (--cap on metered) are machine
ceremonies: an account compromise can shrink your sharing, never grow it. Two
doors for narrowing, one guarded door for widening. The remote narrow travels as
an owner-authenticated instruction the device applies to its own config and
reports back — the control plane relays it, never authors it.

**Ruled: a hit cap stops grants at the source.** The device remains the
authoritative enforcer of its own cap — its money, its book, fail closed at the
machine. But the hub, knowing the cap and the device-reported spend (the v1.1
channel), stops authoring grants against an exhausted cap, so the job never
sends: no prompt ships to a machine that will refuse it. Disclosure boundary:
the site and requesting user see plain unavailability — never "cap exhausted,"
which is the owner's financial state; the owner gets the real reason on the
notices channel.

**Open diagnostic:** Todd ran `byollm offer glm-5.2 team --cap 2500` earlier and
it never took; possibly the display defect, possibly a real bug. Retry
post-patch; if it still doesn't take, CCC diagnoses from evidence. Added to the
acceptance probe: the offer ceremony visibly takes — services and status both
show team with the cap, and the dashboard follows.

### Asymmetry overturned: offers are managed from the web, with a step-up (2026-08-26)

Todd, on the widen-only-at-the-machine rule, two corrections:
- My motivating example was wrong: "claude can't be team ever." Subscription-class
  services are locked to the owner by CLASS LAW, device-enforced, regardless of
  any authored offer — no surface, local or remote, can share them. The
  catastrophic case I argued from cannot occur.
- The trip test: "If someone on my team needs the spend increased for CI/CD on
  github, I can't imagine telling them to wait until I'm back from the trip to
  have access to my machine for a service that lives on the internet." GitHub
  doesn't require your machine for dangerous settings — it requires sudo-mode
  re-auth. That is the analogy completed, and it's right.

Ruled, replacing the asymmetric rule: **all offer management — narrowing,
widening, and spend caps — is available from the dashboard as well as the CLI,**
with these guards:
- Widening and spend consent from the web require step-up re-authentication
  (GitHub sudo-mode pattern; 2FA where enabled). Narrowing and pause never do —
  reducing exposure stays one tap.
- Class locks are absolute and device-enforced: subscription-class services are
  never shareable from any surface. The device refuses the state, not the button.
- Metered widening always requires an explicit cap typed at the moment of consent
  — no default, no carry-over — whichever door it comes through.
- Every widening is loud on both channels: a notice at the device ("qwen is now
  offered to your team — changed from your dashboard") and an email. Narrowings
  appear in the notices feed without the alarm.
- The device remains holder and enforcer: the web door sends an owner-
  authenticated instruction; the device applies it to its own config and reports
  back. Two doors, one law, one enforcement point.

Posture updated honestly: what survives an account compromise is no longer
"widening requires the machine" but class locks (subscription services
unshareable ever), the platform ceiling on cloud-routed metered spend (v1.2 —
this scenario is exactly what it was corrected to cover), explicit-cap consent,
and loudness on every widening. My asymmetric rule is withdrawn with attribution
— it defended most strongly the case class law already made impossible.

### Web-door additions ratified; CLI control-plane twins deferred; glm diagnostic closed (2026-08-26)

Todd ratified step-up re-auth and both-channel widening notices ("exactly right").

**Ruled: control-plane actions are web-only for v1.** The CLI keeps the four
verbs — all device-local, device-credentialed. Commands that act on the account
at a relay (team add, mapping edits, site enablement — the "CLI twin" family from
the Amendment I rider) are NOT built now: person-level credentials in the daemon
CLI are a real security surface (token storage, a step-up flow needing browser
handoff), two doors during the rip means drift risk while the law is still
settling, and the two-credentials-never-mix line stays sharpest when the byollm
binary holds only the device's identity. The rider's deferral stands — designed
later as a deliberate subcommand family, not grown now. (`byollm offer` is not in
this family: it authors device state and stays.)

**glm offer diagnostic: closed.** Post-patch, `byollm offer glm-5.2 team --cap
2500` took, with the full metered ceremony — explicit dollar translation
("$25.00 a day... stops at that ceiling and resumes the next day"), y/N consent —
and services now shows the effective state. The earlier "never took" is
attributed to the pre-fix surfaces; no further diagnosis owed.

**Three wording items from Todd's paste, for commit 3 (product-law surfaces —
wording gates the merge):**
1. The consent prompt says "people you have allowed" — allowlist vocabulary,
   which is a dead concept mid-rip. It must say the audience: "your team."
2. services prints "metered — shared, cap 2500c/day" — "shared" is not a scope;
   one-vocabulary says the row prints its offer scope by name: team.
3. The consent ceremony speaks dollars ("$25.00 a day"); the services row speaks
   cents ("2500c/day"). Surfaces sharing a value share its unit — print dollars
   where the consent did.

### Commit 3 recorded; fifth check ratified; conformance gap accepted-as-flagged; commit 4 next (2026-08-26)

The rip landed: −1,017 net. allow, disallow, Allowlist, the veto list, all roster
machinery, signedRosters gone with their tests (no .skip graveyard; surviving
tests relocated with before/after counts). Six of six mutations caught, including
both fail-open shapes. Wording rulings in.

Ratified from the report:
- **Check 4's structural form is the standard.** matchAudience consults admission
  only in its team branch, so a private service refuses a stranger before any
  grant is read — proven by handing the device a perfectly valid signed grant
  and watching it refused because the carrying code path is unreachable.
  Private-is-absolute now rests on structure, not on a check that could be
  weakened.
- **CCC's fifth check, ratified into the four (now five): the grant's user and
  the stub's owner are never reconciled, only refused.** The stub owner is an
  unsigned routing claim; a grant for bob on a job stubbed as alice's would have
  served alice and charged bob. Same family as the unsigned-field law: the
  signature's word is the only word, and disagreement is refusal.
- **The construction throw** (relay configured with controlPlanePublic but no
  authorGrant throws immediately) — load-time loud refusal family; a deployment
  mistake nothing downstream can catch must die at construction.
- allow.json retirement behaves as ruled: read once, names the people whose
  access ended and where to restore them, removes itself.
- Two wrong comments caught by tests (.strict() rejects a key holding undefined;
  C014's provenance promise made true rather than reworded — collect() exposes
  the sealing device, the test asserts the unforgeable part). Second and third
  instances today of comments-are-claims; the minted law is earning its keep.

**The honest loss, accepted as flagged, not quietly:** conformance targets are
direct servers, which cannot author grants, so the admitting half of C006, C014,
C018 is uncertifiable there — each check certifies the half a direct server can
show (in every case the fail-open half) and names in prose where the other half
went; C014's lost coverage lives in admission.test.ts so no MUST lost its
end-to-end home. The metered-ceiling-with-sharing path is unit-tested only.
Restoration requires @byollm/server gaining grant authorship — Amendment L work.
Interim mitigation is this record plus the flag in the kit's prose; third-party
certification is not being exercised this week.

**Sequencing ruled: commit 4 before manifests.** Rip-then-build beats
interleaving — leaving approve and the offered-sites queue alive while manifests
grow beside them is the dual-state hazard the bandaid directive bans. Deletions
should finish while the net is hot and verify is green; manifests are new
surface and will be better shaped against the daemon's final four-verb form; and
the conformance restoration that manifests unlock serves a certification nobody
runs this week. Commit 4: go.

### Ruling: grant authorship is OSS core, consumed by the hub — and never the transport (2026-08-26)

Todd asked whether grant authorship should move "to the relay and out of our hub
— so we just consume it there." Ruled yes to the substance, with one word
corrected because it is load-bearing:

- **Yes:** the authoring machinery — building the statement from the schema,
  signing, the claim-time assembly (resolve mapping → check membership → check
  ceiling → sign) — belongs in the open-source packages, and byollm.cloud
  consumes exactly that code. This is Todd's own audited-core principle ("as
  long as we use those under the hood we should be solid") applied to the most
  security-critical path we have, and it is the same work item as restoring the
  conformance kit's admitting-half coverage: a self-hoster running the OSS
  server IS the target that can legitimately author grants. The grant's
  protocol half (commit 2) already lives in @byollm/protocol, which is OSS —
  this ruling extends that to the authoring engine in @byollm/server.
- **The corrected word:** authorship must never live in the relay-as-transport.
  "Relay delivers, never authors" is the law that makes a compromised transport
  harmless — the transport moves bytes it cannot forge. What a self-hoster
  deploys may co-locate transport and control plane in one process (their
  topology, their shared fate); the CODE keeps the roles distinct, and the
  device's law is unchanged either way: a grant is valid because the pinned
  control-plane key signed it, not because of where it traveled.
- What stays hub-proprietary is what should: the policy STORE (accounts,
  consents, memberships, mappings, billing) and custody of byollm.cloud's own
  signing key. The hub becomes a deployment of the OSS engine against its own
  store — which is the deepest form of the open-source promise: the hosted
  product runs the same admission code anyone can read.

Sequencing unchanged: this is Amendment L / @byollm/server work, after the rip,
exactly where the conformance-restoration flag already put it.

### Commit 4: the rip is complete (2026-08-26)

Verify green across all four commits. Daemon: four verbs, three tombstones,
admission = five checks against one signed document. Protocol: grants in, roster
and public out. Relay: authorGrant as the seam, construction throw when a
deployment promises grants it cannot produce. Nothing publishable — the wire is
broken in both directions and the hub authors no grants yet; that is Phase 2 by
design, and the deploy ordering holds (web → hub → npm → Todd's upgrade and
re-pair).

**The fence moved rather than fell — recorded in CCC's precise form.** What used
to stop a relay minting a keypair and announcing it as a site was device-side
approval. Now it is one layer down and STRONGER against that attacker: work
requires a grant signed by the control-plane key pinned at pairing, and a relay
holds no such key — it can get an id pinned on the machine and never get one job
run under it. The proving test hands the device a relay-minted site and shows
the pin succeeding and the work still failing. The genuine cost stays as posture
item 3 states it: a compromised CONTROL PLANE can point a device at a site the
owner never chose — caps and pause bound it, the admission-time notice makes it
loud (after the grant verifies, before any backend is touched, on the first JOB
rather than the first mention — evidence, not a guess). Largest single reduction
in device-side control in the design, said plainly, with its test.

**Rule minted from the near-miss:** when a rip deletes a caller, the checks it
carried are re-homed on the surviving path or explicitly retired — never
silently dropped with the caller. applyApprovals' file verification ("a file is
not a smaller thing to verify than a heartbeat") moved into the constructor that
reads the same file, tests rewritten against the surviving path.

**The characteristic failure, named (CCC's observation, recorded):** twice now a
coverage or mutation signal has found a branch whose comment described
protection it could not provide (the hostname==="" guard; GrantRefusal's
no-pinned-key, unreachable because a device with no pinned key is in direct mode
and never verifies). This codebase's characteristic failure is COMMENTED
PROTECTION THAT CANNOT FIRE, and both tools catch it — which is why both run.

SITES_LOCALLY_APPROVED keeps its id and loses its false first sentence — ids
stable, prose honest.

**Phase 2: go, plan first.** CCC brings the manifest/mapping phase plan shaped
by the engine-as-library ruling — an open engine behind the authorGrant seam
with a pluggable policy store, never inlined into hub code for later
extraction. Hub grant authorship lands at claim where routeKey already gates.

### Generalized: nothing widens quietly (2026-08-26)

Todd, ratifying the direction: notifications and step-up auth across account
actions (sites added, etc.) are hub product value, not just protection. Ruled as
the general policy, extending the offer-management asymmetry to every account
surface: **any action that WIDENS exposure — enabling a site, widening an offer,
raising a spend cap, adding a team member — requires step-up re-auth and fires
both-channel notices (device notice + email). Any action that narrows — disable,
revoke, lower, remove, pause — is one tap, never gated, and logs to the notices
feed without alarm.** One sentence for the product and the video both: nothing
widens quietly.

### Calibration: communicate always, challenge sparingly (2026-08-26)

Todd, tempering the rule: "Don't want to be too much, especially for 2fa, but I
would air on the side of communicating it for sure." Refined accordingly — the
two halves of "nothing widens quietly" get different weights:
- **Notices are universal and non-negotiable.** Every widening communicates, on
  both channels, every time. This half has no friction cost to the owner and is
  never reduced.
- **Step-up is sudo-mode, not a toll booth.** GitHub's pattern adopted whole: a
  widening challenges only when the session isn't fresh — one re-auth opens a
  short window (order of minutes) covering a batch of changes, and 2FA is part
  of the challenge only where the account has it enabled. Setting up a new
  teammate's access end-to-end should cost one challenge, not five.

### Phase 2 plan approved; three consequences ratified; two rulings (2026-08-26)

CCC's Phase 2 plan is approved as proposed, including the 2a sequencing: the
engine is built against the memory store and proven by the EXISTING relay e2e
suite through a real Runner before any wire shape moves — the Phase-0 order,
reapplied. @byollm/control-plane holds all of Amendment L's law and none of
anybody's data; PolicyStore and GrantSigner are the two injection points, and
they are exactly the two things that should not be open (byollm.cloud's Postgres
store and key custody). The contract suite ships as a subpath export on the
relay/store-contract pattern — "a contract only the author can run is a
description" enters the record as law phrasing.

Three consequences ratified:
1. **One routes, one authorises, only one signs.** The relay's consent/membership
   pre-filter is an optimisation; the engine re-checks everything at authorship
   and wins disagreements by refusing. Two mechanisms, never two answers.
2. **"No grant" has two shapes.** refuse (this person may not use your devices —
   never re-offered) vs not-here (the mapping resolved elsewhere — released for
   the right device, re-offerable when mappings change). Commit 3 built only the
   first; shipping that into a multi-device account would have been a
   permanent-refusal bug. Caught on paper, fixed in 2a/2b.
3. **The resolved service never touches the site's records.** JobStub.service
   dies site-facing; the relay resolves internally for routing; the device
   learns the service only from the grant. isDefault and capability rows retire
   with it — the back door through which "sites never see service names" would
   have leaked is bricked up, not just closed.

Ruling one — **the reserved purpose id is "default".** A manifest may not
declare it (registration refuses with the remedy: name your purposes). It never
renders: the consent page shows the site's own name for the flat slot — "Of
Tomorrow Press → your Claude" teaches; "default → your Claude" doesn't.

Ruling two — **audienceAllow stays.** The boundary sentence that makes both laws
true at once: a site may name its SUPPLIERS; it may never name or see its users'
SERVICES. Amendment L's "sites speak needs, never names" governs the site↔user
boundary — what a site may know or say about a user's resources. audienceAllow
is the direct site's authority over its own dispatch: which runner owners it
trusts to take its own workload, on its own server, never crossing the wire —
GitHub's runner groups, exactly. Cutting it would strip direct sites of supplier
trust to satisfy a law written about a different relationship. It stays
direct-mode-only and server-side; the cloud route's equivalent is the hub's own
consent/mapping machinery, so nothing like it ever crosses the cloud wire.

### @byollm/control-plane is the sixth package — and why it lives alone (2026-08-26)

Todd asked whether the engine is a sixth OSS package and whether the reason is
shared consumption. Yes it is a sixth; shared consumption is the smaller half of
the reason. The larger half is that both candidate homes are wrong:
- Inside @byollm/relay, authoring capability would live in the transport
  package, demoting "relay delivers, never authors" from structure to
  convention — a relay deployment without the engine dependency should be
  INCAPABLE of authoring, not merely told not to.
- Inside @byollm/server, the law would be welded to one deployment shape, and
  the proprietary hub (a different repo) would import a direct-mode server to
  get an admission engine.
Standing alone, the engine is the law with no data and no transport, imported by
whoever deploys a control plane: byollm.cloud's hub, a self-hoster's relay
stack, and the conformance kit's future multiuser target.

Operational consequence, recorded so it isn't discovered at release time: the
all-or-nothing `latest` promotion set grows from five packages to six, and
ready-for-latest.mjs must enumerate six — the gate updates in the same change
that adds the package, per the gate-never-stale rule. Todd's 2FA promotion
ceremony covers one more name.

### The import graph, stated; and the 285-publish problem (2026-08-26)

Todd asked whether the engine should be a shared library imported into relay and
server, "the two that communicate," with the hub using the relay. Clarified and
ruled as the import-graph law:
- The engine IS a shared library — that was never in question. The question is
  who imports it, and the answer is: **deployments, never the transport.** The
  relay package depends only on the SEAM'S TYPE (authorGrant's signature); it
  never imports the engine, or the structural law (a relay without the engine
  dependency cannot author) dies. The hub imports BOTH relay and control-plane
  and wires them together at deployment — that is "the hub uses the relay,"
  stated precisely. A self-hoster's stack does the same wiring; @byollm/server
  may later ship a pre-wired bundle for them, importing the engine as a
  deployment would.
- One sentence for reviews: the relay asks through a function type it defines
  nothing about; only deployers hand it a real engine.

The operational pain is real and recorded: 285 manual 2FA publishes to reach
alpha.57, before a sixth package. Proposal (Todd's to accept — his ceremony, his
ruling): automate @alpha publishes via CI with npm trusted publishing/provenance
so day-to-day publishes cost zero interaction, while `latest` promotion remains
exactly what the standing rule says — Todd's, manual, 2FA, all-or-nothing across
all (now six) packages. The law was always about latest; the 285 were alphas
paying a ceremony price the ruling never asked of them.

### Why the relay must not author; and the one-command rule for self-hosters (2026-08-26)

Todd asked why relay-delivers-never-authors matters. Recorded plainly: the relay
is the most exposed component in the system — the internet-facing box that holds
the queue and moves every message. If the transport could author admission, then
whoever compromises the loudest, most attackable piece owns every device paired
through it: mint a grant, run anything on anyone's machine. Because grants are
signed with a key the relay never holds, a FULLY compromised relay can only
deliver, delay, or drop — replay is dead via grant-id single-use — so its worst
case is a stopped mailroom, never a forged signature. The devices' pinned key
points past the relay at the control plane, which is smaller, quieter, and not
required to face the internet the same way. You put the authority in the room
with the fewest doors.

Todd's second question — whether an open-source dev must import 3–4 modules and
wire them to get a basic service running — ruled as the complexity budget:
- **The basic OSS path is direct mode and touches none of this.** A dev building
  a site against their own daemon uses the server SDK and the daemon. No relay,
  no engine, no wiring, no keys beyond pairing. The import graph above is
  invisible to them.
- **A self-hosted relay is one command, not an assembly project.** The layered
  packages (relay + control-plane + a policy store) are the LIBRARY shape, for
  people replacing a store or putting keys behind KMS. The OSS deliverable also
  ships a pre-wired distribution — one package that imports and wires the stack
  with honest defaults (embedded policy store, keypair generated at init with
  custody documented) — so the operator experience is start, pair, go. Eject to
  the layered form only when you outgrow the defaults.
- The sentence for the docs: the law lives in six packages; the operator
  experience is one command.

### Press's declared manifest, v1 (2026-08-26, authored by Todd)

Provided by Todd (Press's original author; Kevin is porting) for 2d's consent-
page rendering and Kevin's migration — real shape, fixtures retire against it:

    {
      "books": ["llm.generate"],
      "fact-checker": ["llm.generate"],
      "revenue": ["llm.generate"],
      "writing-assistant": ["llm.chat", "llm.generate"],
      "style-trainer": ["llm.generate"]
    }

llm.image deliberately left out until the image work is ported — a good test of
manifest graduation later (a NEW purpose arrives unmapped and notifies; adding a
purpose is the cheap direction, unlike flat-to-named).

Six slots total (writing-assistant carries two kinds). Display labels are still
owed by the site — purpose ids are wire vocabulary; the consent screen renders
site-declared labels (Books, Fact Checker, Revenue, Writing Assistant, Style
Trainer presumably, but declared, not derived — wording is read by users, so
Todd reads it before ship).

**Consequence spotted at declaration time, worth everyone knowing before 2d:**
Lis's writing-assistant llm.chat slot has ZERO candidates today — qwen offers
llm.generate only, and Todd's llm.chat services are subscription-class, locked,
unshareable ever. A zero-candidate slot behaves as unmapped from birth: that
kind within the purpose is unavailable, press falls back to its own API for
chat, and nothing breaks. If Todd ever wants Lis's chat on team compute, it
takes a team-offered llm.chat service (e.g. a local model advertised for chat);
no code, one offer. Also noted with a smile: style-trainer is the slot the
"Team gwen-demarco-lora" future was always pointing at — the mapping model was
built for exactly that pulldown.

### Lis's expected mapping — the flagship acceptance scenario (2026-08-26)

Correction to the zero-candidate note, from Todd, and it's better news: Lis has
her own Max subscription, so her own device brings claude llm.chat (private,
hers) to the table. Her expected press mapping: writing-assistant llm.chat →
HER Claude on HER machine; the generate slots → Todd's qwen (more likely glm
once shared) on HIS machine — one user, one site, two owners' devices, split by
slot between a private service and a team one. Labels confirmed correct as
listed.

This is now the flagship 2f acceptance scenario, because it exercises the
redesign end to end in one user session: per-user candidate sets drawn from
multiple owners' devices (the exact case that forced resolution hub-side in
Amendment K), mapping authored at consent, grants carrying different resolved
services to different machines for the same user, private-is-absolute on her
box, team admission on his, and press knowing none of it.

### 2a landed; two bugs the sequencing caught; the smell gets its name (2026-08-26)

Engine shipped as planned — PolicyStore and GrantSigner injectable (the key as a
function, so custody can sit behind a KMS), the rule in the open, the contract
suite a subpath export. The fixture-to-real-engine swap caught two bugs on its
first run, which is what the 2a-first sequencing was bought for:

- **A paused consent still authorised.** The store didn't model pause; a relay
  projection lagging by seconds was all that stood between a paused site and a
  signed grant. `consented` now folds never-authorised, revoked, and paused into
  one boolean — CCC's phrasing enters the record: **different to a person,
  identical to a grant.** (The owner-facing surfaces still distinguish the three;
  the grant never does — the split-by-remedy law and this are the same law seen
  from both sides.)
- **Two consent literals that could drift.** Projection (what a relay routes by)
  and policy (what the engine authorises by) are one database read twice in
  production, but were two hand-written literals in the harness — quietly
  testing a world where a relay routes work its control plane would refuse. The
  harness now derives the store from the relay's own fixture. **Law minted: what
  production makes one thing, a test must not make two** — a fixture inherits
  the invariants the deployment gets for free, or it tests a world that cannot
  exist.

Both release shapes proven, with the permanence test taken from the only vantage
where permanence is visible: while the member is removed, refuse and not-here
look identical at the claim endpoint — so the test re-admits her and shows the
refused job still doesn't come back.

**The named smell, at CCC's request — THE HAND-MAINTAINED ROSTER:** any list
maintained by hand in parallel to the thing it describes — call sites (the grep
check that missed the stop-ship), files (check-site.mjs's README list, which let
relay ship unchecked for weeks), exceptions (the (?!-certify) pin carve-out
written before that binary existed), and, at architecture scale, Amendment J's
held roster itself. Four instances in one week, one bug in different hats. The
fix is always the same: derive the membership from the code, or write the rule
so it names no members. New checks that enumerate anything by hand are refused
at review.

**For 2b's routing question, the frame ruled in advance:** resolution is
authored once, at claim, by the engine — anything earlier is a HINT. An
enqueue-time resolution may exist for routing efficiency only if disagreement
with the claim-time answer degrades to the not-here shape (re-offered, sorted
out) and never to refusal; if that property can't be held, offer by kind and
accept wasted claims — the honest fallback. One routes, one authorises, only
one signs; a hint may mis-route, it may never mis-answer.

### Press manifest of record — final, wording approved (2026-08-26)

Field name ruled: `kinds`, uniform with the rest of the system (Todd: "If we
are keeping kinds everywhere else, we will just keep it here"). The `needs`
alternative was considered and declined for uniformity. Shape per the 2b
amendment: purpose keys are wire ids; `label` declared, never derived; optional
`description` is consent-screen context. All wording below is Todd-approved
product law — note books and revenue are the consent-sensitive slots (full
manuscript text and financial data respectively flow through whatever service
the user maps there), and their descriptions say so plainly.

    {
      "books":             { "label": "Books",             "description": "Reads and parses your existing books for use across the site", "kinds": ["llm.generate"] },
      "fact-checker":      { "label": "Fact Checker",      "description": "Reviews facts in your non-fiction work and builds the reference list", "kinds": ["llm.generate"] },
      "revenue":           { "label": "Revenue",           "description": "Analyzes your sales, revenue, and ad spend performance", "kinds": ["llm.generate"] },
      "writing-assistant": { "label": "Writing Assistant", "description": "Outlining and brainstorming to beat the blank page", "kinds": ["llm.chat", "llm.generate"] },
      "style-trainer":     { "label": "Style Trainer",     "description": "Trains a model on your writing style to generate draft content in your voice", "kinds": ["llm.generate"] }
    }

This supersedes the earlier bare-shape declaration. Deferred by design:
llm.image (advertising) and translations arrive later as NEW purposes — the
cheap direction.

### 2b ruling: kind-offering with a bounded retry; the hint is dead (2026-08-26)

CCC answered the routing question by probe rather than argument — twelve
control-plane reads for a job that would never run on the claiming device — and
the finding kills the enqueue hint cleanly: a stale hint points at A, A declines
transiently, and the hint still points at A, so it loops identically while
adding an enqueue-time resolution to keep coherent. Strictly more machinery for
a scale-only gain. Ruled as proposed: **offer by kind; a transient decline
records a per-(job, runner) not-before; claim skips until then.** The relay
gains the third semantics the situation always had — "not this device, for
now" — where it previously knew only "never" and "immediately."

**Constant ruled: 30 seconds.** Negligible for a stuck job; a user who fixes a
mapping sees queued work move within half a minute.

**Law minted from CCC's own flag: a transient needs a rate — a retry without a
not-before is a spin.** Every retryable state carries when it may be retried,
the same way every terminal refusal lives with a deadline. Recorded with the
honest provenance: 2a introduced the transient decline reachable-in-theory, 2b
would have made it reachable in practice, and the probe caught it before it
shipped — the flag was CCC's, unprompted, which is the review culture working.

Deploy coupling recorded so the ordering carries it: RoutingStore's contract
suite grows the not-before case, and byollm-cloud's Valkey store must implement
it BEFORE the hub deploys — the shipped-contract pattern doing precisely what
it was adopted for, in its first week.

**2b order approved as proposed:** backoff first (no wire change, probe becomes
a real test), then Manifest in protocol (keys, label, optional description,
kinds; "default" refused at registration with remedy), then the wire flip
(purpose replaces service; REFUSED_SELECTION, capability rows, isDefault
retire; relay offers by kind), then the direct-mode drift test.

### 2b commits 1–2 recorded; the structural standard generalized; wire flip go (2026-08-26)

Backoff: the probe is now the test, asserted on the count NOT growing with ticks.
The "offers it again" test asserts both halves — absent immediately after,
present once 30s elapses — with CCC's reason recorded: **either alone is a bug
that passes.** The contract states the obligation in both directions (not that
runner before the moment; every other device immediately — the whole reason it
is not a refusal), and uses an explicit moment rather than a moved clock,
because a store across a network has its own. Valkey inherits the cases rather
than being trusted to have thought of them — the shipped-contract pattern's
first real exercise, working as adopted. Four mutations caught, including the
per-runner not-before applied globally, which would have turned a per-device
wait into a global stall.

Manifest: press's v1 parses as written and is the test fixture — real shapes,
not shapes invented to pass; writing-assistant's two kinds is the live proof
that a mapping is per (purpose, kind). RESERVED_PURPOSE collapsed to its one
home in protocol.

**The structural standard, generalized (third instance ratifies the pattern):**
prefer structure over procedure wherever the design allows —
1. check 4: private refuses through an unreachable path, not a passing check;
2. "default" refused by the schema's .refine, not a registration handler — a
   handler check is a check a second path can miss; a schema cannot be routed
   around;
3. singlePurposeManifest normalizes the flat-list sugar at the edge, so no
   consent screen, mapping table, or resolver downstream carries a branch for
   the site that declared no purposes — and its label belongs to the caller,
   because "default" renders to nobody (the label-itself-default mutation was
   the one that mattered, and it was caught).
The rule in one line: a guarantee should be a shape, not a discipline.

**Commit 3 (the wire flip): go.** Breaking; daemon and hub move together
thereafter. CCC's watch item is endorsed as rip discipline: with names gone,
the claim filter's service branch collapses to kinds, and serves and isDefault
must fall OUT of ClaimInput entirely — no unused wire fields lingering where a
reader would infer meaning that no code gives them.

### The wire flip is in; 2b at three of four (2026-08-26)

Recorded from the flip:
- serves and isDefault fell out of ClaimInput entirely, as ruled — with CCC's
  distinction kept: isDefault died ON THE WIRE; the owner's default survives as
  a local fact for direct-mode resolution. What stopped existing is anybody
  else's interest in it.
- **Fourth instance of the structural standard, arrived at by deletion:** the
  REFUSED_SELECTION guard is now unrepresentable rather than prevented — a
  vocabulary that never crosses a boundary cannot be enumerated across it.
  refusal-opacity.test.ts became refusals.test.ts, asserting the shape instead
  of the collapse.
- The SQL migration is the design telling the truth: the service column renamed
  with values NULLED, because a stored service name is a name from the wrong
  namespace and no migration could know the mapping — the mapping is the
  user's to author, so the null IS the unmapped state, and the consent screen
  is the only path out of it. Never-silently-remap, enforced by a migration.

**The drift test's own bug, and the phrase it minted:** the first version
called runJob directly and passed while the mutation it existed for survived —
the guarded line lives in the claim path. **Testing near a law is not testing
it** — kin of test-call-sites-not-mechanisms, now with its sharpest instance.
The loop version names a service alpha and sends purpose alpha so confusion
picks a visibly wrong machine. Fixing it also surfaced the loop harness hooking
backend CONSTRUCTION (counting capability-detection health checks as work);
it hooks execution now — the harness-asserts-its-own-execution family again.

**Coverage ruling (CCC's flag, answered):** the gate does not move — CCC's own
instinct, endorsed. But the insight is recorded as law: **a ratio survives a
rip only if its denominator is re-examined** — the shared-denominator rule
applied across time; 85% today and 85% two weeks ago measure different things
because the rip deleted well-covered code and left old gaps as a bigger share
of a smaller whole. Post-2b work queued: codex-cli.ts (20% branches) gets
covered properly — it is a subscription-class backend and class locks are
enforced near it, so its gaps are security-adjacent; debug.ts (0%) gets
covered or deleted per rip discipline — an untested module nothing exercises
is a candidate for the same treatment as unused wire.

Last 2b commit: the sweep — README, protocol docs, and the demo still speak
"service" — then daemon and hub are locked together for the deploy.

### 2b complete (2026-08-26)

Four commits, verify green. The last sweep caught the best kind of straggler:
`byollm status` still said "selectable for" — a power nobody has after
Amendment L, sitting on an owner-read surface three commits after its mechanism
died. A service now says what it ANSWERS, and the default is labelled "yours,"
because that is the whole of what a default is now: where your own unresolved
work goes; a relayed job arrives resolved and never consults it. The daemon
README's routing promise strengthened to match: a job cannot name a model, URL,
path, flag — or one of your services.

Ratified without reservation: release notes were NOT rewritten. alpha.58 gets a
note; alpha.46/48/51 keep describing what those releases actually did. Records
are records — the same law the specs live by, applied to the README, for the
concrete reason bump-version.mjs already warns about: rewriting history makes
every "is this version mentioned?" check ambiguous.

State: Phases 0, 1, 2a–2b done. Daemon and hub locked together; nothing in the
byollm repo is publishable alone — the state the deploy ordering was designed
around. Remaining: 2c/2d (web: manifest at registration, the consent/mapping
page, degradation notifications, /api/hub/rosters deleted), 2e (hub: engine
against Postgres; Valkey implements the not-before contract case BEFORE the hub
deploys), 2f (press, Todd's acceptance probe, /healthz and the gate updated in
the same change). Then: web → hub → npm → Todd's upgrade, re-pair, remap.
Post-close queue in order: codex-cli.ts covered, debug.ts covered or deleted,
threshold re-derived.

Operational note: 55 commits sit unpushed on byollm main, all local to one
machine. Recommended to Todd: push now — durability, not deploy; the repo is
public OSS by design, npm publishes are manual so pushing source ships nothing,
and the coordinated deploy ordering governs the cloud repos, not this push.

### 2d underway: the revoke-unmaps trigger; an anomaly held open (2026-08-26)

All three repos pushed and clean (the byollm-cloud pre-push hook refused until
verify had passed at HEAD — it caught four unverified spec commits, which is
the gate working on the record-keeper too).

Schema landed: dashboard_sites.manifest and dashboard_consent_mappings, with
the trigger that makes revoking unmap. The design reason is recorded because it
is the mapping-is-the-consent ruling meeting the observable-events rule:
revocation stamps revoked_at rather than deleting (an event, not an erasure),
so no cascade fires — and kept mappings would silently restore old choices on
re-consent, "a decision made months ago applied to a screen nobody read again."
The trigger deletes them; the pgTAP test proves it from the permanence vantage:
un-revoke and find nothing back.

Also recorded as an instance of dead-things-die-with-their-subjects: /api/hub
removed from the proxy's public-path LIST, not just the route — an exemption
covering an empty path makes the next route added there public by accident
rather than by decision, and the conform check that would catch it only fires
for secret-comparing routes.

conform caught three house-rule violations mechanically (PUBLIC-executable
definer function; created_at without updated_at; a test writing as
authenticated without the grant) — 24 checks, clean on re-run.

**Open anomaly, held not dismissed:** one conform run failed unreproducibly;
three consecutive clean runs since; the output did not name the failing check.
Per the intermittent-test law this stays open until explained or given a second
data point. And the anomaly exposes a real defect regardless: **a failure that
does not name itself is unfalsifiable** — the conform runner must always
identify the failing check, else no recurrence can ever become evidence. Fixing
the runner's failure-naming is queued as the actionable half of the anomaly.

Todd's action items: delete the dead Vercel env vars ROSTER_SIGNING_PRIVATE_KEY
and ROSTER_READ_SECRET (secrets are Todd's to touch). The hub WIDENING set
still listing named/public is CCC's 2e item.

ROSTER_SIGNING_PRIVATE_KEY and ROSTER_READ_SECRET deleted from Vercel by Todd
(2026-08-26) — the roster machinery's last living remnant is gone; Amendment J's
retirement is now total across code, wire, store, and secrets.

### 2d continues: the anomaly's defect relocated; mapping logic as testable rulings (2026-08-26)

Correction, CCC's own, accepted into the record: the conform runner DID name
failures — inline, at the failure, "✗ <check name>" — and the unidentifiable
failure had named itself a few lines above the window a `tail -8` kept. The
defect was misplaced in the report (and thus in this record): the runner was
fine; the EXCERPT was blind. Two things worth keeping from the correction:
- The law refines rather than dies: **a failure must name itself where the
  reader actually looks.** A summary line, a CI excerpt, a pasted tail — the
  part that survives truncation must carry the names, because that is the only
  part a future comparison will have. The fix (summary carries names, proved by
  breaking a check and reading six lines) survives its own corrected premise.
- The diagnosis error was a window problem — the evidence-of-absence law's own
  clause ("a log read used as evidence of absence must state its window"),
  violated by the reporter who minted the phrasing, caught by the reporter. The
  flake itself stays open; a recurrence can now be compared against something.

The mapping logic landed pulled OUT of the component, for the stated reason
that enters the record: **every line of it is a ruling** — order, preselection,
auto-map, what stays empty — and buried in JSX the only way to check a ruling
is to render and squint. 15 tests against press's real v1. Two cases named:
- Replicas are one choice; a teammate's identically-named service is a second
  choice — the same string in two namespaces is two different machines. The
  pulldown's owner prefix is load-bearing, not decoration.
- readMappings reads against the manifest's slots, never off the form — a form
  is browser-editable, and a mapping for an undeclared purpose would sit in the
  database answering a question nobody asked. Unknown-fails-closed at the
  client boundary.

Remaining in 2d: the component, approveConnect writing mappings in the same
act as consent (the ruling made literal), the degradation notification — and
the consent-screen copy comes to Todd for read BEFORE merge, per
wording-gates-merge. Confirmed as the process.

### Consent-screen copy: approved (2026-08-26, Todd)

Wording approved for merge, superseding the draft in CCC's checkpoint:
- Heading: **"Choose what powers each part of this site"** — names the act, not
  the screen; no internal vocabulary.
- Grouped by purpose (Todd's ruling): label and description render ONCE per
  purpose; one nested row per kind, each with its own control and its own
  "none". The repetition, not the grouping, was what obscured that two kinds
  are two decisions.
- Kind ids never render raw on user surfaces: kinds get user-facing labels —
  llm.chat → "Chat", llm.generate → "Generation" — one table, one place, and
  the class-vocabulary rule now explicitly covers kind ids.
- "none — this part will not use my devices" stays the LAST option: the top of
  the list is the screen's recommendation, and easy-to-withhold is satisfied by
  the decline button, which refuses the whole site in one act. Option ordering
  is not where consent's exit lives.
- Zero-candidate slot: "nothing of yours answers this yet" (matches the
  services surface's answer vocabulary); below the list: "Some parts of this
  site have nothing of yours to use yet. They simply won't use your devices —
  <site> carries on without them, and you can set this up later from Connected
  sites."
- Dropdown options: "your <id>" for own services; "<owner> · <id>" for team —
  the owner prefix load-bearing per the two-namespaces case.

Both shape decisions ratified: the form-attribute single submission (consenting
and wiring cannot come apart — the ruling made structural), and mapping-write
failure NOT rolling back consent (the consent is the decision, recorded;
unmapped is a handled state; rollback would discard the decision to protect the
detail).

Degradation sweep: go, in parallel with the copy landing — the claim path sees
one device and cannot tell resolved-elsewhere from referent-gone, so the sweep
is a background pass per person over mappings against current services, feeding
the value-add notification channel.

### Kind labels' home, and the unpublished-protocol gap (2026-08-26)

CCC parked the kind-label table in the web lib because the web pins a PUBLISHED
@byollm/protocol and the rip's protocol changes are unpublished. Ruled:
- **The web lib is the right home, not just the expedient one.** Protocol
  carries ids; surfaces carry words. Display labels are product copy under
  wording-gates-merge, which lives in the cloud-web repo where Todd reviews —
  putting English strings in the OSS wire package would route every copy tweak
  through an npm release and the six-package promotion. Each surface owns its
  own words for the shared ids (the CLI may phrase differently than the consent
  screen); the IDS are the one vocabulary, not the labels.
- **With one guard:** the table's membership must be DERIVED, not hand-kept —
  typed as an exhaustive Record over protocol's kind list, so adding a kind
  breaks the web build until someone words it. Until web consumes the published
  types, an interim test carries that duty. A label table that can silently
  miss a kind is the hand-maintained roster again.
- **The wider gap has a ratified fix already — apply it now:** npm @alpha
  publish moves to the FRONT of the deploy sequence, not just before the hub
  flip. @alpha is inert (nothing auto-installs it; latest holds at .56), and
  publishing early makes protocol's real types the coordination medium so the
  web never re-declares shapes it doesn't own. Any interim re-declared shape in
  web (manifest schema included) is two definitions of one law and gets
  replaced by the published types as soon as they exist. Ordering becomes:
  npm @alpha → web → hub → Todd's upgrade, re-pair, remap — same constraints
  honored (mappings before grants; loud old-daemon refusal), one less reason
  for parallel definitions.

### The half-identity bug; the fixture smell; the sweep's crux ruled (2026-08-26)

**The bug, recorded with its law citation:** a mapping row stored `service`
alone, when the ruled identity of a service has been (owner, id) since the
replicas and two-namespaces rulings — the schema carried half the identity. Two
teams each running a "qwen" were two options on the consent screen collapsing
into one column on write; work would have been admitted on whichever machine
claimed first — the substitution this whole design exists to forbid, arriving
through a column one field short. CCC's own candidate test asserted the
separation and passed against a list whose entries collapsed on choice — the
tell walked past. Fixed in both repos: service_owner on the row, owner on the
engine's Mapping, both carried in the form value; and the engine checks OWNER
BEFORE capabilities, for the recorded reason: a device sharing a name isn't
offering the wrong service, it's the wrong machine, and the wrong machine's
capabilities say nothing either way.

**Smell minted (CCC's, second instance of its class):** when a change makes
existing tests fail and you fix the FIXTURES, the rule you just added has no
test yet. The `if (false)` mutation passing 25 tests was the proof; two direct
cases now exist (same-named teammate service refuses on the wrong machine;
null owner means "mine", never "anybody") and both mutations are caught.

**The sweep's crux, ratified with its principle:** a referent is GONE only when
the device is live and no longer advertises the service, or when team
membership itself ended — control-plane truth. It is never gone because a
device is silent: devicesForOwner returning empty capabilities for an offline
laptop is absence of signal, and **absence of signal is not a fact** — the
evidence-of-absence law wearing its scheduler hat. A mapping to a long-offline
device stays authored: the unavailable state is visible through the site's
fallback and the daemon-offline notification, which own that problem. (A
"mapped to a device offline N days" notice may join the value-add channel
later; deletion never does.)

Copy shipped as ruled; label table derives from JOB_KINDS (a kind added
upstream fails the compile until someone names it); interim re-declared shapes
and the runtime test are marked to retire when the pin moves. Notification
copy comes to Todd before merge.

### Degradation notification copy: final (2026-08-26, Todd)

Subject (Todd's ruling): "One of your byollm settings needs a look".
Lead-in rewritten to kill the spam-shape — it now references the real act the
reader performed, in the consent screen's own approved vocabulary ("what powers
each part"), and one email covers one site so the lead-in can name it:

    When you connected Of Tomorrow Press, you chose what powers each part
    of it. One of those choices can no longer be used, so that part has
    stopped using your devices. Nothing is broken — the site carries on
    without it.

    Of Tomorrow Press · Revenue · Generation
    was using Alice's qwen-14-4b, which isn't shared with you any more.
    If it's shared with you again, you'll need to choose it again — ask
    Alice if you still want it.

    Of Tomorrow Press · Books · Generation
    was using your qwen, which that device is no longer offering. If that
    device offers it again, this will resume on its own — if that's a
    surprise, check that machine.

    Choose again any time on Connected sites: <link>

Rulings carried: remedies inline per item (split-by-remedy); the
recoverable/not difference stated as FUTURE BEHAVIOR (resumes on its own vs
choose again), no internals; the self-justifying closing line dropped; the
"won't come back on its own" accuracy bug fixed by the per-item futures. One
email per site, so the lead-in stays concrete.

### 2d: the sweep wired, and the two things wiring it found (2026-08-27)

Cron landed in cloud-web (1e32419): `/api/cron/sweep-mappings`, daily, per
person — mappings read oldest-look-first, people capped at 40 because the
expense is per person (one hub call, up to one mail per site), deferred people
named rather than counted away. `sharers` from `dashboard_team_roster_members`,
`devices` from `devicesForOwner`. 12 mutations, 12 caught. pgTAP: 7/7.

**The sweep would have forged a review.** 0032 put `updated_at` on the mappings
table for a stated purpose — "when did you last look at this" is the question a
re-disclosure prompt is answered by — and `moddatetime` fires on ANY update. The
three bookkeeping columns the sweep needs (`swept_at`, `degraded_at`,
`notified_at`) would have moved it every run: within an hour of deploying, every
mapping in the database would have claimed its owner had just revisited their
choice. Law minted, and it generalises past this table: **`updated_at` is
evidence about a human act, and a background job is not a human act.** The
trigger is narrowed to the columns that ARE the choice (slot, service, whose);
the rest is us taking notes. Structural rather than remembered — the alternative
is a rule the next writer of a bookkeeping column has to have read. pgTAP holds
both halves, because narrowing a trigger is only safe if it still fires on
everything it was there for.

**Told once, and told again only on a new fact.** A `service-gone` mapping is
kept (ruled — the evidence is a heartbeat), so it is re-found every run and the
only thing stopping the second email is a memory of the first. `degraded_at` is
that memory; `notified_at` is the receipt, and it is stamped by the SENDER, not
by the plan: a plan cannot know whether mail left, and stamping it there would
record a provider outage as having told somebody. Recovery clears both together
— which is what makes the mail's "this will resume on its own" true, and what
makes a second failure a second mail rather than a duplicate. Clearing one and
keeping the other would silence the NEXT failure forever.

**The delete does not wait for mail.** invite-notify's law applied: mail is a
notification and never a gate, so coupling a correctness action to somebody
else's SMTP would leave stale mappings for as long as a provider was down. The
row goes; the undelivered notice is named in a WARNING, because the loss is real
and should be visible rather than silent.

**The cron guard moved to one place** (`lib/cron-auth.ts`). The second cron
route copied the first — the hand-maintained-list smell wearing security
clothes: two copies of a constant-time comparison are two chances to stop being
one, and the drift would be invisible.

### Degradation copy: two deltas awaiting Todd's read (2026-08-27)

Implemented and committed, NOT pushed — wording gates the merge. Both are cases
the settled block does not cover rather than rewrites of what it does:

1. **Plural.** The ruled subject and lead-in are singular ("One of your byollm
   settings needs a look"; "One of those choices can no longer be used… carries
   on without it") and the ruled example shows TWO items under them. Implemented
   as: "Some of your byollm settings need a look" / "Some of those choices can
   no longer be used, so those parts have stopped using your devices… carries on
   without them." The subject counts within a mail, never across them.

2. **A teammate's device going quiet** — the third reachable case. The settled
   copy covers a share that ended (always somebody else's service; a mapping to
   your own names no owner, so the roster is never asked about it) and one's own
   device going quiet. The third can borrow neither: "check that machine" is not
   something the reader can do to somebody else's laptop, and "you'll need to
   choose it again" is untrue — the mapping still stands and the service may
   come back. Implemented as: "was using Alice's qwen, which that device is no
   longer offering. If it's offered again, this will resume on its own — if
   that's a surprise, ask Alice."

Also noted, not acted on: `conform` has twenty-four checks and none is "the
source is formatted", which is why three files from this redesign drifted and
went in green. Ten files repo-wide are unformatted.

### Cron wired; two laws from the wiring; copy deltas recommended (2026-08-26)

Sweep cron landed daily, oldest-look-first, 40 people per run with deferred
people NAMED, never counted away (the no-silent-caps law observed unprompted).
12/12 mutations, pgTAP 7/7, conform 24/24.

Two laws minted from what wiring found:
- **updated_at is evidence about a human act, and a background job is not a
  human act.** moddatetime firing on any update would have had the sweep's
  bookkeeping columns claim, within an hour of deploy, that every mapping owner
  had just revisited their choice — a forged review on the exact column a
  re-disclosure prompt would one day consult. The trigger is narrowed to the
  columns that ARE the choice, and pgTAP holds both halves: narrowed, and
  still firing on everything it was there for.
- **Memory and receipt are different columns.** degraded_at records when a
  service was first seen gone; notified_at is stamped by the SENDER only — a
  plan cannot know whether mail left, and stamping there would record a
  provider outage as having told somebody. Recovery clears both together,
  because clearing one would silence the next failure forever. Mail is a
  notification, never a gate: the deletion does not wait for it, and an
  undelivered notice is named in a WARNING.

Deploy coupling recorded: migration 0035 reaches production BEFORE the cron
deploys, or the route reads columns that don't exist.

Copy deltas recommended for approval (Todd's word pushes 365cb1c): the plural
variant (count within a mail, never across), and the third reachable case — a
teammate's device gone quiet — which correctly borrows neither existing remedy:
"was using Alice's qwen, which that device is no longer offering. If it's
offered again, this will resume on its own — if that's a surprise, ask Alice."
With it the case matrix is complete: share ended (deleted; choose again; ask
the teammate), own device quiet (kept; resumes; check the machine), teammate's
device quiet (kept; resumes; ask the teammate). A fourth cell does not exist —
one's own service cannot be unshared from oneself.

Queued, endorsed from CCC's note: conform gains a "source is formatted" check,
and the seven pre-existing drifted files get one dedicated commit — after 2d,
not mid-redesign.

### 2d closed (2026-08-26)

All three repos pushed (byollm 3b50231, byollm-cloud-web 365cb1c, byollm-cloud
5f164c8 unchanged). Migration 0035 applied to production by Todd — the
cron-before-migration hazard is retired; the sweep can run for real. The
closed case matrix stands in the record with its structural closure: three
cells, and a fourth cannot exist because one's own service cannot be unshared
from oneself — a new cell would have to argue its way in, not be discovered in
an inventory.

**2e: go.** Order within it as CCC stated: Valkey implements
releaseLeases({retryAfter}) first (the contract case is already waiting in
@byollm/relay/store-contract — the coupling recorded at 2b comes due);
PolicyStore against Postgres; ControlPlane wired at claim; the WIDENING set in
hub/src/devices-api.ts sheds the dead named/public. After 2e, only 2f stands
between the redesign and the deploy sequence: npm @alpha → web → hub → Todd's
upgrade, re-pair, remap, probe → latest.

### 2e opens; alpha.58 half-publishes; two of four done (2026-08-27)

**Premise checked and corrected before building on it.** "The case is already
sitting in the shipped contract waiting to be inherited" is true of the
contract SOURCE and of no published artifact: `retryAfter` is in neither
alpha.55 (which the hub pins) nor alpha.57 (current). Valkey cannot inherit a
case that is not in the package it depends on. The rest of 2e needs the
publish with more force — `PolicyStore`, `PolicySnapshot`, `Mapping` and
`ControlPlane` live in `@byollm/control-plane`, never published at all, so
building against them would mean re-declaring four shapes in the hub: the
two-definitions defect the early-publish ruling exists to prevent, third
instance this redesign has produced. So the @alpha publish moved to the front
of 2e rather than after it, which is where the ratified deploy order already
put it.

**alpha.58 half-published, and the cause was a documented precondition nobody
enforced.** Trusted publishing authorises a workflow FOR a package, so the
package must exist before `npm trust` can name it — a brand-new name takes one
manual publish first. `docs/releasing.md` says exactly that. The run got
`@byollm/conformance` out, collected `404 PUT @byollm/control-plane`, and
stopped with four siblings still at .57. CCC's miss to have read it; what
changed is that reading it was the whole mechanism. The version step now asks
the registry whether it knows each name before anything ships — derived, not a
hand-kept roster of which packages are set up, which is the shape that goes
stale the release after it is written. Same class as §3b's repository.url
check, whose own comment says "the cost of learning it mid-loop is a version
number nobody can reuse".

Todd owes (2FA account): `npm publish --access public` from
`packages/control-plane`, then `npm trust github "@byollm/control-plane"
--file release.yml --repo oftomorrowinc/byollm --allow-publish -y`, then
re-run the Release run for v0.1.0-alpha.58. Idempotent per package; converges
on the four missing. The tag is NOT moved — it points at the commit CI passed.

**Done, in the hub:**
- `releaseLeases({ retryAfter })` in Valkey. Per-runner not-before on the job
  hash, read in CLAIM from Valkey's own clock (two clocks deciding one
  deadline is what §3.4 moved into the store to prevent), absent from
  RELEASE's HDEL so it survives the requeue, expired entries pruned on write
  (unobservable, and finding 52's `noeviction` growth argument). The method's
  own comment — "an optional field means the compiler will not notice a store
  that ignores it" — came true a third time and now records that it did.
- `WIDENING` retired. `["team", "named", "public"]` held two words that no
  longer exist, and a dead word in a WIDENING allowlist is a door, not stale
  bookkeeping. Now an exhaustive `Record<OfferScope, boolean>`, which earned
  itself on the first build: the PINNED protocol still declares `public`, so
  the honest form names it `false` rather than letting a missing key be
  silence — and the line self-retires when the pin moves. Removing the
  literals broke no test (every fixture using them was invisible for another
  reason), so the rule is asserted directly and the restoring mutation is
  caught.

**Done, in cloud-web:** `hub_reader` gains five mapping columns and
`dashboard_consents.id` (ungranted since 0013 — the hub read consents by owner
and site, never by key, so the tables could not be joined at all). The
separate-credential option was weighed and rejected on the record: RELAY_BLIND
covers payloads, and byollm_016 already ruled the same question about rosters
— routing metadata's opacity "buys nothing the signature doesn't". Absent
columns are the point: `updated_at` is evidence about a human act, and
`swept_at`/`degraded_at`/`notified_at` would let a routing credential read who
has been emailed. 28/28 pgTAP, conform 24/24.

**Blocked on the publish:** PolicyStore against Postgres, ControlPlane wired
at claim. The hub already computes `paused = !shared_compute && shares_now`
in `control-plane.ts`, so the snapshot's `consented` reads from that one
expression rather than a second copy of it.

### 2e half-landed; a record correction on latest; the .58 publish needs Todd (2026-08-26)

**Record correction, from CCC's registry read: `latest` points at alpha.57, not
.56.** The standing line in this record — "latest holds at .56" — was written at
the stop-ship and repeated since without re-verification; the registry says
otherwise. Whether .57 was promoted at some point or the .56 line was never
verified is open (Todd asked). Assessment: not an emergency — pre-1.0, no
strangers, and .57's known defect authored inoperative entries rather than
admitting anyone — and .58 takes latest through the gate at 2f regardless. But
the lesson is our own law read back to us: a negative ("nothing was promoted")
needed verifying before being written down, and this record failed that.

**The premise check that reordered 2e:** retryAfter exists in no published
version, and @byollm/control-plane was never published at all — building 2e
against the pins would have meant re-declaring four shapes in the hub, the
two-definitions defect. The @alpha publish moved to the front of 2e, where the
ratified order already put it. The .58 publish then half-landed (CCC's miss,
owned: trusted publishing authorises a workflow for an EXISTING package, and
docs/releasing.md said so): conformance is out at .58, control-plane 404'd,
four siblings sit at .57. Todd's commands, on the 2FA account: manual
first-publish of control-plane, `npm trust` for it, re-run the .58 release run
— idempotent per package, converges on the missing four; the tag stays where
CI passed. CCC also made the doc stop being the mechanism: the version step now
asks the REGISTRY which names it knows and prints the exact commands — derived,
not a hand-kept roster of which packages are set up.

**Landed and ratified:**
- Valkey releaseLeases({retryAfter}): per-runner not-before on the job hash,
  read in CLAIM against Valkey's own clock, surviving requeue, pruned on
  write. The optional-field hazard is now three-for-three and recorded where
  it lives: **an optional field is a check the compiler won't run.**
- WIDENING retired into an exhaustive Record<OfferScope, boolean>, with the
  sentence that justified the urgency: **a dead word in a widening allowlist
  is a door, not stale bookkeeping.** The pinned protocol still declaring
  public makes the honest form name it false rather than let a missing key be
  silence; the line self-retires when the pin moves. The literals' removal
  broke no test, so the rule is asserted directly and the restoring mutation
  is caught.
- hub_reader gains exactly the five mapping columns plus consents.id, with the
  separate-credential option rejected on the record (RELAY_BLIND covers
  payloads; opacity buys nothing the signature doesn't) — and the ABSENT
  columns are the point: swept_at/degraded_at/notified_at stay ungranted,
  because who has been emailed is not routing's business. The human-act law,
  applied to database grants.

After the publish converges: hub pin bump (the inherited contract case proves
the Valkey work), PolicyStore against Postgres, ControlPlane at claim — with
paused read from control-plane.ts's one expression, never a second copy.

### Publish converged; latest waits for the end; the schema defends itself (2026-08-26)

All six packages at .58 on @alpha (Todd ran the birth publish, trust grant, and
re-run). CCC's refusal to touch `latest` mid-flight is endorsed and recorded:
moving it now would hand a bare `npm i byollm` a new-protocol daemon against an
old-protocol hub — the exact breakage @alpha's inertness exists to prevent.
Order standing: @alpha ✅ → web (migrations live, sweep merged, 2e grant
pushed) → hub (2e half done) → Todd's ceremony → latest.

Promotion-ceremony addition, Todd's checklist ("already added to my loop"):
@byollm/control-plane was born straight onto alpha and has NO latest tag —
promotion must create one or a bare install of package six won't resolve. The
ready-for-latest gate enumerates six, including this.

PolicyStore's risky half done first — the SQL validated as hub_reader against
the real schema before any TypeScript (pgTAP 8/8, 6815c4f). Two findings
ratified into the fixture law's family:
- **A fixture must build state the way a person does, or it tests a state that
  cannot exist.** Writing shared_compute = false read back TRUE — the schema
  defending itself: dashboard_consents_branch recomputes the column on insert
  so nobody self-certifies into the private sentence. The only way to build a
  paused consent is the human path — consent on no roster, then join a team.
  A column-writing fixture would have tested the trigger's override and called
  it paused.
- **The round trip matters more than the state**: the cases walk solo-and-live
  → joined-and-paused → the agreed sentence not rewritten while paused →
  re-consent making it live → revoked → revoked leaving no mapping behind.
  States are moments; the law lives in the transitions.

Open loose end, unresolved: who or what moved latest to .57 remains unknown —
Todd did not confirm promoting it. Moot for the sequence (latest moves through
the gate at the end regardless); npm's audit log can answer it if curiosity or
caution ever wants the answer.

### Loose end closed: Todd promoted .57 (2026-08-26)

Todd: "I did promote to 57. Was totally me." The registry mystery is closed —
human, not machinery. Recorded without drama and with the lesson it actually
carries: the stop-ship ruling ("latest holds at .56 until the probe passes")
lived only in conversation and memory, and memory promoted anyway. The
promotion gate ran and passed because nothing it checks knew a stop-ship
existed — the gate compares backend sets, not rulings.

**Every lesson becomes a check, applied to stop-ships:** a declared stop-ship
gets a mechanical form the moment it is declared — a STOPSHIP marker the
ready-for-latest gate refuses on, placed by the ruling and removed only by the
ruling that resolves it. A stop-ship that lives in memory is a hope. Queued for
CCC alongside 2f's gate update (the gate is already being touched for six
packages and /healthz; the marker check rides the same change).

Provenance completed (Todd): the .57 promotion was autopilot — dozens of
release emails, each followed by the same promote ritual, until the ritual ran
without the decision. Recorded as the real lesson under the STOPSHIP marker:
**a ceremony repeated often enough becomes a reflex, and a reflex is not a
decision.** The deliberateness the latest-is-Todd's rule wanted was eroded by
frequency, not carelessness. Both halves of the fix now exist: CI alphas
removed the routine publishes (frequency), and the STOPSHIP gate refuses the
reflex when a ruling stands (guard). Todd waits for the sequence going forward.

### Queued: promotion becomes the pipeline's final stage (2026-08-26)

Todd: "Looking forward to getting latest built-in to the deploy process in the
right place too." Recorded as the post-redesign design item, with the shape
that keeps the standing law intact: the promotion stays Todd's deliberate act —
what moves into the pipeline is its POSITION and its EVIDENCE. Sketch: a
promotion stage at the end of the deploy sequence that mechanically runs the
ready-for-latest gate, the STOPSHIP check, and a probe-recorded check, then
waits on Todd's explicit approval (an environment gate — a deliberate click at
the right moment, not a terminal ritual at the wrong one), and on approval
moves all six dist-tags atomically, control-plane's first latest included.
All-or-nothing preserved; the reflex path (email → terminal) retired. Open
question for the build: whether dist-tag moves can ride trusted publishing's
credentials or still need Todd's token for the final hop. Sequenced AFTER 2f —
the first .58 promotion runs the current ceremony with the new gate checks;
the pipeline stage is built with the lessons of having done it once.

### Pin bumped; the rip arrives at the hub; two laws and one question (2026-08-26)

2e item 1 closed the right way: proven by the SHIPPED contract, not the
author's own test — both inherited retryAfter cases run against real Valkey,
and an `if false` in the Lua check fails the Valkey case specifically.

The six compile errors were the rip arriving on schedule: selection left the
relay (ClaimInput.serves gone, CLAIM matches by kind, the denormalised service
field deleted with no reader left); Amendment J reached the hub (rosters.ts,
its test, the fold-in, the second polling cadence, three settings — all
retired); and `public: false` retired itself exactly as its comment predicted,
the compiler asking for it back when the pin moved.

Two laws minted:
- **Two settings that must agree are two a deployment can set inconsistently —
  derive the second from the first.** GRANT_SIGNING_PRIVATE_KEY stands alone;
  its public half is derived, never configured beside it. The failure mode it
  forecloses is a fleet refusing every job while every process reports itself
  healthy — the worst shape a config mistake can take.
- **A guard gated on the same flag as its subject guards nothing.** The ledger
  suite's `up` was assigned in beforeAll but read by describe.runIf at
  collection time — six real-ledger cases silently skipped on every local run,
  and the guard that should have said so was itself runIf(REQUIRE_LEDGER),
  only running when the thing it guarded was already forced. Probed at module
  scope now, the way valkey-store.test.ts always did; all six pass.

**Question put to Todd, recorded pending his ruling:** `pnpm db:migrate`
targets PRODUCTION by default — reads admin.env, ignores DATABASE_URL. CCC ran
it meaning to set up a local container and it reached the Supabase pooler
("nothing to apply"; benign only because nothing was pending). CCC recorded
rather than changed it. Recommendation: the default inverts — local/
DATABASE_URL by default, production only behind an explicit flag. Today's own
laws argue it: nothing widens quietly, and a deliberate act should require
saying so. Todd may know a reason the default is deliberate; his call.

Next: PgPolicyStore against the pgTAP-pinned SQL, then ControlPlane at claim —
controlPlanePublic and authorGrant together, which the relay's construction
throw refuses to accept singly.

Ruling on db:migrate (2026-08-26): Todd — the production default was NOT
deliberate, and he doesn't use the script (his path is db:push, which migrates
on Supabase). Ruled accordingly: CCC checks what, if anything, references
db:migrate. If nothing does, it is deleted — an unused tool that defaults to
production is unused wire with a loaded barrel, and rip discipline applies. If
something real uses it, the default inverts: local/DATABASE_URL by default,
production only behind an explicit flag. Either way, production-by-default
dies.

Ruled (Todd's proposal, endorsed): db:push splits into `db:push` (local,
DATABASE_URL) and `db:push:prod` (production, admin.env). The act's target
lives in its name — a deliberate thing said out loud — and the mistake
direction inverts to harmless: a bare db:push run on autopilot now lands on a
local container instead of the pooler. Riders: db:push:prod prints the host it
is about to touch before applying (a surface states its effective target), and
the naming convention covers any script that can reach a non-local
environment; db:migrate, if it survives its reference check, follows the same
convention.

### 2e complete (2026-08-27)

All four, plus the ceremony 2e turned out to need.

**1. `releaseLeases({ retryAfter })` in Valkey — closed and proven by the
shipped contract.** Both inherited cases run against real Valkey; mutating the
Lua check to `if false` fails the Valkey case specifically. The method's own
comment — "an optional field means the compiler will not notice a store that
ignores it" — had come true a third time and now records that it did.

**2. `PgPolicyStore`.** Three questions in one round trip, on the claim path.
The predicate is not restated as a claim: it is pinned in cloud-web's
`policy_read.test.sql`, as `hub_reader`, against the schema owning those
columns. Nothing is cached, and `paused` is why it cannot be — a consent given
on the private-compute sentence stops authorising the moment its author joins
a team, and NO ROW CHANGES, so there is nothing a cache could be invalidated
by. **Failing is not refusing:** a database that cannot answer throws, never
returns `consented: false`; the engine makes a throw transient and a refusal
permanent, so a blip would otherwise unpick jobs from devices for good.

**3. `ControlPlane` wired at claim, both-or-neither.** A key without a store
authorises nothing it can justify; a store without a key says nothing a device
would believe. Both come off one object, so there is nothing to pair up wrong;
the relay already refuses `controlPlanePublic` without `authorGrant`. A hub
with neither says so once at boot — supported, but an unexplained supported
state is not.

**4. `WIDENING` retired**, and it earned its exhaustive type immediately: the
pinned protocol still declared `public`, so the honest form named it `false`;
the pin moved and the compiler asked for the line back. Self-retiring, as its
comment predicted.

**Correction to the record:** the previous entry said the grant key's public
half would be DERIVED from the private. It cannot be — `@byollm/protocol`
exports no public-from-private helper, only `publicIdentityOf` over a full
`StoredKeys`. `GRANT_SIGNING_KEY` therefore carries both halves as one value,
which reaches the same guarantee differently: there is no second setting to
disagree with. A derive helper upstream would shrink it to the private half
and is worth having. **derive-don't-co-configure survives with its second-best
form named.**

**The ceremony, rehearsed.** No minting script existed for the key the roster
key is replaced by. `pnpm grant-key` mints and `pnpm grant-key:check` proves
the configured value works, by signing a real grant with the private half and
verifying it with the public one. That check exists for the failure with no
symptom: mismatched halves mean every device refuses every job while every
process reports itself healthy. Rehearsed both ways before shipping — matching
pair exits 0 with a fingerprint, mismatched pair reports `bad-signature` and
exits 1.

**Rulings folded in this pass:** (1) `db:migrate` is not unused wire — CI runs
it twice — so the default inverted rather than the tool being deleted.
`credential()` now reads `~/.config/byollm/admin.env` only when asked;
`db:migrate:prod` and `db:psql:prod` ask; a prod run says `PRODUCTION` under
the host line. `db:test` gets no prod variant: running the suite against the
hosted ledger is not a thing to make one flag away. One correction to CCC's
own report — it never ignored an override; the variable is
`LEDGER_DATABASE_URL` and CCC passed `DATABASE_URL`.

**Queued, unstarted:** ruling (2), the `db:push` / `db:push:prod` split in
cloud-web, lands next time CCC touches web scripts. Rulings (3) STOPSHIP
marker and (4) promotion-as-final-stage are 2f and post-2f.

**Todd owes before the hub deploys:** mint the grant key
(`pnpm grant-key`), set `grantSigningKey` as a Pulumi secret, and run
`pnpm grant-key:check` against it. Migration 34651037 is already applied.

**Laws ratified this pass, from Todd:** derive-don't-co-configure, and the
self-gated-guard law — *a guard that only runs when the thing it guards is
already forced is not a guard*, minted from the ledger suite whose `up ||`
branch was dead because `runIf` reads its argument at collection time and
`beforeAll` had not run.

### 2e complete (2026-08-26)

All four items closed, three repos pushed. Recorded from the close:
- ControlPlane at claim is both-or-neither off one object, in CCC's sentence
  kept verbatim: "a key without a store authorises nothing it can justify; a
  store without a key says nothing a device would believe." Nothing to pair up
  wrong.
- **Caching is structurally forbidden, and paused is the proof:** a consent
  given on the private-compute sentence stops authorising the moment its
  author joins a team — no row changes, so there exists no event a cache could
  be invalidated by. Three questions in one round trip at claim is the design,
  not an optimisation target.
- **Law minted: failing is not refusing.** A database that cannot answer
  throws; it never returns consented:false. The engine keeps throws transient
  and refusals permanent — otherwise a blip unpicks jobs from devices for good
  with nothing to put them back. Proven against a dead port; 4/4 mutations.
  Sibling of "a refusal may deny, it may never assert": an outage may delay,
  it may never decide.
- **Correction, CCC's own:** the public half cannot be derived (protocol
  exports no helper), so GRANT_SIGNING_KEY carries both halves as ONE value —
  the same guarantee by a different road: no second setting to disagree with.
  Derive-don't-co-configure survives with its second-best form named; a derive
  helper upstream would shrink the value to the private half alone.
- The grant-key ceremony descends from the mint-script lesson: pnpm grant-key
  mints, pnpm grant-key:check proves a configured value by signing a real
  grant and verifying it — built for the failure with no symptom (mismatched
  halves = every device refuses while every process reports healthy),
  rehearsed in both directions before shipping.
- Ruling 1 landed on the invert branch: CI runs db:migrate twice, so it lives;
  admin.env is opt-in; the :prod variants ask, and a prod run prints
  PRODUCTION under the host line; db:test gets no prod variant on purpose.

Todd's pre-hub-deploy ceremony (secrets are his): pnpm grant-key → set
grantSigningKey as a Pulumi secret → pnpm grant-key:check against it.
Migration 34651037 already applied. Then 2f: Kevin's manifest, the acceptance
probe, /healthz and the gate updated in the same change, STOPSHIP marker
included.

Grant-key ceremony complete (2026-08-26): Todd minted, set grantSigningKey as a
Pulumi secret (infra/, prod stack), and grant-key:check verified the configured
value. The hub is cleared to deploy. 2f underway.

### The ceremony's own check corrected; my "total" was wrong (2026-08-26)

Two fixes out of the key ceremony, both recorded:

**A check about a value names the value's source.** grant-key:check read
GRANT_SIGNING_KEY from the shell and said "good" without saying about what — a
success for a reason unrelated to the property claimed, this repo's
most-repeated bug shape by its own env.mjs's admission. Every run now names
its source, and pnpm grant-key:deployed reads the PROD STACK itself: same
fingerprint as Todd's mint, "now an answer rather than an assumption." (CCC's
en-route correction noted: grantSigningKey WAS in the stack — encrypted, last
entry, missed by a grep pattern. The evidence-of-absence law finds one more
instance: a grep is a read with a window.)

**Correction to this record, mine:** the entry "Amendment J's retirement is
now total across code, wire, store, and secrets" (commit 6083773) was written
when Todd deleted the Vercel pair — and it was wrong. rosterReadSecret, a
WORKING bearer for a deleted endpoint, plus rosterSigningPublicKey and
rosterEndpointUrl, sat in the hub's committed Pulumi prod stack for another
week, still decryptable. "Total" was a negative I wrote down without
verifying across every store that holds secrets. CCC's sentence goes in the
law book: **a credential is the one kind of dead thing that keeps working.**
All three removed; retirement is now actually total.

Mechanical form proposed for CCC (derived, not a hand-kept inventory): an
"every config key has a reader" check — a stack key no code reads is either
dead (remove) or a latent door (explain). It would have caught all three
roster leftovers the week they died, and it is the dead-exemption rule
applied to config stores.

### The config-reader check bites on arrival; 2f order approved (2026-08-26)

Four findings on the first run, recorded:
- siteId: removed from code under a comment saying "gone from the stack's
  config" while sitting in Pulumi.prod.yaml for months — "a comment asserting
  a fact about a file it can't see is the whole problem in one line."
  Comments-are-claims, config-store edition.
- VALKEY_PASSWORD / REDISCLI_AUTH: genuine exceptions (set on the Valkey
  container, not the hub's), declared in prose with their reason rather than
  parsing Kubernetes object graphs. Approved as the sanctioned exception form:
  a rule naming no members is best; a named exception WITH its reason and a
  staleness ratchet is the acceptable second.
- PORT: an exception written on a guess, never needed. **The ratchet's second
  direction, ratified: an exception is stale when the thing it excused is
  gone — and when the thing turned out not to need excusing.** It fired on its
  first run against its own author, which is the only real evidence a guard
  bites.
Membership derives from both ends of the chain — unread stack keys, and
infra-set env vars the hub's schema doesn't declare — and adding an unread key
fails verify.

2f order approved: gate + STOPSHIP marker first (the piece that must exist
before anything can promote), then Kevin's manifest, then the acceptance
probe. Cowork assembles Todd's manual acceptance checklist when the deploy
sequence starts rolling.

### Full multi-agent code review — 2026-08-27 (overnight, Todd asleep)

Cowork ran a 10-reviewer + adversarial-verification review over all three repos
at the mid-flight state (byollm e068ed0, byollm-cloud 16b4640, byollm-cloud-web
6815c4f — hub NOT yet deployed, latest still .57). 35 findings confirmed after
verification (1 critical, 34 major), 6 refuted. Full report delivered to Todd as
byollm-review-2026-08-27.md and committed to byollm-cloud/specs/. This is the
index; the report carries each finding's file, claim, and failure scenario.

**The spine of it: signed grant fields are authored but not CHECKED on device.**
The grant is signed over (site, user, kind, purpose, service) so nothing in
transit can alter the control plane's resolution — but the daemon verifies only
owner, jobId, freshness, signature, user===job.owner, replay, and
service-offer-consistency. It never compares grant.siteId, grant.kind, or
grant.purpose to the (relay-controlled, unsigned) stub. Three MAJOR admission
holes fall out, each fixable in the shape of the existing user===owner refusal:
- **grant.siteId unchecked** (runner.ts:591) — per-site jobIds collide, so a
  grant authored for (siteA, job_1, alice) admits a malicious paired siteB's
  job_1 for alice: siteB runs its prompt on a service alice mapped only for
  siteA. The mapping-IS-consent boundary is bypassed cross-site.
- **grant.kind unchecked** (runner.ts:805) — a relay rewrites stub.kind, and the
  resolved service runs under a kind the user never mapped.
- **engine ignores offerScope** (engine.ts:164) — the engine signs a grant
  admitting a non-owner onto a service the owner narrowed to private; the
  device's structural private-is-absolute catch saves admission but releases
  PERMANENT ('refused'), burning the (job,device) pair the transient path
  existed to protect. Second enforcement layer absent; recovery semantics invert.

**CRITICAL — consent data loss on a billing event** (sweep-mappings/route.ts:243):
the sweep's sharers set reads dashboard_team_roster_members, a view that returns
rows only for a LIVE cloud.team entitlement. So 'sharing-ended' — the sole
deletable verdict — fires on ENTITLEMENT EXPIRY (a payment hiccup), not only on
membership ended. A one-night card-renewal delay permanently deletes every
member's team mappings and emails them a false "isn't shared with you any more".
Directly contradicts migration 0021's own ruling that a lapse "is not a refusal
and not a pause". (Note: a sibling finding routing this through entitlements
status=past_due was REFUTED — the live path is the roster view returning zero
rows on expiry, not a status transition. The deletion is real; the trigger is
expiry-of-view, not dunning-status.)

**Browser-trusted mapping writes + an email PII oracle** (cluster):
- approveConnect validates a submitted slot against the manifest but NEVER that
  (service_owner, service) is one of the user's actual candidates; CandidateValue
  checks only "non-empty string or null". Any profile uuid satisfies the FK.
- The mappings table grants insert/update/delete to `authenticated` with RLS
  checking only consent-ownership — a JWT holder writes rows directly, bypassing
  readMappings, and can pre-stage rows under a revoked consent that spring back
  on re-consent (trigger fires only on the revoke transition).
- The degradation email resolves service_owner against the whole profiles table
  and falls back to display_name/email — so a forged uuid in the hidden form
  field returns that account's EMAIL to the forger via "ask victim@… if you still
  want it". An account-existence + email oracle, in a system whose law is refusal
  opacity and no existence oracle. (route.ts:366)

**Other MAJORs (see report):** memory-only replay set re-admits on a sub-120s
restart (double spend); paused consent declined as permanent, silently losing
queued jobs on the exact join-a-team auto-pause the product treats as reversible;
releaseLeases has no terminal guard (a release-after-complete reverts a done job,
hides its result, re-runs it); community maxPayloadChars never enforced against
the real payload (only the unsigned sizeClass), a 40x metered overspend; declined
claims transiently visible to sites via /relay/site/pending (device-fleet
enumeration for an "unsatisfiable" slot); protocol gaps — verifyGrant zero
forward-skew tolerance (contradicts the 5s/30s clock rulings; proactive skew warn
is unimplemented, CLOCK_SKEW_WARN_MS dead), Manifest has no aggregate/uniqueness
bounds, label/description accept control chars + bidi + ANSI (rendered on consent
screens), six wire sub-schemas strip unknown fields instead of throwing; consent
screen re-connect ignores existing mappings / "none" keeps old routing / a
duplicated kind silently voids the whole submission / two teammates' same-named
services indistinguishable; sweep DB writes fire-and-forget (daily notification
loop on a persistent failure); live pre-Phase-B device mislabeled service-gone;
/usage reads the dropped `metered` column (503s forever); drain closes the policy
pool while still serving; and a cluster of deploy/gate coverage gaps — PgPolicyStore
never runs the shipped PolicyStore contract, the hub-vs-real-schema test in no CI,
cloud-web's interim Manifest re-declarations don't match protocol's, old-daemon-
vs-new-hub gives a generic unnamed 400 (no version fence/remedy — contradicts the
loud-refusal ruling), /healthz omits audiences/sizeClass/backendClass so the gate
greens on unchecked enums, pins-deployed.mjs and releasing.md both enumerate four
of six packages (control-plane omitted — the hand-maintained-roster smell, twice).

**Assessment for the morning:** none of this blocks the sequence as CODE-in-flight
(hub undeployed, latest holding), but the three grant-binding holes and the
CRITICAL sweep deletion MUST land before the hub carries real cross-user traffic
and before the sweep runs against real teams. Recommendation: 2f pauses; a
security pass (grant siteId/kind/purpose binding + engine offerScope + sweep
delete-only-on-membership + approveConnect candidate validation + email
owner-relationship check + the authenticated-role RLS tightening) lands first,
each as its own commit with the test that proves it, THEN 2f resumes. Todd rules
in the morning; nothing promotes regardless until he does.

### Manifest copy approved; probe gated on the security pass (2026-08-27)

The gate + STOPSHIP marker landed and pushed overnight. The "manifest" task was
a real hole, not data entry: dashboard_sites.manifest had five readers and no
writer — every site declared nothing, every consent screen rendered empty,
Amendment L was unreachable from the product. CCC built the write path (JSON
textarea, schema-parsed, the schema's own refusal sentence surfaced, empty box =
declared-nothing while {} is refused). Copy approved by Todd with one tightening
of the key/label sentence (no-rename stated as delete-plus-create, the
destructive semantics made the point rather than a caveat). Pin moved to .58,
retiring the interim Manifest/Purpose re-declarations; the kind-label check's
membership half is now the exhaustive Record, the "label differs from id" half
stays (no type can say it).

Ruling: **the acceptance probe is gated on the overnight security pass.** The
probe is the last step before the deploy sequence, and running it — or promoting
off it — on code carrying the review's critical and three grant-binding bypasses
would ship known holes. CCC lands the pass first, ranked: grant siteId/kind/
purpose binding; engine offerScope-at-resolution; the CRITICAL sweep delete-only-
on-membership; approveConnect candidate validation + the email/RLS relationship
check. Each its own commit with its proving test. The remaining 30 triage after.
Nothing promotes until Todd rules on the completed pass.

### Security pass in progress; siteId fix is a protocol change; batch the .59 (2026-08-27)

CCC verified the review's proposed siteId one-liner and correctly REFUSED it:
grant.siteId is the control-plane uuid, job.site is the site's KEY ID — different
namespaces, so `grant.siteId === job.site` refuses 100% of grants. The
vulnerability is real (signed site field checked against nothing); the reviewer's
prescribed fix was wrong. **Law: a review finds holes; it does not get to
prescribe fixes unverified. The implementer verifies before applying** — proven
here on the batch's highest-stakes finding, and it is the review-culture-both-
directions principle running from code back at the review.

Ruling on the fix — GO, as a protocol change:
- The grant binds the site in the namespace the DEVICE holds from pinning: the
  site's key id (job.site), not the control-plane uuid. Everything the verifier
  trusts lives inside the signature, and the device knows sites only by pinned
  key id — so that is the identity the grant carries and the device checks, no
  lookup.
- **Do not repeat the bug being fixed:** the original hole is "a signed field
  nobody checks." Do not add siteKeyId ALONGSIDE the unchecked uuid siteId. If
  the uuid has no other reader, the key id replaces it; if something consumes the
  uuid, keep it AND check the key id. Never carry a signed field the device
  ignores.
- **Batch ALL protocol-level security fixes into one .59, publish-and-repin
  once:** site-key-id binding; verifyGrant forward-skew tolerance + the
  unimplemented proactive skew warn (CLOCK_SKEW_WARN_MS / heartbeat serverTime,
  ruled at 2b, still dead); manifest aggregate/uniqueness bounds + label/
  description sanitization (control chars, bidi, ANSI — the strings rendered on
  consent screens); strict parse on the six wire sub-schemas that strip unknown
  fields. One version bump, one repin of hub and web.

Commit-level items proceed independently (no publish): kind+purpose binding
LANDED (6b1188e, unpushed — and it caught two of our own fixtures that had been
wrong before today: testControlPlane signed purpose:"testing" and a key id in
the uuid field, values no engine produces, so the kind/purpose binding could
never have been tested against reality — "a fixture must build state the way a
person does," third instance); then engine offerScope-at-resolution; the CRITICAL
sweep delete-only-on-membership; approveConnect candidate validation + the email
owner-relationship check + the authenticated-role RLS on both mappings and
dashboard_sites (the raw-PostgREST half of the manifest-validation finding folds
here — declareManifest already validates against the protocol schema, so what
remains is the RLS door). Manifest write-path validation half-fixed by the
morning push, noted.

### .59 batch progress: 3 of 5 (2026-08-27)

1. Site binding (3ad8904): the signed field renamed to `site`, carrying the key
   id (== JobStub.site), compared directly — no lookup through the distrusted
   party. Todd's guard is now a test: the engine suite asserts siteId is absent
   from the signed document. **The morning's headline bug, found one layer up:**
   the GrantAuthor seam was spelled twice, and a field added to the caller's copy
   alone would be silently accepted, the grant carrying nothing — "a signed field
   nobody checks" at the seam layer. Caught by luck (structural compare); the
   seam is named once now, removing the luck.
2. Kind + purpose binding (6b1188e).
3. Clock, both halves (109f4e2): **the warn threshold and the refuse threshold
   are one number (CLOCK_SKEW_WARN_MS) — no silent band.** A skew refusal can
   only land on someone already warned; below it work runs untroubled. The
   proactive half reads serverTime, warns once per crossing, and emits a recovery
   event so a fixed clock stops looking broken. This is the clock-skew ruling
   (2b) fully implemented, having been dead since.

Still to assemble before publish: manifest aggregate/uniqueness bounds + label/
description sanitization; strict parse on the six sub-schemas. Then publish .59,
repin hub and web.

Two author-mistakes recorded, both the codebase's characteristic failure
(concluding from an absent signal): a boundary test nearly passed because an
auto-imported undefined made the comparison NaN (caught by the exact-threshold
case); a heartbeat fixture "parsed fine" on output vitest had swallowed — it
didn't (.strict(), extra key), and re-run as an assertion said so instantly.
The strict-parse item still in this batch worked on its own author.

### .59 assembled and GO to publish (2026-08-27)

Five protocol fixes, five commits, verify green: site key-id binding (3ad8904,
uuid gone, absence asserted), kind+purpose binding (6b1188e), clock both halves
(109f4e2), manifest bounds + label sanitization (3e9d928), strict parse on all
six sub-schemas (f8dd5d5).

GO to publish .59 and repin. Reasoning recorded: publishing unblocks the
web-side fixes, which validate against protocol's hardened Manifest schema;
alphas are CI-automated so the publish is cheap; and — clarity note — **.59 is
an intermediate, NOT the hub-deploy target.** Engine offerScope is a
control-plane fix landing in .60; the hub deploys at the end off the alpha that
carries the engine fix, not off .59. Pins moving .59 -> .60 before the hub ever
deploys is expected.

Two judgment calls ratified:
- Refusing \p{Cf} (breaks emoji-family ZWJ) is the correct trade: the ZWJ is the
  codepoint that pads two labels into looking identical, on the screen where
  telling them apart is the security decision.
- NOT refusing \p{Cn} (unassigned) though it looks like it belongs: unassigned-
  ness depends on the parser's Unicode version, so refusing it makes a manifest
  valid on one deployment and refused on another, drifting as runtimes update.
  **Law: a rule whose answer depends on the reader isn't a rule** — sibling of
  domain-separation-asserted and derive-don't-configure.
- MAX_PURPOSES=32 is the batch's one chosen (not derived) number, reasoned in
  code ("a screen asking more than ~30 questions has stopped being a consent
  screen"; press declares five); the kinds bound is derived (JOB_KINDS.length).

Two more fixture lessons, same as the morning's, from turning the rules on:
Lease never declared identity and eight fixtures passed one (surfaced only by
.strict() — the argument FOR .strict()); testControlPlane signed
purpose:"testing", a value no engine produces. And the double-spelling smell
appeared at three altitudes total — siteId (grant field), GrantAuthor (seam),
GrantRef ({jobId,leaseId}, written twice). **Named: the twice-spelled shape —
a structure declared in two places drifts silently the moment one copy gains a
field the other lacks; name it once.**

Sequence after publish: repin hub+web, then the commit-level items — engine
offerScope (-> .60), critical sweep delete-only-on-membership, approveConnect
candidate validation + email owner-relationship + authenticated RLS. A scope
ruling on the remaining package-level majors (paused-consent-permanent,
releaseLeases terminal guard, replay durability, payload ceiling, pending-claim
leak) is owed after the priority set — which ride the pre-hub bump vs a later
one — but does not block the publish.

### Priority security set complete; scope ruling on the remaining five (2026-08-27)

The five priority items landed, each with its proving test: engine offerScope,
the critical sweep delete-only-on-membership, and the three-wall PII/oracle fix
(keepOffered server-side candidate re-derivation; email ownerLabel gated on
shared-team membership — a sharing-ended mail now carries no name AT ALL by
construction, since that verdict fires precisely when the owner is not a member;
RLS + check-constraint requiring declared slot + actual sharing + live consent,
and the revoked-rows-spring-back hole from 0032's transition-only trigger now
closed, making 0036's own comment true).

**Scope ruling on the five remaining majors — CCC's 3-and-2 split accepted, with
the deferral gate sharpened:**
- Ride .60 (package-level shape fixes, in files just touched): paused-consent-
  permanent (a tri-state in the snapshot so a reversible pause declines
  transiently — highest value; it fires on the join-a-team auto-pause, the
  product's most common path, and silently loses queued jobs); releaseLeases
  terminal guard (release-after-complete reverts a done job — double execution);
  replay durability (the in-memory spent-grant set empties on a ~1s restart
  inside the 120s window — needs persistence).
- Deferred, but NOT to "after the hub deploys" (a moment that lets them outlive
  their safe window). Gated on UNTRUSTED TRAFFIC and routed to open-door
  readiness:
  - Pending-claim leak (fleet enumeration via /relay/site/pending) — exploitable
    only by an untrusted SITE. Blocker: before the first site Todd does not
    control. The fix reorders claim-then-authorize in the relay's hottest path
    and earns dedicated mutation + concurrency work.
  - Payload ceiling (stranger over-spends metered compute) — exposed only to
    untrusted END USERS. Blocker: before any site opens to untrusted end users
    (before Kevin's app has real authors). Touches the run path; wants its own
    attention.
  Both recorded as open-door-readiness blockers so they cannot silently survive
  into the moment they would bite.

**Law from CCC's two mistakes (the fix half-landed because the fix was a
hand-maintained roster):** a permission fix that enumerates the functions to
grant is the hand-maintained-roster smell one level down — "permission denied
for function" refused all three forgeries for the wrong reason (a negatives-only
suite asserts nobody can write anything; the positive controls caught it), then
granting execute reached two of three functions (a check constraint runs as the
writing role too). The durable form is a check that exercises EVERY role-executed
write path — grants and check constraints alike — as the writing role, deriving
the membership rather than listing it. Sibling of the config-reader check.

Sequence: .60 = engine offerScope + the three ride-alongs (paused-consent also
touches the stores incl. hub PgPolicyStore); publish, repin hub+web; deploy web
(sweep/keepOffered/RLS already committed); deploy hub; then the acceptance probe.

### Release-gate classification of the 35 review findings (2026-08-27)

Todd asked which findings must be knocked out before sharing with other people.
The full set of 35 confirmed, bucketed by the gate each sits behind:

ALREADY FIXED (15): the .59 protocol batch (site binding, kind+purpose binding,
clock both halves, manifest bounds+sanitization, strict parse ×6) and the
priority-5 (engine offerScope, critical sweep deletion, keepOffered candidate
validation, email PII oracle, authenticated RLS + revoked-rows-spring-back).

RIDE .60 (agreed, package-level): paused-consent-permanent, releaseLeases
terminal guard, replay durability.

BEFORE KEVIN & LIS USE IT (consent-screen correctness + version clarity) — these
hit a real second human directly:
- Re-connect "none" silently keeps the old mapping routing.
- Re-connect silently re-maps to defaults, ignoring existing choices.
- A duplicated kind in one purpose silently voids the entire submission.
- Two teammates' same-named services render indistinguishably (display side; the
  write side has the (owner,id) fix).
- Old-vocabulary daemon vs new hub → generic unnamed 400; must be a loud
  named-version refusal (Todd's re-pair, Kevin's setup) per the loud-refusal law.

BEFORE .60 IS PROMOTED (promotion is the act of sharing; a half-landed or
falsely-green promotion is itself the risk — the .57 lesson):
- pins-deployed.mjs and releasing.md both enumerate <6 packages (control-plane
  omitted) — six-package promotion can half-land.
- /healthz omits audiences/sizeClass/backendClass — the gate greens on unchecked
  enums.
- /usage reads the dropped `metered` column — 503s forever (usage feature broken).
- Drain closes the policy pool while the hub still serves.
- Safety nets: hub PgPolicyStore never runs the shipped PolicyStore contract; the
  hub-vs-real-schema test is in no CI; the store contract never exercises a
  non-null Mapping.owner (the field the anti-substitution check depends on).

CAN TRAIL (before the sweep runs against a real team, not before the probe):
- fire-and-forget sweep writes → daily notification loop on persistent failure;
- live pre-Phase-B device mislabeled service-gone;
- reader-grants / hosted-grants probes not extended for the 0036 mapping grants.

FENCED behind untrusted traffic (ruled, in open-door-readiness.md): pending-claim
fleet-enumeration leak (before first uncontrolled site); payload-ceiling overspend
(before any site has untrusted end users).

Net "before sharing" set ≈ 14 items: the .60 three + five consent/version fixes
+ ~six promotion-integrity fixes, most of them small. The probe is gated behind
the .60 three and the consent/version five; promotion is gated behind the
promotion-integrity six.

### .60 ride-alongs 2 of 3; tracked state at the repin (2026-08-27)

Landed: the derived write-path check (99ddcfb byollm-cloud-web, pushed, conform
#25 — pg_depend derives function+role membership, nothing named by hand; proved
by reintroducing the real bug and watching conform name function/constraint/role/
fix). Paused-consent tri-state (c46ede8 byollm pushed; consented = yes|paused|no,
because the engine decides not only grant-or-not but whether a refusal is
PERMANENT — reaches contract, reference store, and PgPolicyStore, proved against
real Postgres with the resume round trip; 4 mutations incl. paused quietly added
to the permanent set). releaseLeases terminal guard (f0d0228 byollm pushed) —
case in the shipped contract, three holder-scoped doors now one rule.

TRACKED at the repin (two risks, both self-correcting IF the repin is treated as
a hard checkpoint):
- Two byollm-cloud commits (8173ece, 0237980) are LOCAL, committed --no-verify by
  design: the hub pins .59 whose PolicySnapshot.consented is still boolean, so
  the hub cannot compile against the tri-state until the repin. Committed rather
  than left loose (CCC lost an uncommitted fix earlier today). **At the .60 repin
  both must verify green and prove against real infra before push** — the
  pre-push hook (verify at HEAD) is the backstop; never --no-verify the push.
- The Lua terminal guard is unproven — its contract case ships in unpublished
  @byollm/relay, inherited at repin exactly as retryAfter was. Proven at repin or
  .60 stops.

Mistake flagged: the Lua guard first landed in RENEW too (holder check spelled
identically across the scripts) — Valkey refused the script outright, the LOUD
kind of wrong; CCC notes a quieter inert version was available, which would have
been the bad wrong. This is the twice-spelled shape at the Lua layer (CLAIM/
RENEW/RELEASE/COMPLETE); durable fix if Redis allows is one shared holder-check
fragment — name the seam once.

Next: replay durability, then .60 publish + repin (the held commits go green and
push, the Lua guard proves). AND CCC must receive the release-gate classification
before the probe — otherwise it walks .60 -> probe and skips the five consent/
version and six promotion-integrity items that gate sharing and promotion.

### .60 version content complete (2026-08-27)

engine offerScope (229f1d0) + the three ride-alongs (paused-consent c46ede8,
releaseLeases terminal guard f0d0228, replay durability 1fb3d9f). Version content
done; the .60 checkpoint (bump, publish, repin, prove the two held commits + Lua
guard against real infra) is next.

Two judgment calls ratified:
- **Law refined — name-the-seam-once vs make-the-difference-visible.** The Lua
  holder check is NOT the twice-spelled shape: RENEW and RELEASE SHOULD differ
  (RELEASE carries a terminal guard, RENEW must not), and the bug was that they
  looked identical so a blind replace hit both. The fix is making the legitimate
  difference visible, not merging. CCC correctly declined Redis-has-no-include
  concatenation because it would hide what RELEASE checks from a reader at the
  enforcement site — for a security-critical script, visible-at-enforcement beats
  DRY. So: name the seam once when it must stay identical (GrantAuthor, siteId);
  make the difference visible when it legitimately diverges.
- **Replay durability trade, with its residual named.** Synchronous write (not
  fsync: threat is a supervised restart, survived once bytes reach the OS;
  fsync-per-claim buys a smaller window at hot-path disk latency) and
  sync-before-run (writing after leaves the gap). Corrupt file reads as "nothing
  spent" — right, because a corrupt cache gives no per-grant information, so the
  only fail-closed option is refuse-everything, a self-inflicted device DoS;
  availability wins (failing-is-not-refusing). ACCEPTED RESIDUAL: a corrupt
  durable file reopens the restart-replay window it was added to close — narrow
  (malicious redelivery within 120s + corrupt file + restart), harm-bounded
  (double spend), known and accepted, not a closed hole. A failed write does not
  stop the job (same direction).

Proceed to the .60 checkpoint as laid out; if either held commit fails to prove
at repin, .60 stops and comes to Todd rather than a workaround.

### .60 published; repin checkpoint passed; tier-1 3 of 5 (2026-08-27)

.60 tagged (cbfe144), CI green. **The repin checkpoint passed all three gates,
retiring the tracked risk:** hub verifies green on .60; the Lua terminal guard
proved by the inherited contract against real Valkey (removing it fails that case
specifically); the paused-consent tri-state proved against real Postgres
(breaking the pause predicate fails it). Both held commits proven and pushed
(71c7371). Web repinned, green locally.

Tier 1: 3 of 5 (9e174c6). The two re-connect findings + the silent write failure
turned out to be one screen — "the mapping is the consent" held only for a first
visit. "None" discarded: get returns null for a never-rendered field and "" for
one left on none; the test "absent and blank must mean the same thing" was the
bug written as a rule. Defaults overwrote choices: the page shows the answer
back, `returning` carried separately because a withdrawal leaves no row (an empty
slot is an answer for a returning consenter; a purpose added since renders
unselected — residual named, not hidden). The upsert error discarded: atomic, so
any failure left zero mappings while consent recorded. Duplicate-kind void now
closed both ends (.59 schema uniqueness + the unchecked-error half here).

**Lesson: a fix for a finding must be checked against that finding's harm on
every path it touches — especially the hidden/auto paths.** An escaped mutation
caught finding 2's exact harm surviving INSIDE the fix for finding 2: the
single-candidate auto-map path (hidden input, no control) never consulted
availability, so a vanished chosen service silently re-mapped. The pathless paths
are the ones a fix misses.

The protocol publish-lag, diagnosed and accepted: protocol lands on the registry
~100s after npm acks, consistently, for the largest package (94KB vs relay 55KB)
— a slower ingest path, nothing different on our side (same maintainer,
provenance, workflow). .60 protocol verified live three ways before proceeding.
Fix: read-back with backoff (general rule — publish-then-consume must never
assume instant availability); npm support ticket if it persists. Connection
recorded: a systematically dropped/delayed protocol release EMAIL means email was
never a reliable promotion signal — the same root that enabled the .57 autopilot,
and one more argument for the pipeline-gate promotion (evidence, not inbox).

Remaining tier 1: same-named teammate display (owner labels resolved from the
hub's shared-with answer, not user input — the distinction the sweep email got
wrong; wants a test); old-daemon-vs-new-hub loud named-version refusal.

### Tier 1 complete; the version fence needs .61, which becomes the hub-deploy target (2026-08-27)

Tier 1 done, all five pushed. The last one surfaced a protocol change:
PROTOCOL_VERSION bumps to "1" because the vocabulary moved and the number did
not — a pre-rip daemon (speaking 0) passed the handshake then failed schema
validation every ~10s with an error naming no field, no vocabulary, no upgrade
command (the loud-refusal law's inverse, come back because the number stayed
still). 0 is deliberately NOT in the supported list: a 0 daemon sends
offer:"public", so accepting its version only relocates the unactionable error
one layer down.

**Ruling: fold tier 2 in, cut ONE .61, and .61 (not .60) is the hub-deploy
target** — a hub speaking 0 would refuse an upgraded daemon, the fence aimed
backwards. Boundary held crisp:
- .61 the PUBLISH carries only package-level items: PROTOCOL_VERSION="1"
  (protocol), the store-contract non-null Mapping.owner case (control-plane),
  and any other published-package tier-2 item.
- Deploy-only tier-2 items (pins-deployed six-package, releasing.md, /healthz
  enums, /usage 503, drain-pool, hub-schema CI) ride the hub/web commits that
  deploy off .61 — in before the hub deploys, but not gating the publish.
Sequence: finish tier 2, cut .61 once, repin, deploy web+hub off .61 with the
deploy-only fixes, then the acceptance probe.

Two lessons filed (both familiar shapes): 68 fixtures spelled the version literal
"0", so a legitimate contract change broke 139 tests instead of the handful about
versions — a constant duplicated 68 times; they read the source constant now, so
the next bump is loud only in the version suite. And the same-named-teammate fix
had a mutation escape (tested candidatesFor, which could always carry labels,
while the bug was the caller — test-beside-the-law); fixed with a source lint in
the connect-redirect shape, since a required param buys nothing.

Candidate check offered to CCC (its judgment whether it earns its keep): a
schema-fingerprint-vs-PROTOCOL_VERSION test that fails if the wire shape changes
without a version bump — makes "the number stayed still while the vocabulary
moved" impossible rather than remembered; lives next to schema-drives-statement;
cost is a false positive on every additive change (arguably the point).

### .61 package content complete; the schema-fingerprint test earned its keep (2026-08-27)

.61 package content done: PROTOCOL_VERSION="1", the non-null Mapping.owner
contract cases, the vocabulary pin. The offered schema-fingerprint test was built,
and its scoping is the reason it's usable rather than routed-around: it watches
only what breaks parsing ON THE OTHER BUILD — **enum membership (both directions)
and required fields — and deliberately ignores optional fields**, which break
nobody. The asymmetry is the principle: a member removed breaks a client still
sending it (this rip); a member added breaks a server that hasn't learned it
(alpha.47, a silenced fleet); an optional field breaks neither. Required-ness is
asked of the schema, not read off its constructor (.optional(), a default, and a
union-with-undefined are three spellings of one fact). Proved both directions
(enum add fails, optional add passes).

**The test caught its own author, which is the strongest proof it points the
right way:** the hand-written snapshot was wrong on the first attempt — five
backend ids CCC didn't know existed, two misremembered required fields — so it
was rewritten FROM the schemas. A snapshot written from memory would have been a
fourth definition of the wire, the exact bug it exists to prevent.

Remaining before .61 is cut — the six deploy-only items (hub/web commits):
pins-deployed six-package; releasing.md six-package retag loop; /healthz enum
coverage (audiences, sizeClass, backendClass); /usage 503 on the dropped metered
column; drain closing the policy pool while serving; PgPolicyStore runs the
shipped contract + hub-schema test reaching CI. Then: cut .61, repin, deploy web,
deploy hub, probe.

Cowork to assemble Todd's acceptance checklist when the hub deploys — end to end,
Lis's split session (her Claude, Todd's qwen, press blind) as the finale, plus
this pass's live checks: version fence refusing an old daemon with a named
remedy; re-connect + same-named-teammate consent-screen behavior; a
paused-then-resumed consent recovering its queued job.

### Deploy-only tier-2 underway; safety nets had holes where they mattered most (2026-08-27)

Three hand-kept lists derived (59b6e3a): pins-deployed omitted @byollm/control-
plane — the ADMISSION package — so a control-plane pin bumped in git and never
shipped was invisible to the check built for exactly that (alpha.47's cause, in
the check's own header); it also stopped shrugging (a runtime dep missing from
the image was reported "?" and carried on — a check that greens on "unknown" is
blind to what it exists to catch). The documented retag loop named four of six —
wrong precisely when load-bearing (it's the fallback when the run summary is
gone). The hosted-grants probe never learned the claim path — a hub could boot
against a DB missing 0036 and decline every hosted job forever while the probe
built for that reported green. /usage 503, /healthz enums also done.

**Drain-pool (CCC's own morning bug): close a resource after its traffic stops,
not beside the things that never had any.** The policy pool was closed beside the
timers; it has traffic for the full 20s drain, and a closed pg.Pool rejects
everything — so every roll wrote 30s not-befores into shared Valkey, stalling
jobs on the HEALTHY pod too. A single-pod lifecycle mistake going fleet-wide
through shared state.

Two flagged:
- A probe case asserted the hub could read dashboard_team_memberships —
  contradicting CCC's own 0037 withholding decision from six hours earlier. A
  test pointed the wrong direction: it asserted an access the design deliberately
  withheld. It now pins the WITHHOLDING (the security property is the absence; a
  test that passes when the withholding is removed tests nothing). "A negative
  needs verifying," applied to a deliberate denial.
- The policy contract used ids "site_demo"/"bob"/"alice" — rejected by Postgres
  uuid columns — so the hosted store could NEVER run its own contract, even in
  principle. "A contract only its author can run is a description" made concrete:
  the reusable suite was inert against the one implementation that ships. Now
  uuids. CONFIRM as the adapter lands: the full contract run now covers tri-state,
  non-null-owner, and paused — the earlier "proved against real Postgres" was a
  bespoke targeted test (stands), and the general guarantee is only becoming real
  now; ensure nothing the targeted tests covered falls outside the contract.

Left before .61: the PgPolicyStore contract adapter (ids unblocked it) + the
hub-schema test into CI. Then cut .61, repin, deploy web, deploy hub, probe.

### CI caught the demo's protocolVersion "0"; the search-boundary smell; hub-schema guard ruling (2026-08-27)

CI (correctly, before the tag) caught the demo example typing protocolVersion:"0"
— the version fence answered 400 unsupported-protocol-version where the case
expected 401, because the fence runs BEFORE auth (right order: a server can't
decide who you are over a protocol it doesn't speak). **Lesson, the session's
recurring smell reframed: the boundary of a SEARCH is itself a hand-kept list.**
CCC fixed the 68 version literals by sweeping packages/ and stopping; the one
literal outside that boundary bit. Fixed: the demo reads SERVED_PROTOCOL_VERSION
(both ends move together) and gained the upgrade-me case. Closed the class: "no
file may spell the current version" — derived, narrow, old literals legal (a
frozen "0" is the point of a staleness fixture), matched as `protocolVersion:`
beside the value not the bare number (flagging every "1" would get it disabled
within a week — check-adoption wisdom), no exemptions; the next bump turns today's
correct literals into failures exactly when they stop being fixtures.

**Ruling on the hub-schema CI credential: accept the pre-deploy probe, do NOT
mint the cross-repo token.** Reasoning: the contract BEHAVIOR is already covered
(6842d88 runs the shipped contract against a CI Postgres); what remains is whether
the hub's schema assumption matches cloud-web's ACTUAL DEPLOYED migrations, and a
probe against the real deployed schema is more truthful than a CI reconstruction
("verify the artifact the reader receives" — a provisioned copy can drift from
what's deployed; the deployed schema cannot drift from itself), while avoiding a
standing cross-repo credential in CI forever. Pre-1.0 single-team, the deploy
sequence already couples hub and schema at deploy time, so the PR-vs-deploy
feedback gap is small and the credential surface is not worth it. **Refinement
that makes the probe as strong as the CI test: exercise PgPolicyStore's actual
read path against the real schema (run the hub's real queries with hub_reader,
check they don't error) — derived from what the hub needs, not a hand-listed
column/grant set.** Reserve the token for a write-side schema property that
genuinely can't be checked read-only; Todd owns the credential call and may
overrule for PR-time coverage.

.61 not tagged (CI re-running on e06e9d3); tag when green, publish, repin, run the
checkpoint on the held commits (tri-state adapter, Lua guard contract case,
PgPolicyStore contract adapter 6842d88). Then deploy web, deploy hub, probe.

### The security pass: tiers, .60 and .61 (2026-08-27)

byollm-review 2026-08-27 confirmed 35 findings (1 critical, 34 major). Todd's
release-gate ruling put them in tiers; this records what landed and what the
work turned up that the review did not.

**.60 — engine `offerScope` and three package-level fixes.** The engine asked
whether a capability *existed* and never read the `offerScope` on every row.
Nothing widened (the device's private-is-absolute check is structural) but the
failure *shape* was inverted: a device's refusal is permanent, the engine's
decline is a thirty-second wait, so an owner flipping a service private for a
minute permanently unpicked a teammate's queued job from the only device it
was ever meant for. Then: the paused-consent tri-state, the `releaseLeases`
terminal guard, and replay durability across a restart.

**.61 — the version fence.** `PROTOCOL_VERSION` stayed `"0"` while byollm_016
changed the vocabulary, so a pre-rip daemon *passed* the handshake and then
failed schema validation with a message naming nothing, every ten seconds,
forever. The handshake's own comment says a mismatch used to surface "as a
generic bad-request" and that "an error a user cannot act on is barely better
than a hang" — it came back because the number stayed still. `0` is
deliberately excluded from the supported list: accepting it only relocates the
unactionable error one layer down.

**Laws minted or sharpened, in the order they were earned:**

- **The clock's two numbers are one number.** `CLOCK_SKEW_WARN_MS` bounds both
  "we warn" and "we tolerate", so a refusal can only ever land on somebody who
  was already told about their clock. No silent band.
- **A seam spelled twice drifts silently.** `siteId`, `GrantAuthor`,
  `GrantRef` — three altitudes of one shape in one day. The `GrantAuthor` case
  was caught by luck: the two copies are structurally compared, so a field
  added to the *caller's* copy alone would have been accepted and the grant
  would have carried nothing.
- **A signed field nobody checks is not a weak guarantee but the appearance of
  one.** Ruled with its corollary: never add a checked field beside an
  unchecked one — if the old field has no reader, it is replaced.
- **A rule whose answer depends on the reader is not a rule.** Refusing
  `\p{Cn}` would make a manifest valid on one deployment and refused on
  another as runtimes update.
- **A lapse is not a departure.** The sweep's only deletion evidence was an
  entitlement-filtered view, so a card renewal retrying at midnight destroyed
  every member's consent choices at 05:38 and mailed them a false sentence.
  The join now lives once, with the entitlement as the single visible
  predicate over it.
- **A guard that only runs when the thing it guards is already forced is not a
  guard** — the ledger suite's `up ||` branch, dead because `runIf` reads its
  argument at collection time.
- **Derived membership, applied to privileges and to config.** Two new checks,
  each proved by reintroducing the real bug: every config key has a reader,
  and every write-path function is executable by the role that writes.

**Mistakes of CCC's worth keeping, all one species — concluding from an absent
signal:**

- twice reported a package unpublished from a **cached 404** on a URL it had
  itself been polling, the second time after writing the first one down;
- declared a fixture "parses fine" from a probe whose output vitest had
  swallowed — `.strict()` was rejecting it, which is the law advertising
  itself on its implementer;
- a threshold test that nearly passed because an auto-import put a constant in
  the `vitest` import, making the comparison `NaN < -30000`;
- restored a mutation with `git checkout` on an uncommitted file and deleted
  the fix it had just written;
- swept `packages/` for version literals and stopped there — CI found the one
  in `examples/`, after the tag. A hand-drawn boundary on a search is the same
  smell as a hand-kept list.

**And three of CCC's own decisions contradicted themselves within a day**, each
caught by running the thing rather than reasoning about it: a probe case
asserting the hub could read a view 0037 had deliberately withheld; a
`PORT` exception covering a case that never existed; and a permission fix
applied to two of the three places it applied.

**Still open:** the hub-schema seam test needs a cross-repo credential to reach
CI (`byollm-cloud-web` is private) — Todd's call between minting one and
accepting the pre-deploy probe as the guard. The pending-claim leak and the
payload ceiling are fenced behind untrusted traffic in
`byollm-cloud/specs/open-door-readiness.md`; three sweep-reliability items
trail before the sweep runs against a real team.

### .62: the checkpoint found a fourth gap; the rip-debris through-line (2026-08-27)

The ordered checkpoint proved tri-state, non-null owner, and paused against
PgPolicyStore on real Postgres (11 green), and the 12th threw: an inline
"site_other" id never became a constant, so the uuid sweep missed it — and the
property that went dark was SITE ISOLATION. User isolation ("keeps one person's
consent out of another's") passed all along, so isolation READ as covered while
its twin had never once run against the store that routes real work. The deepest
form of the session's recurring lesson: half a property covered masks the total
absence of the other half. Cutting .62 for the package-level fix (plus a guard
checking every id's shape wherever written, exemption cut by the opaqueIds gate
itself) was correct — a must-fix the hub can't go green without is mechanism, not
a scope call; flag it, don't block. **.62 is the hub-deploy target.**

Three repin findings, same species: server.ts never imported the three
vocabularies its /healthz block uses (that endpoint never compiled — and the
PROMOTION GATE reads it); draining.test.ts derived members but hand-listed which
vocabularies exist (three reported-but-unasserted); six protocolVersion:"0" in
the cloud repo including operator scripts (round-trip/long-job/kill-test) you run
WHEN THE HUB LOOKS BROKEN — they'd fail on deploy indistinguishably from the hub
being broken (a diagnostic that lies exactly when reached for). byollm had a test
forbidding this; cloud didn't — ported, stricter ("never a version the hub would
refuse"). ready-for-latest.mjs could map only three of six and refuses on
unmappable, so the first promotion against a correctly-compiled hub would have
refused; fixed, and CI now asks the running hub what it reports.

**Through-line for the record: this security pass is largely a systematic purge
of DUPLICATED FACTS, and that is the characteristic debris of a large rip.**
Deleting public/roster/allow/selection left every place those facts were spelled
twice — one copy of which the rip changed — and "they agree until they change" is
why they slept until now. siteId, GrantAuthor, GrantRef, the Lua holder-check,
68 version literals, the search boundary, /healthz imports, the draining
vocabularies, the six cloud scripts, the inline contract id: one root, one cure —
derive the membership, don't list it. The review found the holes; this pass is
finding the debris; both share the root.

The probe is the derived real-read-path guard as ruled: builds a real
PgPolicyStore and calls read() (query+joins+RLS+parsing), names no column or
grant, proven to throw on each of the three tables revoked in turn with no
short-circuit on the nonexistent triple, rehearsable via CONTROL_PLANE_READER_URL
(which caught CCC's own table-wide-vs-column-level mutation slip); withheld-column
negatives stay. Web repinned .60->.62 even though unbroken (it never puts a
version on the wire) so the deployed trio agree — a harmless version disagreement
is still a fact waiting to bite.

Held: three byollm-cloud commits (verify red on the one case until .62 lands).
Convergence: repin hub+web to .62, re-run checkpoint expecting 12 green, push,
deploy web, deploy hub. .stopship stays until Todd clears it post-probe — the
marker doing its job.

### BLOCKER: the security pass's own protections were never in production (2026-08-27)

The pre-deploy schema probe — made honest after reporting 15/15 green while one
"boundary" case was actually reading an ABSENT table — caught that two migrations
never reached the control-plane production database:
- 0038 (dashboard_team_memberships view): the degradation sweep reads it, so the
  2d sweep is broken in prod (fail-safe: errors, mails nobody).
- 0039 (dashboard_mapping_is_declared, dashboard_manifest_is_shaped, the
  consent_mappings_own policy, the dashboard_sites manifest constraint): THIS
  security pass's RLS/constraint half — the database backstop that stops a site
  operator PATCHing a manifest or a JWT holder writing arbitrary mapping rows via
  direct PostgREST. The application half (keepOffered, approveConnect) is
  auto-deploying with the web repin; its DB backstop is ABSENT, so the
  browser-trust hole is open in prod until 0039 lands.

This is exactly the failure the review existed to prevent — "fixed in code,
absent in production" — caught only because the probe was made to distinguish
withheld-by-rule from absent. **Law: a withholding boundary is proven only by a
permission denial on an object that EXISTS; an error from an absent object proves
nothing.** A permission test asserts "denied by rule," never merely "errored,"
or it goes green the moment the guarded thing is deleted. Third absence-of-signal
catch this pass. Corollary from the information_schema->pg_catalog correction: a
privilege-filtered catalog read as ground truth reports "absent" for what you
merely cannot see — prove existence against unfiltered catalogs (pg_catalog,
to_regclass, pg_proc).

ACTION (Todd's — production write): run the prod schema push in byollm-cloud-web
(0035/0037 applied; a clean push is exactly 0038+0039; preview before applying,
confirm non-destructive). Then re-run the probe expecting 15 green (the team-
membership boundary now a real permission denial). **The hub does NOT deploy
until that probe is green** — deploying against a prod DB missing 0039 deploys
with the hole open. Then hub deploy, then Todd's acceptance probe.

Converged meanwhile: .62 published (six confirmed by npm view; the convergence
monitor reported stale "still waiting" and was stopped rather than trusted —
don't trust a stale signal); hub repinned, checkpoint 12 green + 1 legitimately
skipped (separator-confusion, structurally impossible with uuid columns), SITE
ISOLATION proven on PgPolicyStore for the first time; hub verify green and pushed
(6842d88 + four successors on main); web repinned .62, conform 26/26, pushed
(auto-deploying).

Two non-blocking, both agreed: (1) five hub suites skip silently when infra is
down (loud in CI via REQUIRE_*) — do NOT churn five files pre-deploy; fix with ONE
derived check (a REQUIRE_-gated suite skipping without the flag explicitly off
fails) — the harness-asserts-its-own-execution law. (2) apps/docs pins
protocol@.38 (MUST_IDS identical to .62 — stale, not wrong; repin when
convenient) and apps/dashboard carries an unused @byollm/relay@.9 (dead
dependency — remove per rip discipline next time that manifest is touched).

.stopship holds; and now the hub deploy itself is gated on the 0038/0039 push +
green probe.

Todd applied the prod schema push (0038+0039). Gate now sits on CCC re-running the
schema probe against production: 15 green expected, the team-membership case now a
permission denial (not absent-table). A migration that "ran" is a claim until the
probe reads it back. If green -> hub deploys off .62 -> Todd's acceptance probe.
If red -> stop and report before deploying.

### Blocker closed; hub deploying off .62 with a canary (2026-08-27)

Probe fully green (15/15): the team-membership case reads "permission denied for
view dashboard_team_memberships" (denial, not absent), and 0039's objects
verified directly (dashboard_mapping_is_declared, dashboard_mapping_owner_shares,
dashboard_manifest_is_shaped, consent_mappings_own policy). The security pass's
protections are now actually in production.

CI-red caught before deploy (CCC's): policy-store-contract.test.ts registers
cases only with a control-plane DB, so CI (none) saw an empty file and vitest
called it broken — "green on the machine that wrote it, red on the machine that
has to believe it," the worst shape a gate can have. Fixed to a declared skip
(visible skip + stderr warning, not a hard error; 12 against a real DB). CI green
(0b304fd).

Residual named, non-blocking: under the no-token ruling the PgPolicyStore
contract-BEHAVIOR proof lives on a dev machine + the production probe, not CI, so
a behavior-breaking change would pass CI on a skip. The clean fix is NOT the token
— the contract needs the schema DDL, not a credential — so vendoring/publishing
the schema so byollm-cloud CI can stand up a throwaway control-plane Postgres and
run the contract closes it with no standing secret. Follow-up.

Hub deploy rolling off .62: roll.sh verified the edge list and tag CI, builds the
image, watches the edge 300s, and runs a real job through the just-deployed hub
(reports any request dropped during rollout). Cowork assembling Todd's acceptance
checklist to deliver when roll.sh lands green — then the acceptance probe, then
clear .stopship.

### Hub live off .62; roll.sh's stale prover; acceptance probe delivered (2026-08-27)

Deploy landed, hub live and HEALTHY off .62 (image sha256:be15ff1f…): two
replicas, surge-no-gap, no Kubernetes credential in the pod, each credential
scoped to its own job, /healthz reporting all six vocabularies with
offerScopes/audiences private,team (direct proof the never-compiled /healthz
block now runs correctly), /readyz 200, five unsigned claims 401 at the real edge.

CCC did NOT roll back, correctly: roll.sh's round-trip PROVER died on
`SyntaxError: ... 'byollm' does not provide an export named 'Allowlist'` — a stale
deploy-day script (Allowlist removed by Amendment I; it also still passes
offer:"public"). Evidence-before-diagnosis: the prover has failed identically
since 2026-08-26 02:04, FIVE runs, two days before this deploy (last green
2026-08-25 19:05), so a rollback would keep the same red prover and revert a good
deploy. The stale-operator-script class again — the version-literal guard caught
protocolVersion "0" but not removed exports, because .mjs operator scripts aren't
in the typecheck net (a diagnostic that lies when reached for). Follow-up: .mjs
operator scripts into CI's typecheck/resolve pass.

Ruled with CCC's recommendation: the smoke test's dependency changed from "a
consent" to "a MAPPED consent" (production holds 3 consents / 0 mappings; the
engine refuses unmapped by design). So **the acceptance probe's stage 1 IS the
restored smoke test** — map a purpose to a service, fix roll.sh's three mechanical
bits (Allowlist drop, public->team, pass controlPlanePublic which PairPollResponse
carries), then a real job through the deployed hub is the wire's first end-to-end
proof since .55, exercising the mapping path the redesign is about. Better proof
than the old script.

Acceptance probe delivered to Todd (byollm-acceptance-probe.md, committed to
byollm-cloud/specs): setup + version-fence live check; stage 1 wire proof; stage 2
this pass's properties (tombstones, re-connect correctness, paused-then-resumed
recovery, offer narrowing); stage 3 Lis's split session (her Claude on her box,
Todd's qwen/glm on his, press blind). After all green: clear .stopship, promote
.62 through the six-package + STOPSHIP gate. Hub live, .stopship holds, no clock —
Todd runs it at his pace.

### Version-fence migration gap: a pre-fence daemon can't show its own refusal (2026-08-27)

Todd, running probe step 1 (point the old daemon at the new hub, look for the
loud refusal), got a .57 daemon (protocol 0) showing OLD deleted vocabulary
(selectable-for, isDefault, roster "stale 17h", the toddsampson2008 allow entry)
and NO loud upgrade message. The acceptance checklist's step 1 was WRONG and is
corrected: **the loud client-side refusal lives in the .59+ daemon; a .57 daemon
predates it and physically cannot surface its own upgrade message.** It shows the
stale-roster symptom and carries on (failing safe — stale-fails-narrow serves
Todd only; toddsampson2008 not admitted).

The honest finding: the version fence's own promise — a device never goes stale
for a reason the owner can't see — comes up short for exactly the migration case,
because the good message is in code the old daemon doesn't have, and that can't be
retrofitted. What IS live-testable on Todd's machine is the HUB half: the .62 hub
returning a named unsupported-protocol-version refusal (vs a generic 400),
visible in ~/.byollm/service.log even though the .57 client swallows it into
"stale roster." The client-side loud surfacing is proven by CCC's handshake test,
not a .57 machine.

**Follow-up for CCC (the real fix for the migration gap): a hub-delivered notice
— "a device on an old version was refused; upgrade it" — through the value-add
notification channel.** The hub KNOWS it refused an old device and can reach the
owner independent of the daemon's ability to self-report; notices-are-hub-
delivered applied exactly where it fits. Non-blocking for the probe, but it's what
makes the fence's promise true for a currently-old daemon rather than only a
future-stale one.

Next: Todd tails service.log (the honest step 1 — confirm the hub returned the
named refusal), then `npm i -g byollm@alpha` (latest is .57; the .62 daemon is on
@alpha), re-pair, and status should show protocol 1 with roster/allow gone and
effective offer scopes — the first visible proof of the rip.

### Version fence fires correctly — but its remedy is false in the migration window (2026-08-27)

service.log confirms the hub-side fence works: "hub.byollm.cloud this server
speaks protocol 1 and the daemon asked for 0. Upgrade the daemon: `npm i -g
byollm@latest`." Clear, named, actionable — step 1's hub half passes.

**Bug Todd caught: the remedy names `@latest`, which is .57 — the version being
REFUSED. Following it loops back to the refused daemon. The fix is on @alpha.**
And it recurs: the normal flow is deploy-hub -> probe -> promote, so there is
ALWAYS a window where the hub speaks a newer protocol than `latest` points at,
and during it a refused daemon is told to reinstall the very version that was
refused. The remedy is only correct AFTER promotion — a refusal whose remedy is
false exactly when it's needed. Same family as "a refusal may deny, it may never
mislead."

Fix (CCC, hub-side, DEPLOY-ONLY no republish — the string is authored by the
hub): the remedy names a target that actually speaks the hub's protocol — the
hub's own served version (e.g. "upgrade to byollm@0.1.0-alpha.62") or a tag
guaranteed at-or-ahead — derived from truth, not a bare @latest that may point
anywhere. Product-law surface (user-facing refusal) — Todd blesses the wording.
Not blocking the probe (Todd uses @alpha); self-corrects for THIS instance once
.62 is latest, but the recurring window needs the version-specific remedy.

Todd's path now: npm i -g byollm@alpha, re-pair, status -> protocol 1, roster and
allow entry gone.

### Setup confirmed on .62; "code not found" is an already-approved re-pair UX bug (2026-08-27)

Todd upgraded to @alpha (.62), re-installed, re-paired. SETUP DONE AND CORRECT:
the terminal showed "this version admits per job from a signed grant instead, so
the roster was dropped" (Amendment J retirement announcing itself live), and the
dashboard device card renders the FULLY REDESIGNED model — claude/codex
llm.generate·private + llm.chat·private, glm-5.2 + qwen-2.5-14b llm.generate·team,
under "What this device runs", with NO roster, NO allow entries, NO "selectable
for". The rip is visible on both daemon and web. (smoke-test device correctly
shows "never connected" with a loud finish-setup notice.)

The "code not found" was a false alarm — pairing succeeded (device online +
approved). Cause: re-pairing an ALREADY-APPROVED device completed automatically
via the existing approval, WITHOUT a dashboard step — but the connect flow had
printed the full new-device ceremony ("enter code 7M1E-4C9P, then approve"), so
by the time Todd entered the code the re-pair was done and the dashboard
correctly said "no pairing is waiting for that code." The instructions disagreed
with the flow. **Bug for CCC (surface-declares-what-will-happen): the connect
flow must not print the enter-code-and-approve steps for an already-approved
device; say "already approved — re-pairing completes automatically, no code
needed." The already-paired guard exists (it printed "re-pairing will not
change that"); it just doesn't suppress the now-moot ceremony steps.** Non-blocking.

Next: STAGE 1 (wire proof) — Todd maps a purpose to a service on one of his two
served sites (needs a site with a declared manifest; qwen the natural target),
confirm dashboard mappings >=1, then CCC fixes roll.sh's three bits and one real
job goes through the deployed hub.

### Mapping-UI gap diagnosed: the mapping screen is only reachable site-initiated (2026-08-27)

Cowork read the current connect-flow code on Todd's machine to diagnose why
reconnecting showed no mapping form. Finding: **the mapping screen renders ONLY
in the site-initiated flow — /connect?site=<id>&return=<url-on-verified-domain>
(connect/page.tsx renders MappingSlots when the site is found, its manifest
parses, and slots>0; approveConnect writes consent+mapping on submit).** The
dashboard has no equivalent: connections/page.tsx "Connected" section renders
ONLY a Disconnect button — no re-map / choose-again control — and the dashboard
connect path does not route through /connect. So:
- Todd's reconnect showed no form because reconnect never reaches /connect.
- A user who connects from the dashboard, or connected before mappings existed
  (Todd's press connection, 8/25), has NO UI path to author a mapping.
- The degradation email's promise "Choose again any time on Connected sites" is
  UNFULFILLED — no such control exists on the Connections page.

Immediate unblock for the wire proof: Todd navigates to
`/connect?site=14a83c81-9df8-49cc-b08f-3ac03ba16ac4&return=https://oftomorrow.press`
(Of Tomorrow Press's siteId + a return on its verified domain — what press's
button would supply), maps writing-assistant -> Chat:Claude, Generation:qwen,
submits (redirects to oftomorrow.press; mapping saved). State is optional in
approveConnect, so the hand-built URL works.

**Blocker for CCC (stage-3 / Lis):** add a "Choose what powers this" control on
each connected site routing to /connect?site=&return= (or an in-dashboard
mapping editor). Lis cannot map her split session without a dashboard path, and
this is the "choose again on Connected sites" the degradation email already
promises. Also review whether the dashboard connectSite action should route
through the mapping screen rather than writing a consent with no mapping.

### Mapping-UI fix: copy approved, push (2026-08-27)

CCC built the fix — a "Choose what powers this" link on each connected-site row
routing to the reused consent/mapping screen (NOT a second editor: a second
mapping UI would be the seam spelled twice, the copy surviving a change whichever
one someone remembered to edit). Copy APPROVED as proposed, wording gates the
merge:
- Connections row link: "Choose what powers this"
- Headline: first connect "{site} wants to send work to your devices"
  (unchanged); revisiting "Choose what powers {site}"
- Primary button: "Connect {site}" (first) / "Save choices" (revisit — refuses
  "Connect", an act done months ago)
- Secondary: "Not now" (first) / "Cancel" (revisit)
- UNCHANGED on both paths: stored disclosure, fingerprint, boundary paragraph.
  "A screen that softened its terms on a second visit would tell them less about
  a grant they still hold."

Live bug fixed en route: approveConnect with a missing return hit a bare return
(Save = silent no-op, no consent, no mapping). Now explicit — absent is not
invalid (no attacker-supplied address to be tricked by; the landing is one we
name).

**Smell named: three true-sounding halves that only become a lie when followed.**
The email linked a real page, the page listed real sites, approveConnect cited a
real remedy — each honest alone, collectively false, because the control they all
pointed at did not exist. A promise whose referent exists but is empty. **Cure,
now mechanical: a test tying the promise to the remedy from BOTH ends — fails if
the link leaves Connected sites AND if the email stops making the promise — so
the pair is re-read together instead of drifting.** conform 26/26, typecheck
clean, builds; mutation-tested by pointing the link elsewhere.

Scope noted: covers sites with a live consent; a disconnected site (no row) is
the existing connect flow's job; denyConnect already lands on /connections.

Unblocks stage 1 step 6 (mappings 0 -> >=1) via the dashboard link OR Todd's
hand-built /connect URL.

### Zero-mappings bug: is_platform_admin un-scoped the consent lookup — THIRD instance (2026-08-27)

The mapping didn't save, and the cause was invisible on screen. The consent/
mapping lookup filtered on site_id, but the RLS policy's is_platform_admin clause
stopped the "own consent" filter narrowing for Todd (an admin), so the query
became "anybody's consent for this site." Of Tomorrow Press has two consenters
(Todd 9c5748f5, another 5b9db721); maybeSingle() matched two rows and returned
nothing, breaking both halves: the PAGE loaded no prior mappings (every slot
showed its default — the qwen Todd saw was never a saved choice, it was the
screen never learning he had one, the more misleading symptom), and
approveConnect skipped the whole mapping block (consent recorded, zero mappings
wired).

**This is the THIRD instance of the review's admin-widens-first-person pattern**
(Connections RLS is_platform_admin; "Teams you are on"; now the consent lookup).
**Law reinforced: a first-person query must scope on the column the RLS policy
uses to mean "yours" — a widening admin clause silently un-scopes any OTHER
filter, and maybeSingle() over such a query returns nothing on 2+ rows (latent
until a site has a second consenter — i.e. until the first real multi-user
site).** Fix (e7eb431, deployed): both queries name the owner and exclude revoked
rows (two queries about one fact must not differ in meaning). The check reads the
ownership column out of the migration's POLICY TEXT rather than guessing filters
— CCC's guessing first draft flagged six false positives (a primary key, an
insert returning its own row, a group-scoped lookup) and would have been disabled
within a week; deriving from the policy is what makes it survive. The
derive-don't-guess / a-noisy-check-gets-disabled disciplines, together.

Elegant side effect: the approved connect-vs-revisit wording now doubles as a
health check — "Choose what powers {site}" + "Save choices" means the consent
lookup found the consent; "wants to send work" means it's still failing. Todd's
retry watches the heading as the tell; CCC verifies mappings>=1 in the DB, not
the screen — the episode's whole lesson.

### Mapping confirmed in DB (mappings 0->1); wire proof running (2026-08-27)

CCC verified from the database, not the screen: mappings=1 on Todd's consent
(9c5748f5), row = (writing-assistant, llm.generate, qwen-2.5-14b,
service_owner=null). service_owner=null is the correct encoding for "own
service" — a service id means nothing outside its owner's namespace, so
null-owner vs teammate-owner are different services (the anti-substitution
identity in the data). Stage 1 steps 4-5 done, and the row being on Todd's
consent specifically proves the admin-scoping bug is fixed, not masked.

Step 6 (wire proof) running via repaired round-trip.mjs — the full grant-at-claim
path, first end-to-end job since .55. CCC pre-flagged that the round trip picks a
live consent and the site has two (Todd's mapped, the other unmapped); a pick of
the unmapped one yields a correct "unmapped" refusal, not a wire failure, and CCC
will say which. Ruling: if it picks wrong, make round-trip.mjs TARGET Todd's
consent (9c5748f5) deterministically — a harness picking arbitrarily between a
mapped and unmapped consent flakes forever ("a mutation must be deterministic"
applied to the fixture).

### Wire proof aimed at a no-manifest site; singlePurposeManifest never wired (2026-08-27)

The wire proof failed because round-trip.mjs routed through a no-manifest site
(the engine correctly answered unmapped). Diagnosis and rulings:

**The proof isn't blocked on the manifest bug — the harness targeted the wrong
site.** Todd has a real mapped consent on Of Tomorrow Press (writing-assistant ->
qwen). Ruling: run the proof against the MAPPED path — Of Tomorrow Press + Todd's
consent 9c5748f5, deterministically — the richer primary purpose-mapping proof.
Constraint: if targeting press needs its site keys (Todd's secrets), do NOT hand
them to the harness; use the smoke path (below) instead. CCC picks by friction.

**singlePurposeManifest is a real bug — built, exported, documented (Amendment L
flat-list sugar), called NOWHERE (grepped all three repos).** So every flat-list
and null-manifest site gets slots=[] and is silently unroutable, though
engine.ts:122 (`input.purpose ?? RESERVED_PURPOSE` = "default") is ready to route
a default mapping. This is the review's REFUTED finding ("singlePurposeManifest
bypasses validation" — refuted for zero callers) turning out to mark real dead
code that's a MISSING WIRING — **"not exploitable" is not "not a bug"** — and the
pass's built-but-never-wired through-line again (kin: /healthz never compiled).
Fix: wire singlePurposeManifest as the fallback for a no-parseable-manifest site.

Copy APPROVED: slot label = the site's OWN NAME (consistent with the reserved-
purpose ruling — "default" never renders, the flat slot shows the site name),
description "Everything this site does." **Kinds: BOTH (JOB_KINDS)** — a legacy/
undeclared site sends what it sends; offering one kind would silently break a
site that sends the other; the user still consents and maps each slot, so both is
safe. Require-declaration-before-a-kind is right for NEW sites (they declare
anyway), wrong as a legacy migration accommodation.

Decisions to CCC's two questions: do the FIX, not the one-off /sites paste (the
paste is a one-off; the fallback fixes the class). DNS is Todd's regardless —
restore the _byollm.smoke.byo-llm.com TXT record (stale -> paused -> stops
routing). The service_owner null-vs-explicit question stays open for after the
proof (CCC costs the migration; explicit removes the null-resolution fail-open
risk, "duplication" objection weak because service_owner is a distinct field).

Smoke-site manifest: paste NOTHING (CCC, ratified). round-trip.mjs enqueues a
purpose-less job -> RESERVED_PURPOSE "default"; the schema refuses "default" as a
declared key, so a declared named manifest would never match the smoke job. The
singlePurposeManifest fallback (null-manifest -> one "default" slot) is the
correct path. Validates the reserved-purpose design end to end: "default"
undeclarable is what keeps the null-fallback and declared-manifest paths from
colliding. Todd verified the smoke domain (TXT restored, un-stale). Next: CCC
ships the fallback -> smoke site shows one "Hub smoke test / Everything this site
does" slot -> Todd maps it (Choose what powers this -> qwen) -> round-trip routes.

### Seam spelled THRICE: default-purpose fact disagreed in the RLS policy (2026-08-27)

The smoke-site write bounced with an RLS violation: the "manifest-less site has a
default purpose" fact lived in the engine, the consent screen, AND 0038's RLS
policy (which read `s.manifest is not null`) — the third disagreed and refused
every mapping insert. **Insidious because a policy has no surface: the app and
screen agreed visibly while the RLS rule disagreed invisibly, so the divergence
surfaced only when Todd's click hit the write — past every gate, because nothing
renders an RLS policy.** Migration 0040 (dbc1616) accepts "default" there; safe
because the branches are exclusive BY CONSTRUCTION (Manifest refuses "default" as
a declared key), kind left open (a legacy site sends what it sends). Proved with
positive controls first (restoring 0038's rule made the first two cases fail with
the exact error — 0038's own lesson: a suite where only refusals pass asserts
nobody can write). Todd applied it (db:push, "that worked") and mapped the slot.

**Ruling on CCC's self-flag ("twice tonight I shipped one half of a two-sided
fact; if it happens a third time I'll build the check"): DON'T wait for the
third.** Two occurrences of the SAME class in one evening — the app authorizes a
write the RLS refuses — is a lesson twice over, and rule-of-three contradicts the
pass's own law (every lesson becomes a check). The existing write-path check
catches scoping (admin-widens-first-person); this is a distinct class: **app-
predicate and RLS-predicate disagreeing about the same write.** Build the check —
a both-ends test (promise↔remedy shape) asserting the app's may-I-write predicate
and the RLS may-I-insert predicate agree, so the two sides are re-read together.
Sequence it AFTER the wire proof (one round-trip away; don't context-switch out).

Wire proof is the immediate next step: CCC confirms the smoke rows and runs
round-trip (purpose-less -> "default" -> matches Todd's mapping -> routes). First
end-to-end job since .55.

### WIRE PROOF PASSED — first grant-at-claim job end to end (2026-08-27)

Stage 1 CLOSED. The first job since .55 went through the deployed hub: hub
authored the signed grant, the device claimed and verified it (signature, site,
kind, purpose, owner, replay, offer-consistency), ran it, and sealed the result
back — "the site sealed to the device that claimed it." The rebuilt admission
model (signed grants, purpose->service resolution, private-is-absolute) carried a
real prompt to Todd's qwen and back. The redesign works on real infrastructure.

The remaining `service:` failure is a LATER round-trip scenario using the deleted
select-by-name — stale harness (Allowlist / protocolVersion "0" class), and the
red is the deployed strict-parse CORRECTLY REFUSING removed vocabulary (a
confirmation, not a regression). Rip-discipline ruling: delete the scenario if it
tests select-by-name (a test for deleted machinery dies with it); rewrite in
purpose terms if it tests something still valid.

Queued after the harness cleanup, in order: (1) the app-vs-RLS agreement check
(don't wait for a third strike); (2) .mjs operator/harness scripts into CI's
typecheck/resolve pass — `service:` is exactly the rot that would fail at CI not
the wire. Then STAGE 2 (tombstones, re-connect correctness, paused-then-resumed
recovery, offer narrowing) and STAGE 3 (Lis's split session), then clear
.stopship and promote through the six-package + STOPSHIP gate.

### Wire proof CONFIRMED independently — the qwen server's own log (2026-08-27)

Stage 1 fully closed with the strongest possible confirmation: not the harness's
self-report but Todd's qwen server's OWN log — POST /v1/chat/completions 200,
prompt processing 15/15 — and the site rendered the actual generated text ("Hello!
It's great to see a message from the future..."). Verification reading the
artifact the work truly produced. Four properties held live:
- first job: ok, sealed both ways (full grant-at-claim path)
- mapped purpose: ok, resolved through Todd's AUTHORED mapping (not a fixture)
- unmapped purpose: queued, NEVER ran, no fallback — the negative that proves the
  positive; admission refusing unmapped work is what makes every other guarantee
  real
- hub: held no key that opens either direction (RELAY_BLIND)
The "FAILED" positive control was stale harness (asserted THIS device ran it; the
mapping correctly resolved to Todd's real qwen device) — same rot as service:,
fixed to match reality.

The arc: stop-shipped .57 promotion -> rebuilt admission (Amendments I-L) ->
35-finding review -> security pass that caught its own production gap (0038/0039)
at the last gate -> a real job running end to end on Todd's own hardware, under a
signed grant, chosen by a mapping he authored, hub blind throughout.

Clean stopping point offered (late; latest holds; nothing at risk). Remaining
before .stopship clears: harness cleanup (service: scenario, positive control) +
the two queued checks (app-vs-RLS, .mjs-into-typecheck); STAGE 2 (tombstones,
re-connect correctness, paused-then-resumed recovery, offer narrowing); STAGE 3
(Lis's split session — needs Lis). Then promote through the six-package + STOPSHIP
gate.

Harness cleanup pushed (5af3495, verify green). CCC building the queue in order,
app-vs-RLS agreement check first (ruled: build now, two strikes is enough).
Design note ruled: the check must run the REAL write path against REAL Postgres,
BOTH directions — app-authorized inputs must be ACCEPTED by the policy (0038's
own positive-control lesson), app-refused inputs REFUSED. A mocked-RLS or
refusals-only version would have passed 0038 clean. Runtime both-ends test at the
app<->RLS boundary (PgPolicyStore-contract shape), not a static text compare (the
scoping check's shape) — app-vs-RLS agreement is richer than a static predicate.

### Stage 2: tombstones pass (2026-08-27)

byollm allow / disallow both print the tombstone — fact + remedy (team page) +
the redesign's own reasoning as user copy: "it could never check the names on
that list, so the list only ever agreed with whoever was asking" (Amendment I's
GitHub-analogy argument rendered for a user at the moment they'd wonder why the
command vanished) + "Membership lives with your relay now... one signed grant at
a time." Tombstone-with-remedy law working live; stage-2 tombstone check GREEN.

Wording note (Todd flagged length; his call): the essential lines are fact +
remedy; the one-line why earns its length (turns a dead end into an
explanation); the trimmable line is the last — "A device with no relay serves
its owner and nobody else, which is what byollm status will tell you" — a
no-relay tangent at the moment someone's trying to add a teammate, pushing the
remedy down. Optional CCC trim to four tight sentences; not a blocker, copy not
wrong.

### Stage 2 essentially complete on Todd's side (2026-08-27)

#8 re-connect correctness GREEN (mapping shown back; "none" removes it; re-add
persists — the review's consent-screen quartet closed live). Division of the rest:
- #9 paused-then-resumed: CC's, not a UI walk — needs a job queued during a pause
  window with team-membership timing (a harness test). Core already proven
  (tri-state resume round trip vs real Postgres, c46ede8); an end-to-end hub
  version is optional/CC's.
- #10 site-binding refusal: test-covered (the .59 grant.siteId fix), CC's.
- Offer narrowing: already confirmed in Todd's `byollm services` output
  ("metered — team, cap $25.00/day" IS the narrowing).
So Todd's hands-on stage-2 work is done. Remaining person-needing item is STAGE 3
(Lis's split session — add Lis to the team, she connects press and maps, a job
proves her chat on her box + her generate on Todd's), which needs Lis. Then CC's
queued checks (app-vs-RLS, .mjs typecheck) finish, and .stopship clears -> promote.

### Both queued checks landed, both caught real bugs (2026-08-27)

1. App-vs-RLS agreement check (0dbc314): executable both-ends (same inputs to app
   and DB; disagreement = bug), 7 cases; restoring 0038 fails the two
   default-on-undeclared cases — tonight's bug caught before a click. Adding a
   case asks both sides at once, so a change can't land one-sided.
2. .mjs into CI typecheck (ca81acf): reintroduce service: -> TS2353. Found a real
   one first run — grant-key.mjs built its rehearsal grant with siteId (renamed
   to `site` in .59), so the ceremony that proves the PRODUCTION SIGNING KEY works
   was rehearsing on a statement no device would ever see, one field short, its
   own comment claiming "the real shape." Key itself fine (deployed fingerprint
   BYOLLM-PTTZ-… still matches); the rehearsal's PROOF was hollow. "Testing near a
   law is not testing it" applied to a security ceremony — hidden forever because
   nobody compiles .mjs. Fixed.
   Config judgment ratified: dropped noImplicitAny/strictNullChecks (90 edits
   about untyped JSON, nothing about staleness — a gate that expensive gets turned
   off); kept the rot-finding signal. Kept one runtime fix: reading a caught throw
   via instanceof Error rather than assuming .message (an error handler that would
   throw while reporting someone else's failure).

State-sync to CCC: stage-2 #7 (tombstones) and #8 (re-connect) are ALREADY GREEN
(Todd walked them in the UI tonight). Remaining stage 2 = #9 paused-then-resumed
(CC's harness; core proven c46ede8), #10 site-binding (test-covered), offer
narrowing (confirmed in services). So stage 2 is essentially done bar #9.

Recorded as the night's lesson: FOUR bugs were found by Todd clicking the real
path, not by automated checks — the mapping-UI gap, the admin-scoping consent
bug, the thrice-spelled RLS default rule, the never-wired singlePurposeManifest.
Each then rooted by CCC. The acceptance probe earned its keep four times; a human
walking the real path catches what a test suite structurally cannot. Clean full
stop available: wire proven, stage 2 green bar one CC harness test, both queued
checks landed, latest holding. Remaining: #9, Lis's split session, clear
.stopship, promote. Open non-blocking: service_owner null-vs-explicit (cost as a
migration).

### Plan to wrap the probe and promote .62 tonight (2026-08-27)

Todd wants to promote tonight. Ruling on the bar:
- Stage 1 proved the wire live but Todd-to-Todd (own job, own device, own
  mapping). The one flagship property NOT yet proven live is CROSS-USER: a
  non-owner running on Todd's device via team admission. It is unit/integration
  tested + security-hardened, but tonight found four bugs by live clicking that
  tests missed — so promoting to latest with cross-user never run live is the
  "shipped believing it works" risk the review exists to prevent.
- **Promotion gate: one LIVE cross-user job.** No Lis needed — CC orchestrates
  server-side: a second (test) user added to Todd's team, consent+mapping to
  Todd's TEAM-offered qwen, a job enqueued as that user, confirmed routing to
  Todd's qwen under a signed grant (non-owner via team admission), verified on
  Todd's qwen server log (as stage 1). The full Lis split (her device) is a later
  DEMO not a gate — private-is-absolute on a second owner's device is
  structurally proven (unreachable-path test).
- #9 paused-resume: accept c46ede8 (real-Postgres resume round trip proves the
  exact property); don't re-run live.
- NON-gates for promotion: the two untrusted-traffic blockers (pending-claim
  leak, payload ceiling — fenced before untrusted sites/users, which promotion
  doesn't do); service_owner null-vs-explicit (non-blocking design question).

Sequence: CC runs the live cross-user proof -> green on Todd's qwen log -> Todd
clears .stopship -> promote through ready-for-latest + STOPSHIP gate: six
packages, 2FA, control-plane's FIRST latest tag (born on alpha; bare install
won't resolve without it).

### Cross-user proof plan; full split deferred (no llm.chat on press) (2026-08-27)

Kevin confirmed press has no llm.chat purpose yet, so the FULL Lis split (her
Claude for chat + Todd's qwen for generate) cannot run — deferred until Kevin's
port adds llm.chat. But the promotion gate is the CROSS-USER proof, which needs
only llm.generate and runs tonight with real Lis (she borrows Todd's team-offered
qwen; needs no device of her own):

A. Stage 2 closeout (CC records): #9 accept c46ede8 (real-Postgres resume proof);
   #10 site-binding covered by .59 grant.siteId tests; offer narrowing confirmed
   in services.
B. Cross-user proof (the gate): (1) Todd adds Lis to his Team (email); qwen is
   team-offered. (2) Lis signs in, connects Of Tomorrow Press (verified ->
   Available to connect), Choose-what-powers-this -> maps writing-assistant/
   Generation -> "Todd · qwen-2.5-14b" (her seeing that option tests team-
   candidate derivation; missing = bug). (3) CC runs round-trip.mjs owner=Lis,
   writing-assistant, llm.generate -> routes to Todd's qwen as a NON-OWNER via
   team admission -> confirmed on Todd's qwen server log.
C. Promote: clear .stopship -> 2FA, six packages, control-plane's FIRST latest
   tag, ready-for-latest + STOPSHIP gate.

The full split remains the video demo / a later gate once press has llm.chat +
Lis maps chat to her own device.

### Cross-user gate upgraded to a MATCHED PAIR (Todd) (2026-08-27)

Todd: prove valid AND invalid, not just valid — the negative-proves-the-positive
discipline (stage 1 was solid because the UNMAPPED job never ran). A cross-user
proof that only admits proves nothing about who's kept out, and the membership/
seat boundary is the one that, if it leaks, lets anyone use anyone's device (the
billing+trust fence). So the gate is a matched pair on the SAME service:
1. Valid — Lis (team member, mapped): job routes to Todd's qwen and runs
   (confirmed on qwen log). Admission admits the member.
2. Invalid — a non-member: job enqueued targeting the same qwen -> the HUB
   refuses to author a grant (not a member) -> never reaches Todd's device
   (confirmed: nothing on qwen log for that user + a hub refusal). Admission
   refuses at the CONTROL PLANE, before anything touches the machine.

Stronger option (recommended): same user for both — add to team (job runs),
REMOVE (next job refused at claim). Proves instant revocation too (Amendment J's
"remove -> next claim fails"), the one membership property only unit-tested, never
live. Admit -> revoke -> refused = full lifecycle, one identity, three jobs.

Key: the refusal must happen at grant AUTHORSHIP (hub declines for a non-member),
so the job never reaches the device — the seat boundary enforced at the source,
not the device refusing after the fact.

### Gate harness ready; three fixes that made a green run mean something (2026-08-27)

CC found three things without which a green cross-user run would have proven
nothing — all ratified:
1. OWNER was a relabel, not a filter — the harness renamed the owner but routed
   under whichever mapped consent it found first, so a run could validate Todd's
   mapping wearing Lis's name. Now selects the person's OWN consent (their having
   no mapping IS the answer). The determinism discipline: route under the identity
   under test, don't relabel.
2. Audience must be team — a Lis-owned job hitting Todd's device is refused
   device-side by matchAudience (audience-self-other-owner) BEFORE the hub is
   asked. Correct refusal, WRONG LAYER: the gate tests the seat boundary at the
   CONTROL PLANE, so the job must reach grant authorship (audience=team), not be
   refused device-side. Parsed not cast (AUDIENCE=teem fails loudly).
3. refusedBy attribution — the real fix. A job that doesn't run looks identical
   from outside (queued, silent) whether the hub declined, the device refused, or
   it's slow. why-not-claimed.mjs reads refusedBy, which the relay appends to
   ONLY on a permanent grant-author decline; a runner id there means the control
   plane authored nothing and won't retry. Attribution law applied where a
   refusal was invisible. Read-only via kubectl exec, ids only.

Smoke-site substitution ratified: the harness signs the enqueue as the site and
holds ONE site key; press's keys are Todd's secrets and routing them through the
harness is the workaround we don't take. The smoke site proves the identical
property with keys the harness holds; Lis still sees "Todd · qwen" (team-candidate
derivation test). Never-handle-secrets holding under deadline.

Sharpening on half 2: keep Lis's MAPPING, remove only her team MEMBERSHIP — if
the hub still declines, membership is proven the gate independent of the mapping
(the seat boundary pure). Deleting the mapping would just re-test "unmapped"
(stage 1 covered). CC's plan is membership-only; confirm the mapping stays.

Execution: Half 1 (admitted) — Todd adds Lis to team, qwen team-offered + qwen
server up, Lis maps Hub smoke test -> Todd·qwen, gives CC her id; CC runs
OWNER=<id> AUDIENCE=team -> lands on Todd's qwen log. Half 2 (refused) — Todd
removes Lis's membership (mapping stays), CC re-runs and probes refusedBy for
Todd's runner id -> hub declined at authorship, nothing new on qwen log. Keep the
daemon running through BOTH (half 2 needs a real claim attempt to trigger
author-and-decline). Green both -> clear .stopship -> promote (six packages,
control-plane's first latest, ready-for-latest + STOPSHIP).

### STOP-SHIP RESOLVED — the three-leg gate is met (2026-08-27)

The cross-user gate passed as a full lifecycle: ran -> removed -> refused ->
restored -> ran. Member admitted and ran on Todd's qwen (leg 1); non-member's job
did not run (leg 2); restoring membership made the SAME job run again (leg 3) —
membership demonstrated and reversible, confirmed against Todd's qwen server log.

Leg 2 mechanism, recorded honestly: the hub declined to ROUTE (never offered the
job to a device; refusedBy empty) rather than declining to author a grant against
a claim — one layer further upstream, arguably stronger (the job never reaches a
device). The proof's rigor is from leg 3's reversibility (controlled toggle: only
membership changed, run/no-run followed it), not from refusedBy. Precise note:
leg 2 exercised the ROUTING pre-filter's membership check, not the engine's
grant-author refusal (the routing filter caught it first) — the design's
two-layer structure (Phase 2 ruling: routing is optimisation, engine is
authority, must not disagree); engine backstop stays unit-tested. Non-blocking
confirm owed: routing filter and engine check read the SAME roster source (no
drift seam).

The deepest bug of the night, found by leg 3: re-adding a removed member was
IMPOSSIBLE — a consumed invitation blocked re-invitation forever, accepting
couldn't reinstate a suspended membership. In a product whose subject is
reversible consent, removal was silently permanent. Two migrations fixed it;
found by Todd clicking, not a check. CC's own near-miss recorded: 0042 copied
0019's function body and reverted two later migrations (suite caught it) -> open
check: a migration must replace the NEWEST definition of a function.

**RULING: the stop-ship placed on .57 (63ba3af, 2026-08-26) is RESOLVED.** Wire
proven end to end; member admitted, non-member refused at the control plane,
membership reversible — all live; the security pass closed the 35-finding review
AND its own production gaps (0038/0039); every promotion-integrity check in; all
three repos pushed green; hub on .62. The .stopship marker may be cleared and
.62 may take latest.

Remaining after promotion (non-blocking, carried): service_owner null-vs-explicit
(cost as migration); the full Lis split (needs press llm.chat via Kevin's port +
Lis's device — the video demo); the two untrusted-traffic blockers (pending-claim
leak, payload ceiling — fenced before the first uncontrolled site / untrusted end
users, open-door-readiness.md); the migration-newest-definition check; the
routing-vs-engine same-roster confirm.

### Write-up reviewed; open list completed; promotion go (2026-08-27)

CCC's status write-up (artifact a8d36b6f; read via Todd's paste — the artifact
frame domain is blocked from this environment's network allowlist) reviewed and
confirmed accurate against this record. Through-line crystallized: 7 of 8 bugs
were one shape — a fact written in two places agreeing until one changed, or a
mechanism built/documented/never wired to what already awaited it (the rip's
characteristic debris). The 0042 design call affirmed: re-invite over a "restore
button" because the seat cap is enforced only on invite-insert, so a restore path
would bypass it — guarantee-is-a-shape under pressure, keeping enforcement where
it lives rather than adding a second door.

Open items completed from CCC's list (nothing lost): 23505 invite wording now
covers two states (genuinely pending vs already a member) in one sentence; five
hub suites skip silently when infra is down (loud in CI via REQUIRE_*, but the
shape that hid the contract bug — derived-check follow-up). Already carried:
service_owner null-vs-explicit; create-or-replace-replaces-newest-definition
check; full Lis split (needs press llm.chat + Lis device); routing-vs-engine
same-roster confirm; pending-claim leak + payload ceiling (open-door blockers).

Ruling stands: stop-ship RESOLVED, .62 GO to promote. Final sequence: clear
.stopship -> ready-for-latest passes clean -> Todd moves latest to .62 across all
six packages (2FA), control-plane's FIRST latest tag included.

### SHIPPED — .62 promoted to latest; the stop-ship is closed (2026-08-27)

All six packages at 0.1.0-alpha.62 on latest AND alpha (no split between new-user
install and release channel). ready-for-latest passed clean (six vocabularies
match protocol: backends 19/19, kinds 2/2, offerScopes 2/2, audiences 2/2,
sizeClasses 4/4, backendClasses 2/2). pins-deployed against both live pods: hub
running .62, git says .62 — the deployed hub was built from the pins the repo
holds. The alpha.47 drift (a pin bumped in git, never shipped, invisible to every
other check) is closed in the direction that counts: promoted version, deployed
image, repository all naming .62.

The pass ran from a 35-finding multi-agent review through Amendments I-L (kill
local allow, kill the held roster, claim-time signed grants, need-manifests +
user mappings, kill public), a security pass that closed the review AND caught
its own undeployed production migrations (0038/0039), two releases (.61 protocol-
level fixes, .62 for one uuid-shaped contract id), a hub deploy, and a three-leg
live cross-user gate (admitted -> refused -> restored). .stopship was placed by
the ruling that called the stop-ship on .57 and removed by the ruling that
resolved it.

Two corrections from CCC accepted (my earlier notes were wrong):
1. @byollm/control-plane already had a latest (.58, from Todd's loop) — .62 was
   NOT its first latest tag. My repeated "first latest tag" was stale from its
   born-on-alpha state.
2. ready-for-latest compares SIX VOCABULARIES against ONE package (@byollm/
   protocol, the wire), not six packages. Six packages is the promotion SET; the
   gate's subject is the wire. I conflated them.

Capstone lesson minted: **a check that refuses early enough, for long enough,
stops being a check on anything after the refusal.** ready-for-latest hadn't run
since .stopship was placed and had rotted (npm pack ships no deps; a hand-list of
two would go stale) — the stop-ship marker HID a broken gate behind it, the pass's
own shape delivered by the pass's own instrument. Fixed by reading deps from the
tarball manifest (derive-don't-list). A stop-ship protects and conceals; both
true.

Follow-ups, ordered (none blocking): (1) the roster's two readers — routing
pre-filter vs engine grant-author membership; leg 2 refused at the routing layer,
so a drift seam between them would have looked green (front of queue — the only
item touching a just-certified property). (2) migration-replaces-newest-definition
check. (3) service_owner null-vs-explicit (costed migration). (4) invite wording
split. (5) five silently-skipping hub suites. (6) Kevin's llm.chat port -> Lis's
full split demo. Both post-promotion confirms in specs/byollm-acceptance-probe.md.

byollm_016 SHIPPED.

### Two-reader investigation (read-only): the property holds; one latent config risk (2026-08-27)

CCC confirmed from code, changed nothing:
1. The engine INDEPENDENTLY re-checks membership at authorship — engine.ts:173
   `if (job.owner !== owner && !snapshot.member) return decline("not-a-member")`,
   snapshot from the engine's own store read, no relay input, no early return
   around it, fails closed on store failure. So a non-member reaching authorship
   by ANY route (routing-filter bug included) is refused there. The Phase 2
   ruling holds in code: pre-filter is optimisation, engine is authority. The one
   deliberate short-circuit — job.owner===owner before the store — is
   private-is-absolute (a store saying member:false about your own account must
   not block your own device).
2. One source (public.dashboard_team_roster_members view — the definition that
   was written three times at finding 14, now single), two READS: routing =
   ControlPlaneReader ROSTERS, aggregated, polled every 2s; engine =
   PgPolicyStore.read() exists() per claim, live. Same endpoint. **The seam is
   asymmetric in the SAFE direction: the live engine is never staler than the
   2s projection, so drift only OVER-OFFERS (projection lists someone already
   dropped -> routing offers -> engine refuses = extra transient decline, never
   an admitted non-member).** That also explains leg 2: removal had reached the
   projection before enqueue, so the pre-filter caught it and the engine's check
   was never reached.

**Cowork's take (for morning, no action tonight): the property is solid — the
authority backstop holds, and the seam can only over-decline under today's
deployment. The one item worth acting on is CCC's flag (a): the safe asymmetry
depends on BOTH readers sharing an endpoint, and NOTHING enforces it.** If ops
ever points the projection at a read replica while the policy store stays on
primary (a reasonable scaling move), the asymmetry INVERTS and the seam can admit
a non-member. That is the "two settings that must agree" law — one
CONTROL_PLANE_READER_URL used twice must stay equal — so it wants a CHECK (or a
single structurally-shared value), same family as the config-reader check. Flag
(b) — live-exercising the engine refusal inside the ≤2s window (the only
certified property on inference not observation) — is worth doing once, low
priority. Neither touched tonight.

---

## 2026-08-28 — Two-readers follow-up CLOSED; and a lesson about two agents in one clone

**The roster's two-readers item — the only open follow-up touching a certified
property — is done and shipped** (`hub/test/one-roster-source.test.ts`, pushed at
47ca0a6, verify green 227/227-passed at that HEAD).

The shape it landed in is worth recording because it beat the prescribed fix. The
original prescription (Cowork) was a two-settings-must-agree check at boot. CCC's
pushback: there is ONE setting (`CONTROL_PLANE_READER_URL`), read twice, four lines
apart — a boot check would compare a value to itself and pass forever, an inert
check, the exact green-light-that-checks-nothing smell this pass spent a night
deleting. The hazard is a *future edit* (pointing the 2-second poller at a read
replica is the attractive one), and a future edit is guarded in CI, failing on the
diff that introduces it — not at runtime after a deploy. Ruling: CI test only, no
inert runtime twin. Concession recorded with attribution; same lesson as
grant.siteId: **a review (or a ruling) names the hole; the fix must be fitted to
the code by whoever can see it.**

The test itself closes its own dodges, each mutation-verified: both reader
constructions must be *found* (a rename fails loudly instead of going vacuously
green); both must take the *same* expression (replica edit fails); and the
expression must be a *direct* `config.FIELD` (hiding both behind
`pickReaderUrl(config)` fails on its own terms — indirection has to be argued for,
not slipped in). A check that can actually fail, guarding the asymmetry that keeps
the engine the strictly-fresher reader.

**The near-miss: two agents, one clone.** Both agents committed in the same working
copy with `git add -A` habits. Result, in the mild direction: Cowork's bare commit
swept CCC's staged test into an unrelated commit (87e14d8); CCC's push published two
of Cowork's spec commits as ride-alongs. Nothing was lost and nothing half-finished
shipped — but the same mechanism publishes unfinished work in either direction, and
nothing about a lock error announces the risk. Protocol adopted by both, effective
now: **commit by pathspec, never `git add -A` / bare `git commit` in this tree; on a
lock error, stop and report — never retry blind, never sweep locks blind** (a
retry is what turned a failed commit into a merged one; a blind sweep can clear a
lock the other agent legitimately holds). Path ownership stands: Cowork writes
`specs/`, CCC writes code.

Root cause of the lock litter itself, for the record: Cowork's workspace mounts the
repo behind a deletion guard, so git could create its locks but never unlink them —
every commit left a stale `index.lock` behind. Fixed by granting the session delete
permission; the litter (and the `_stale_locks/` holding pens) is cleaned out of all
three repos.

Remaining queue, unchanged, none blocking: migration-replaces-newest-definition
check; service_owner null-vs-explicit costed migration; 23505 invite wording split;
five hub suites that skip silently.

---

## 2026-08-28 — The admin-invite bypass: found live, closed by 0044/0045

**What the first-pass review's off-by-one question uncovered was not an off-by-one.**
The team-seats invite trigger counted memberships and pending invites *excluding
role = 'admin'*. Two consequences, one intended (the owner, an admin, went
uncounted — so "6 seats" admitted seven heads) and one not: `role` is a column on a
row a group admin may insert, the invites policy constrained no values, and
PostgREST is the same origin with the same session — so from an empty roster a Team
subscriber could send **unlimited admin invitations**, each check seeing zero, then
have them all accept. Unlimited membership is unlimited grant eligibility: this was
a roster hole, which makes it an admission finding, not a billing one.

**It was live in production until this push.** Exploitation needed a Team
subscription and a hand-built PostgREST call, so it is unlikely anyone hit it — but
it was not theoretical. Found only because the review asked what the trigger counts.

The law it mints: **the dashboard is not the boundary.** The dashboard only ever
sends `role = viewer`; the database accepted anything. A policy that constrains no
values delegates the constraint to whichever client is polite enough to impose one.
Every enforcement question in review now gets the follow-up: *enforced against
which caller?*

The fix is one rule closing both holes: **every head counts, the owner's included.**
Cap is six rows, card is "you + 5", same sentence; `team_seats.test.sql` pins the
counting basis, both halves mutation-tested. 0045 makes owner-cannot-leave a
server-side refusal at both doors, not a hidden button.

**The watermark shipped in the safer order.** CCC could not verify no-team-above-six
(admin.env holds the ledger URL, not the dashboard DB) and built
`dashboard_team_seat_floors` instead of asking to be unblocked: the backfill records
any team a narrowing cap would catch, and the effective cap is the larger of the
two. If nothing exceeds six, the backfill writes no rows — **inert by arithmetic
rather than by hope**. A narrowing whose safety rests on an unverified fact is one
taken on trust; this one rests on a floor the database computes. Approved as the
better shape — the prescribed pre-check is now merely a curiosity query.

Also worth its pattern-entry: the retired apex-domain gate's test was **inverted
rather than deleted** — it now asserts the gate stays gone, because a retired limit
nothing watches is one somebody re-adds by accident, and a limit's failure mode is
silence. And `dashboard_domain_limit_refusal` stays in the schema, unreachable,
as the record of what people were shown — ratified wording is history, like
release notes.

**Open action (Todd): push migrations 0044–0046.** 0044 narrows what an existing
team can do — a co-admin now costs a seat where it was free. The watermark catches a
team over the cap, not one relying on uncounted admins: any live team running two
admins loses one seat of headroom at db:push. Pre-open-door the teams are known and
small, and the same push closes the live bypass — apply promptly.

### 2026-08-28 — Migrations 0042–0046 applied to production; first pass fully live

Todd ran db:push (all five, in order). Post-push check, recorded per the ruling:
**`dashboard_team_seat_floors` is empty — 0044 narrowed no existing team.** Gate 4
closes as "narrows nobody in fact," and the watermark stands anyway: the law is now
a property of the schema rather than a paragraph in a spec, inherited by the next
cap that moves without anyone needing to remember it, with team_seats.test.sql
watching the null-guard and floor logic. The empty table is the point of the table.

The admin-invite bypass is therefore closed in production as of this push.

Standing radar item (not a queue item): a team sitting at exactly six that relied
on an uncounted co-admin is at seven counted now and discovers it at its next
invitation, not today. The remedy is deliberate: one row in
dashboard_team_seat_floors, granted on request — never a widening of the count.

Open queue additions from this pass: the +$3 seat is priced but not purchasable
(build the purchase before any team needs a seventh head); the comparison-matrix
layout call (in-card vs strip) waits for the pricing-page walk.

---

## 2026-08-31 — PROVEN FROM OUTSIDE: the first partner connect in the product's history

test.byollm.cloud, customer #1, completed the whole chain with no platform
session anywhere in it: published npm packages only, a key it generated itself,
consent read on our domain, a mapping the user authored, work run on the user's
own device. "I am Claude Opus 5." on the chat slot; "I am Qwen." on generate.

**The detail that makes it conclusive: the two answers are DIFFERENT.** One
model answering twice could impersonate two slots; two distinct models means two
mappings resolved independently — chat and generate as genuinely separate slots,
each landing where it was sent. And the site rendered both without ever learning
what produced either. It asked; the model answered; the fence held.

The honest tally, all found by the outsider, none findable from inside
(first-party tests share the privilege being tested):
1. /api/connect/verify behind the session guard — no partner could ever have
   connected, through every audit we ran.
2. .env.example teaching defaults the code didn't honour.
3. The 401/valid:false merge — "your key is wrong" dressed as "bad assertion".
4. CCC's own prompt-for-messages payload — generate's shape under chat's kind,
   type-legal, runtime-refused. The refusal named both halves in the device's
   own words: passing the device's words through instead of paraphrasing paid
   for itself the first time it was tested.

Test-page design ruled in the fix: TWO buttons (Ask chat / Ask generate) — a
mapping slot is a purpose AND a kind, and a diagnostic must show what is true,
never let it be inferred; the answer names which kind produced it. Pinned by
parsing what the app builds against the schemas the relay validates with, BOTH
directions (the negative half makes the positive mean something), plus the
mutation that matters ethically: a system message sneaked into the chat turn
fails — this site must not put words in the model's mouth and then report what
it said back.

**SDK list for the next release (RULING: cut .63 BEFORE the framework/Kevin
integration, not before Monday's user onboarding — users don't touch the SDK;
integrators do):**
- enqueue uses the protocol's own PayloadFor<K> — five lines that turn a class
  of runtime refusal into a compile error for every integrator. First.
- siteKeysFromEnv: render-safe failure mode.
- app.cloud optionality on the type.
- The 10MB ingress cap rides along (built at 24c118d, held per the defer
  ruling — .63 is its natural release).

Sequence from here: CCC builds embed v1 against the working baseline (consent
wording comes for approval before ship); Todd runs the fresh-account cold walk
in parallel; .63 before Kevin.

## 2026-08-31 — The empty-grid bug (most serious of the five); embed v1 verified live

**Connected Sites rendered empty for every user** — 0048's exemption column was
selected by the grid but never added to dashboard_public_sites, the VIEW the
grid reads. PostgREST refuses the whole select; the page discarded the error
with `?? []` and rendered the fresh-install zero-state. Every connection every
user had: invisible and unrevocable, on the one screen the consent model
promises for taking a permission back. Fifth refusal dressed as an ordinary
negative this weekend — and the first whose disguise was a sentence we wrote on
purpose. Caught same day; 0051 applied by Todd; grid restored with the test
site pinned and badged.

Three laws out of it:
1. **A failed read is never an empty list.** null means "we don't know" and
   says so; the recovery copy is a model of consent-honest failure: "Nothing
   has changed — any site you enabled is still enabled, and any site you did
   not is still not."
2. **A check that skips is a check that can't fail, wearing circumstances.**
   The executable app-vs-database suite skips when no local database runs —
   which is exactly how this shipped. The new guard is deliberately static
   (two literals compared, nothing running). Corollary adopted: the queued
   "five hub suites that skip silently" item MOVES UP — it is this same
   disease, already on the books.
3. **Testing needs both privileges.** Four of the five bugs only an outsider
   could find; this one only an insider could — a fresh account's empty grid
   would have been TRUE by accident, so the cold walk would have blessed it.
   The mirror of first-party-tests-share-the-privilege, and the pair now
   travels together.

**Embed v1 verified in production** (3d0c05a): exactly ONE CSP header on
/embed/button (the intersection near-miss holds where it counts),
class="unknown" + "Connect BYOLLM" from a sessionless curl (the third state
confirmed by machine), consent screen refusing all framing including ours,
unknown site 400-refused. Everything built today is live and proven: the
partner path, the reference app, both job kinds through two services, the
embed, and the restored grid.

Remaining before invites: Todd's cold-account walk — now the exact path
invitees get. Known gap, expected, not a bug: the logged-out embed branch is
the plain-redirect fallback; the landing page (copy approved) is still to
build.

### CROSS-ACCOUNT PROVEN – Lis ran on Todd's qwen. The bug was a declaration the site could not make (2026-08-31)

Lis's generate job reached Todd's device and came back. Team sharing is
proven in production between two real accounts – the second milestone
after "proven from outside". The blocker (c0988cb): `EnqueueInput.audience`
defaults to `private`; apps/test never set it; every job said "only my own
machines"; Lis has none; nothing could claim it; "nothing was listening" –
true and useless. Eight hypotheses eliminated with evidence first. Two of
CCC's own errors recorded: a confidently wrong diagnostic (runnerAvailability
is direct-mode, counts the site's own store, answers `candidates: 0` for
every cloud app – Lis was told to install byollm she doesn't need; reverted
8088c05) and a vacuous check (md5 of an empty SSO-gated response, caught
because it was d41d8cd9…, the md5 of "").

Todd: "remove the second team mapping instead of always making it team."
He is right, and this spec already said why, twice: "offer scoping IS the
per-audience routing" (per-user model selection, above) and "the cloud
route's equivalent [of audienceAllow] is the hub's own consent/mapping
machinery". A cloud-lane job's audience is not a fact the site holds. The
person's mapping names the service and its owner; the owner's offer scope
says who that service serves; the hub has both at claim. The site's
declaration was a third vote from the one party the disclosure fence
forbids from knowing the answer – which is exactly why its default could
disable the headline feature without anyone noticing. **A declaration
required from the party that cannot know is a default in disguise.**

RULED for .64 (SDK, alongside PayloadFor<K> and the stdout line):

1. **Cloud lane: audience is derived, never declared.** The hub computes
   claimability from (mapping.service_owner, that owner's offer scope,
   roster). `audience` on enqueue is REFUSED on the cloud lane with the
   remedy in the message ("the cloud lane derives who may serve a job
   from the person's own mapping – remove `audience`"). Refused, not
   ignored: this SDK's own law, an ignored option is a job that runs
   differently than asked with nothing to see. apps/test drops the
   `audience: "team"` it just gained.
2. **Direct lane: CCC says whether `audience` is dead weight there too.**
   Direct mode is owner-only by ruling; `audienceAllow` (supplier trust,
   runner groups) STAYS per the earlier ruling. If `audience` on direct
   only ever resolves to self, it goes in the same release; if it still
   selects something real, it stays direct-only and the docs say so.
3. **The "untrusted result" marking follows the fact, not the
   declaration – and check what consumes it.** Today widening the
   audience marks the result untrusted and obliges the app to disclose.
   The fence says the site may not learn whether a teammate's device
   served – so the marking cannot become per-job truth either. On the
   cloud lane it becomes a constant: every result was produced on a
   device of the person's choosing, which may be a teammate's; the app's
   disclosure sentence is the same for every job. CCC audits what reads
   the flag before removing the per-job value.
4. **runnerAvailability refuses on the cloud lane** – it answers a
   question it cannot answer there. The instrument must not report zero
   for "I cannot see" (the ambiguity law, one more instance).
5. **Integrate guide:** the sentence about audience goes away with the
   field; what replaces it is one line: "who may serve a job is the
   person's decision, made on their dashboard – your site asks for kinds
   and purposes."

Two laws from CCC's own errors: **an instrument that cannot see must
refuse, not report zero**; **verify the evidence exists before comparing
it** – a hash of nothing compares equal to a hash of nothing.

### .64 part 1 landed locally (CCC report, 2026-08-31 late) – three notes back

PayloadFor<K> (gate is tsc, shown by restoring the old pairing: vitest 5
green, tsc 5 errors); audience refused on enqueue AND the stub's default
fixed – the SDK now derives `team` on the cloud lane, mutation-verified;
direct lane keeps `audience` as the switch that arms audienceAllow (CCC's
determination, accepted, documented direct-only); runnerAvailability
refuses on cloud; untrusted flag audited – nothing branches on it, now a
constant on the cloud lane. CCC's own error: `pnpm verify | tail -5 &&
git commit` committed on a red gate (pipe returns tail's status) – third
costume for one law; fixed 742898c.

Notes back:
1. **tsc must be inside the gate, not beside it.** If `pnpm verify` and CI
   do not run tsc, the PayloadFor check is a check that can't fail wearing
   a compiler. Confirm both run it.
2. **A constant on the wire is not a decision.** The stub's `team` is
   compatibility, not authority: the hub must decide from (mapping owner,
   offer scope, roster) and treat the stub's audience as at most a
   ceiling – never widen because the SDK said team. Confirm the hub's
   claim path does not read it as permission; drop the field from the
   cloud stub in the next protocol rev.
3. **Put pipefail in the script, not the habit.** "Capturing the exit
   status explicitly" is discipline; the gate should make the mistake
   impossible – `set -o pipefail` inside verify, and the pre-commit (not
   only pre-push) hook running it, so a red commit cannot be created,
   not merely cannot be pushed.

Reply (Cowork): 1 and 2 confirmed with evidence. **3 – CCC is right and I
withdraw the pre-commit hook.** A pre-commit hook cannot verify the tree it
is about to create (the stamp defect the repo already documents), a
four-minute hook gets bypassed and then reads as protection, and the cheap
version would not have caught a failing relay suite anyway. The control
that matters – verify on the exact tree, stamped, refused at push – held;
what failed was the report, and pipefail is the fix for that. Ruling:
commit → verify → push stands; pipefail stays in the script; a red commit
that cannot be pushed is not a red main. A required status check on main
is the honest upgrade if we ever move to PRs; not now, with two agents
and Todd pushing to one branch.

### 2026-09-01 – The owner/site split landed (604e27b) and found a second fence breach

CCC: no backend message reaches a site now – one fixed sentence per
class; timeout and output-too-large keep their own classes (facts about
the job, naming nothing); signed-out and crashed are deliberately ONE
class to the site, and the owner gets the CLI's words on Your Devices,
`byollm status` and ingress.log. The larger finding: every failure
message named its backend ("the claude CLI is not signed in") – the
disclosure fence, breached through the error path, while every success
path was careful to hide the same fact. Four boundary tests now, three of
which fail the moment a message travels (one greps for the owner's home
directory, one for the word "claude"). knip surfaced SERVICE_UNAVAILABLE
exported and never asserted – now the constant IS the assertion.

Law, for the record: **the error path is a disclosure path.** Every
fence has to be checked where things go wrong, because that is where
nobody was looking. Accepted as ruled; the same-class decision for
signed-out/crashed is right – telling them apart tells the site about
the person's setup, and the person is the one who already knows.
Sequence unchanged: auth probe → Windows two → ABOUT in @byollm/protocol
→ apps/test stopgap out → guide line → release .64 → Todd walks fresh
account #3 → Kevin.

### 2026-09-01 – THIRD INTEGRATOR PROVEN (Kevin's Press, fact-checker → Todd's qwen). The unsatisfiable-slot promise, RULED for .64

Kevin's generate job routed end to end through Of Tomorrow Press – the
first integrator who is not us, on a manifest he wrote. Two hours were
lost first, to a purpose (`fact-checker`) his manifest did not declare:
the engine declines unmapped as transient, the job sat queued to its TTL,
and the site was told nothing – "accepted, queued, never offered". We had
promised the opposite in writing (migration note: "an unmapped slot
arrives on that same branch – you learn that a slot is unsatisfiable";
README: "it learns whether a slot was satisfiable, and nothing else").
Second documented promise with no implementation in two days, both found
by someone using the product. Kevin asked the right two questions and
identified that the answer should have come from us.

**RULED for .64 – three outcomes, decided where each is knowable:**
1. **Purpose not in the site's manifest → refused at enqueue**, with the
   remedy: "this site does not declare the purpose `fact-checker` –
   declare it on Developer Sites". The site's own manifest; nothing
   disclosed.
2. **Purpose declared, but this owner has no mapping for (purpose, kind)
   → declined at enqueue on the unavailable branch**, reason
   `unsatisfiable`, the job NOT queued. This is the promise as written:
   "the same branch as unavailable". It is knowable at enqueue (the hub
   holds the mapping), and a job the site has already fallen back on
   must not be served later – a person who maps the slot thirty seconds
   after is served by the NEXT job, which is the same thirty seconds.
   CCC's first instinct ("answerable immediately at enqueue") is the
   ruling; "stays queued and the site can ask" is a poll wearing a
   promise.
3. **Declared, mapped, and no device can currently claim → transient**,
   exactly as today (nothing was listening; TTL). This is the only case
   the transient rule was ever for.
Opacity unchanged: the site learns satisfiable-or-not and never why or
which service.

**Adding a purpose is a re-consent event (RULED, dashboard side in
website-sync).** Kevin's manifest went from one purpose to three; every
connected user now has two unmapped slots and nobody told them. See the
website-sync entry for the developer-side warning and the user-side
notice. No auto-mapping – mapping is consent.

Also from the thread: `chat/completions` is the transport for every HTTP
job by design (the one endpoint every server implements; instruct models
want the chat template; a closed union of two literals is a smaller
surface). The kind survives in the payload shape and the mapping slot.
One nit: the log line names the transport – it should name the kind
beside it, so the log stops looking like a bug to the person reading it.
Images and other kinds remain a protocol change with their own spec and
threat review – correctly gated.

### 2026-09-01 – Todd: "map a default generate and chat you can always use; namespace the special ones." RULED, and it reopens the reserved id

The pro-tip is right and it is the growth path every site will walk:
start with the flat slot, add named purposes only when a task should be
mappable to a DIFFERENT model than the everyday one. Two ways to give it
to developers; the second makes the first back-compatible:

1. **Docs, now:** a pro-tip box in the integrate guide and every example
   manifest: declare one everyday purpose covering both kinds and route
   ordinary work there; add `fact-checker`-style purposes only for work
   that deserves its own slot. Adding a purpose is a re-consent event,
   so add them deliberately.
2. **Let `default` be declared (amends the reserved-id ruling of
   2026-08-27).** Today `default` exists only as the IMPLICIT purpose of
   a site with no manifest; the moment a manifest is declared it
   vanishes, every purpose-less `enqueue()` becomes undeclared, and every
   existing user's mapping to it becomes an orphan. So the first
   namespaced purpose a site adds breaks every connected user – the
   opposite of a growth path. Ruled: a manifest MAY declare `default`;
   its label is always the site's own name (not overridable – the reason
   the id was reserved holds: "default → your Claude" teaches nothing,
   "Of Tomorrow Press → your Claude" does); description optional
   ("Everything else this site does" when absent); `enqueue()` with no
   purpose targets `default`. A site that grows from no manifest to
   `{default, fact-checker}` keeps every existing mapping intact and
   adds exactly one new slot to map. Refusal survives for a manifest
   that declares purposes and omits `default` while the site still
   enqueues purpose-less jobs – that is outcome 1 above ("this site
   does not declare…"), now with a better remedy: "declare `default`".

Release: (2) is a protocol schema relaxation plus the dashboard's label
rule – CCC sizes it; in .64 if it is the one-liner it looks like (the
protocol package ships in .64 regardless), .65 otherwise. The docs
pro-tip lands with whichever release carries (2), so the examples never
teach a convention that changes a week later. Kevin's manifest becomes
`{default, fact-checker, style-trainer}` with `writing-assistant`
folded into default if he wants – his call, and his users re-map once.

**Superseded within the hour (Todd): `default` stays reserved; the answer
is a best practice, not a schema change.** Declare the site-wide needs
under a purpose named for the SITE, both kinds, and give special features
their own label only when they may need a different model. Kevin's
manifest, as Todd would write it:

    {
      "of-tomorrow-press": {
        "kinds": ["llm.generate", "llm.chat"],
        "label": "Of Tomorrow Press",
        "description": "Device services used for most of the Of Tomorrow Press website"
      },
      "writing-assistant": {
        "kinds": ["llm.generate"],
        "label": "Writing Assistant",
        "description": "Device service used to draft scenes from story outlines"
      }
    }

Ruled as the documented best practice: the integrate guide's first
example manifest has this shape; the pro-tip box says why (one everyday
slot, named slots only for work that deserves its own model, each added
purpose is a re-consent event); the Developer Sites manifest editor's
placeholder is this shape with the site's own name and slug filled in.
Sites always enqueue with a purpose once a manifest exists; a
purpose-less enqueue against a declared manifest is outcome 1 with the
remedy "name a purpose – your site-wide one is `of-tomorrow-press`".
Known and accepted: a site that declares its first manifest after it
already has users re-consents once (the implicit flat slot's mappings
orphan), so the guide says "declare your manifest before you invite
users". No protocol change; nothing rides a release but the docs and the
editor placeholder.

### 2026-09-01 – Satisfiability at enqueue: relay-asks-never-holds CONFIRMED, with four conditions; build order set

CCC's shape: the site-plane enqueue handler gains an optional dependency
`satisfiable?(siteId, owner, purpose, kind)`, wired in the hub to the
control plane (which already answers this at claim via
`PolicyStore.read()`); the relay's ConsentRecord stays `{owner, siteId,
paused}` – no mappings, as ruled; the manifest joins the policy read for
case 1. Both cases refuse at enqueue as thrown, typed errors, consistent
with enqueue's existing throws. Confirmed. Conditions:

1. **Optional must be visible, not silent.** A relay without the
   dependency behaves as today – acceptable only if it says so: the
   relay logs its satisfiability mode at boot and reports it on its
   health surface (`satisfiability: control-plane | none`), and the SDK
   docs state where the signal exists. A check that quietly isn't there
   is the skipping-check law wearing deployment.
2. **The constant is the assertion.** Two stable error codes
   (`purpose-not-declared`, `slot-unsatisfiable`), pinned by tests; the
   unsatisfiable MESSAGE is a fixed-sentence constant, never composed,
   and a test greps it for purpose ids, service names and the word
   "mapping" the way the owner/site split's tests grep for "claude".
   The not-declared message may name the purpose and the remedy – it is
   the site's own manifest.
3. **Widening, named and accepted.** The relay now learns, per enqueue,
   whether THIS owner has a mapping for THIS purpose – existence, never
   which service. That is one bit more than ConsentRecord held; write it
   into the relay's enumerated-metadata commitment (byollm_009 §6) so
   the list stays exhaustive.
4. **Enqueue-time answer, claim-time truth.** A mapping revoked between
   enqueue and claim falls to the transient path exactly as today; no
   second check is added at claim. One question, one answerer, per
   moment.

**Build order (Kevin is unblocked):** auth probe → Windows two → ABOUT in
@byollm/protocol + drift check → apps/test stopgap out → guide's audience
line → THEN satisfiability, last. If it is not green when the rest is,
**.64 ships without it and it heads .65** – a release is not held by its
largest piece, and the promise is a day older either way. `latest` moves
to whatever ships.

### 2026-09-01 – Auth probe, first half (7bcb3d3): the canary was already the probe. Wording for the owner surfaces, RULED

CCC found the existing daemon-start canary is the right instrument (one
real token through the real binary) and wired setup to it. Three facts,
three words: `installed` (the binary), `answers` (the credentials),
`undefined` (not asked – backends with no canary). The third is right:
rendering not-asked as `false` would tell every local-server owner their
model cannot answer – "not asked is not no", sibling of "empty is not
configured". Writing the service to config when it cannot answer is
approved: a lapsed token is a five-second fix, nothing routes until it
answers, and the wizard says so.

**The owner-facing sentence, one template, three surfaces** (Your
Devices card, `byollm status`, daemon output) – ruled, and the same
words CCC was waiting on for the signed-out card:
- answers → as today (healthy, model name).
- installed, does not answer → **"claude – needs sign-in on tood-mbp:
  run `claude` in a terminal"**, with the CLI's own first line beneath
  it, muted. The remedy verb comes from the backend, which knows its own
  sign-in ("codex – needs sign-in on tood-mbp: run `codex login`");
  the template is one string.
- not installed (config names a binary that is gone) → "claude – not
  found on tood-mbp: install it, or remove the service with `byollm
  …`" – the remedy names the command.
- undefined → no auth sentence; health as today.
Never on a site: the class only, as already built.

### 2026-09-01 – Probe wording landed; Your Devices deferred (wire, not rendering)

CCC: the canary always worked on Todd's machine – it failed on the
expired token and dropped the route correctly; "0 backends are healthy"
threw the answer away. **The check worked; the message discarded its
result** – the same law as stderr-empty, one layer up. Now four states,
one template, remedy travelling beside the state (learned in the same
moment from the same backend instance), device name in every sentence.

RULED: **Your Devices defers to the end of .64 with satisfiability**, and
ships in .65 if not green – it is a wire change (the presence payload
carries the auth state), and the local surfaces (`byollm status`, daemon
output, connect) already give the owner the sentence in the terminal they
are standing at. Conditions when it lands: the presence payload carries
the STATE and the REMEDY TEMPLATE KEY, never the CLI's text – the CLI
line stays on the machine (paths, emails); the hub stores nothing but
the latest state per service; the card renders the same template. Until
then Your Devices shows health as today.

### 2026-09-01 – `byollm status` reads, never probes; latest state only; absent is not signed-out

CCC: status is a separate process and the canary is a real model call –
on a metered backend, real money on a command run repeatedly while
something is wrong – so status READS what the daemon last recorded.
Latest state only, never a history: a probe log would be a record of the
day a subscription lapsed and every day after, which is nobody's
business including ours (the hub piece follows the same rule). Absent
is not signed-out, asserted three ways: no file, unreadable file, and a
state written by a future version – all three read as "nothing has
probed", so a .65 daemon's fourth kind cannot make a .64 status invent
a finding. The coverage gate refused rendering in cli.ts (77.9%
branches); the rendering moved beside the template it renders, one
function per surface. Two laws kept: **an instrument must not spend the
thing it measures** (status must not burn quota to report quota
health); **"hard to test" usually means "wrong file"**. All accepted.

### 2026-09-01 – Windows two landed; both were dead ends, not rough edges

Task fallback: a machine that refuses schtasks starts byollm from the
Startup folder – no elevation, cannot be refused; weaker (starts at
logon, no restart), and that weakness is printed beside the success –
**a supervisor that does not supervise must not be reported as one.**
The refusal is named: "Access is denied" → no administrator rights, or
IT policy; any other failure keeps Windows' own words (guessing "no
admin" at a disk error sends someone to the wrong fix). Empty config:
a 0-service pre-alpha.44 config hit "Setup will not change it" and
returned – nobody who installed before .44 could run setup at all, Kevin
included. The owner's-config rule keeps its teeth and gains a door: one
yes, one line; a config with real services is never asked about.
Mutation-verified both ways. Accepted. One note for the docs: the
Windows install page says which supervisor it got and what each means,
in the same two sentences the CLI prints – the interim `byollm run`
answer stays in the guide.

### 2026-09-01 – Four verbs, no ceremony: `setup` finishes the job (Todd; ruled, rides with the install script)

Todd: "it is weird that we have connect, run and install – and setup
does none of them at the end. Maybe the shell script will fix that."
The script must NOT be what fixes it: **the script does only what the
CLI cannot (get Node, get byollm); everything after that is the CLI's
own ceremony**, so someone who `npm i -g byollm` by hand – Kevin – gets
the same path as someone who pasted the one-liner. Ruled:

- `byollm setup` becomes the whole first run, in order, each step a
  question with a default and each skippable: services (as today) →
  **connect** this device (asks for the pairing code, or takes
  `--code <code>` from the command the setup page shows, and `--name`
  defaulting to the hostname) → **install** supervision (with the
  Windows fallback wording as built; declining says `byollm run` is the
  foreground alternative). It ends with what is true, not what to do
  next: "tood-mbp is connected · claude answers · supervised by launchd"
  – or, for any step skipped, the one command that finishes it.
- The four verbs stay as the re-runnable pieces (`connect` for a second
  account or a re-pair, `install` after a decline, `run` for foreground,
  `setup` again to change services). Nothing is removed; setup composes
  them. Re-running setup on a configured, connected, supervised machine
  asks nothing and prints the same true sentence.
- The install script therefore ends with exactly one command:
  `byollm setup --code <code>` (code present only when the setup page
  baked one in). The page's pasted line is the script; the script's
  last line is setup; setup's last line is the truth.
Rides with the install script (onboarding batch, after .64) – not a
.64 item; Kevin is unblocked and the verbs work today.

### 2026-09-01 – ABOUT in @byollm/protocol with the drift check: the one-source rule has teeth

Two forms (generated TS module for bundlers; the markdown in the
tarball so npm renders it – a description that needs a bundler to read
is one most people won't). ABOUT_SHORT exported as lede / tail / whole
from the cut mark; a file with no cut mark is refused. The check runs in
verify and refuses all three ways of making two states (markdown edited
without regenerating; generated file hand-edited; package copies
edited), each mutation-verified. Generated files sit outside prettier –
**a generated file with two formatters is a file with two sources.**
Accepted. One addition: the dashboard and docs copies swap to the
import in the SAME push that bumps the dependency to .64 – the debt is
closed by the release, not left for the day after.

### 2026-09-01 – .64 RELEASE APPROVED (Cowork; Todd holds the 2FA)

Feature-complete, ten local commits, green: PayloadFor<K> · audience
derived + refused · runnerAvailability refusing · owner/site split ·
pipefail · auth probe (setup, connect, status, daemon) · Windows two ·
ABOUT in @byollm/protocol with the drift check · satisfiability's
package half (EnqueueRefused distinct from RelayUnavailable – "retrying
forever against a fact" is the right sentence; the undefined-store case
has its own test). The hub half is SCHEDULED, not missing: wiring it
before .64 exists on npm would put a lie on a health surface, so it
rides the post-publish push – hub wiring + boot line + health field +
enumerated-metadata commitment; apps/test stopgap removal with the
dependency bump; the guide's audience line; dashboard + docs ABOUT
imports. Four items, one push, each wrong to land early for the same
reason: it would document a version nobody is running.

Release train: CCC publishes .64 to `@alpha` (registry-verified, as
.63); Todd moves `latest` to .64 across all six (2FA, one command per
package – skipping .63 entirely); post-publish push lands; hub deploys;
Todd re-installs on his laptop and walks fresh account #4 with
`byollm uninstall` first as a real step; if clean, Kevin gets the
summary and the proven steps. One question open for CCC's report: where
did the Your Devices auth-state wire piece land – riding the
post-publish hub push, or .65 as provided for.

Correction (Todd): `latest` already points at .63 – he moved it after the
.63 publish. The train step is simply .63 → .64 after CCC's publish, all
six packages.

### 2026-09-01 – .64 tagged and pushed; .65 manifest stated

Verify green at the tag; registry confirmation pending. Your Devices
auth state lands in .65 (daemon presence payload = package release), so
the post-publish push is exactly four items. **.65 carries:** Your
Devices auth state (template key not CLI text; latest state only) ·
byollm_017 model choice · dropping `audience` from the cloud stub
(protocol rev). Note: CCC says `latest` still points at .62, Todd says
he moved it to .63 – `npm dist-tag ls byollm` settles it before the 2FA
command runs; either way the target is .64 on all six.

### 2026-09-01 – .64 LIVE on all six (registry-verified); validated on Todd's machine; three of four post-publish items shipped (317097f)

Todd uninstalled everything, logged out, forgot the test site, redid the
whole path on .64: "Much smoother." The stopgap lived exactly one
evening and left with the bump, as it had to. The ABOUT swap failed its
own test on v3's rewording – the assertion now names the CLAIM (the
encryption promise), not the phrasing, so a rewording passes and losing
the promise fails: **assert the claim, not the phrasing** – the drift
check's sibling, one level up. The guide now says the one idea ("who
may serve a job is the person's decision, made on their dashboard –
your site asks for kinds and purposes"). Registry settled the dist-tag
question: `latest` is .63; Todd's 2FA moves it to .64. Remaining: hub
wiring (in progress). Kevin owes himself an upgrade: docs now describe
.64, he runs .62, and `provenance.untrusted` is a constant on the cloud
route – his code may branch on it today.

### 2026-09-01 – .64 shipped satisfiability unreachable (no RelayOptions wiring); hotfix .65 APPROVED

The dep went onto SitePlaneDeps and never onto RelayOptions – nothing
could supply it; found only by wiring the first real consumer. CCC's
first test agreed with the bug (constructing with the option doesn't
throw – passes with the wiring removed): "a test that cannot fail,
written about a feature that cannot run", third instance this weekend.
Law worth the sharper form: **a feature exists when its first consumer
runs it** – an injection point nobody can inject is dead code wearing an
API, and the wiring of the consumer is part of the feature, not an
integration detail. The real test now goes through relay.handle and an
actual enqueue; the refusal is grepped for service/device/mapping/model
names (opacity is the promise). Hub is on .64: manifest in the policy
snapshot, control plane wired as answerer, mode at boot and /readyz.

RULED: **cut .65 now as the small release** – 2443241 plus whatever is
already green, nothing else pulled in. The prior .65 manifest (Your
Devices auth state, byollm_017, cloud-stub audience drop) becomes .66.
Todd holds the `latest` 2FA until .65 is live and the satisfiability
path is proven end to end (an undeclared purpose refused with the
remedy, an unmapped slot declined with the fixed sentence, on the test
site) – then one move, .63 → .65, all six.

### 2026-09-01 – .65 published; DB proven by the real path; hub deploy staged

reader-grants.mjs proved production by building a real PgPolicyStore on
the hosted hub_reader credential and calling read() – query, joins, RLS
and parsing together, covering the new manifest subquery without
editing (nothing in it names a column). The migration list only says a
file ran; the script says the path works – the instrument the docstring
promised, now also reachable as `pnpm reader:grants` (the docstring's
command finally exists – a docstring that names a command that does not
run is the drift disease in miniature). State: byollm .65 published
(`latest` holds at .63); 0052 applied in prod; hub wiring pushed green,
NOT deployed – live /readyz still generation 1, no satisfiability
field. Deploy sequence ruled: CCC runs `pnpm preview` and shows the
plan → Todd says go → CCC runs `pnpm up` → /readyz shows
"satisfiability":"control-plane" → the Kevin test on the test site (an
undeclared purpose refused immediately with the remedy; an unmapped
declared slot declined with the fixed sentence) → Todd moves `latest`
.63 → .65, all six, one move.

Correction to the deploy sequence (CCC caught it before running
anything): `pnpm up` applies infra with the PINNED digest – 23
unchanged, exit 0, .62-era code still serving; finding 55 one level up
("a deploy that silently ships the last program is worse than one that
fails"). The real deploy is `./scripts/roll.sh`: edge watch started
BEFORE the rollout (finding 56), build+push while still serving,
build/typecheck + pulumi, read the deployment back from the cluster
against the new digest, then a real job through the hub it deployed.
Rollback string recorded (sha256:afa1f754…); no MIGRATE, additive. GO
given – and the new digest lands in Pulumi.prod.yaml, which gets
committed with the roll as before.

Roll note: the wire prover (round-trip.mjs:519) itself passed
`audience` and was refused client-side by the .65 SDK before any bytes
left the machine – pairing and site-key pinning through the new hub had
already succeeded, so the deploy was fine and the prover was stale. A
prover ages with the contract it proves; when a release removes an
option, the greps must include the instruments. The enqueue-refused
throw naming its cause is what made this a two-minute diagnosis instead
of a rollback – the refusal law paying for itself on our own tooling.

### 2026-09-01 – SATISFIABILITY LIVE END TO END. `latest` = `alpha` = .65 on all six, drift zero

/readyz reports "satisfiability":"control-plane"; a real job through the
deployed hub ran the mapped purpose and refused the unsatisfiable slot
AT ENQUEUE, with the refusal crossing the network and passing the
disclosure grep. Todd moved `latest`; release-check shows all six
aligned. The promise from Kevin's afternoon is kept, in production,
same day.

Honest gaps and follow-ups, recorded:
- **purpose-not-declared is proven by tests, not production** – no site
  whose keys we hold can reach it (the smoke site can't carry a manifest
  without breaking its own round trip). Accepted as stated; the first
  real proof will be Kevin's next typo, which will now cost him one
  sentence instead of an afternoon.
- **Press behaviour change, heads-up owed to Kevin:** a manifest site
  enqueueing without a purpose is now refused as purpose-not-declared
  (purpose ?? "default" meets the reserved key). Those jobs were already
  dying silently at TTL; now they say so with a remedy naming his own
  manifest. Improvement, but visible: refusals today where there was
  silence yesterday.
- **roll.sh wants the exit-3 treatment:** a status meaning "the wire is
  unproven because the prover couldn't run", distinct from "the wire is
  red" – it printed rollback instructions for a client-side throw.
  Rightly not changed in the same commit that fixed what it caught;
  queued. The unmapped-job check inverted from wait-and-see-nothing-
  moved to asserting the refusal – the weak reading was exactly Kevin's.

Closeout addendum (CCC): the 0052 grant was an OUTAGE avoided, not a
feature enabled – hub_reader without dashboard_sites.manifest fails
seven store tests, five of them the existing cloud lane, because the
manifest shares a statement with the consent read. Caught before deploy
by the same reader-grants path that then proved production. .65 CLOSED:
npm aligned, DB applied and path-proven, hub deployed and sealed both
ways. Open, carried forward: purpose-not-declared production proof
(arrives with Kevin's first real refusal); roll.sh "unproven" status;
.66 = Your Devices auth state + byollm_017 + cloud-stub audience drop
(one fewer caller after today). Kevin heads-up goes out now.

### 2026-09-01 – Onboard #2 (Todd): setup-finishes-the-job PROMOTED to now; connect always exits

Second onboarding session confirms the four-verb gap in the field.
Promoted from "rides with the install script" to the immediate daemon
batch (small: two questions + composing existing verbs, per the
2026-09-01 ruling):
- `byollm setup` ends with **"Connect to byollm.cloud? [Y/n]"** and
  **"Run in background? [Y/n]"**, both defaulting YES; yes runs
  `byollm connect` then `byollm install`, with the ruled ending – the
  true sentence, or the one command that finishes a skipped step.
- **`byollm connect` always exits after the connection is made** –
  pairing is a ceremony, not a service; running is `run`'s and
  `install`'s job. If connect currently lingers, that is a bug under
  this ruling.
The device page's new copy (website-sync, this date) leans on these two
answers by name, so they ship before or with it. The curl|sh script
drops to the backlog – npm plus setup-finishes-the-job covers the path.

### 2026-09-01 – Kevin's second find: .65's own delivery loop calls the API .65 made refuse. Hotfix .66 RULED

Kevin: runnerAvailability() now throws on the cloud lane, but
PollingDelivery and supabaseRealtimeDelivery call deps.availability
every poll – so job.result() throws at the first poll for any
cloud-lane site. He guarded locally and proposed the package fix (deps
wrapper treats the throw as "unknown, keep waiting").

The law this earns: **when you make a function refuse, grep its
callers first – a refusal aimed at outsiders that your own loop
swallows is a crash wearing a principle.** We audited what branched on
the untrusted flag and never audited runnerAvailability's internal
callers. And the test that was missing is the consumer's ordinary
loop: our proofs ran enqueue paths, never job.result() through a
delivery on the cloud lane. A fixture that does exactly that ships
with the fix.

Fix shape – Kevin's intent, one notch cleaner: **delivery must not ask
the question at all on the cloud lane.** Catching the refusal and
calling it "unknown" is a swallowed error in costume, and a broad
catch would eat real failures. The deps wrapper hands delivery no
availability instrument on the cloud lane (or a typed
"question-closed" answer); delivery skips the check when the
instrument is absent. If CCC prefers the catch for wire-compat
reasons, it catches ONLY the typed cloud-lane refusal, nothing wider.

Release: **hotfix .66 now, same playbook as the RelayOptions hotfix**
– this plus whatever is green, nothing pulled in; the stated .66
manifest (Your Devices auth state, byollm_017, audience stub drop)
slides to .67. `latest` moves with it after the fixture proves the
loop. Kevin is two for two on finds our own walks could not make –
worth saying to him.

### 2026-09-01 – .66 published and proven from outside (same script: fails on .65, passes on .66)

CCC took the no-instrument shape: delivery is handed nothing on the
cloud lane and skips the check it doesn't hold; the direct lane keeps
the instrument (NO_RUNNER_SIGNAL is a MUST – a version removing it
everywhere would pass every other test). The fixture took two tries
and the first was VACUOUS: it pumped, then awaited a job already
terminal, so the loop returned on its first read and never executed
the availability call – a reproduction that never runs the line it is
about. The real fixture starts the wait while the job is still queued
(the consumer's actual shape) and, with the fix reverted, fails with
Kevin's exact error. Gap named for the record: every cloud test drove
enqueue then read the store; app.result() is a store read,
job.result() is the delivery, and no test awaited the second.

Carried forward, deliberately out of .66: the release verifier read a
stale registry, went red, and the re-run's "already at .66" refusal
was itself the proof of success – the refusal-vs-redirect family; the
verify step wants a retry window, queued. **.67 manifest:** Your
Devices auth state · byollm_017 · audience stub drop. `latest` → .66
is Todd's 2FA after his non-admin walk.

Todd validated .66 on a real install (alpha install, byollm install,
live calls), is moving `latest` → .66 and telling Kevin. CCC proceeds
to the remaining queue.

### 2026-09-02 – Housekeeping reconciliation (CCC, with evidence); PAT ruled

Closed: codex on byo-llm.com (lowercase copy beat the first grep;
drift-guarded by check-site.mjs pinning data-provider against
BACKEND_IDS); the verifier's retry window exists (8 attempts,
backoff to 30s) – the OPEN half is that exhausting it is reported as
"partial release" when the true statement is "still unreadable after
N minutes"; a timeout is not a finding about the release, it is a
finding about the window. Open, ranked: (1) CI runs strictly fewer
tests than a developer laptop – 21 skipped green vs 5 locally; the
REQUIRE_* gates exist but ci.yml sets only REQUIRE_VALKEY, no
Postgres service in verify; policy-store.test.ts is the suite that
would have caught the hub_reader manifest grant. (2) reader-grants in
no workflow – a deploy-day check run by memory. (3) roll.sh: exit-3
exists for "smoke site disabled", nothing for "the prover itself
failed". (4) enqueue-refusal classes decided by allowlist
(REFUSED_AT_ENQUEUE.has(code)) – a relay-side third code reaches an
older client as RelayUnavailable and sites' catch stops matching; the
409 class is already on the wire; **the status class is the key, the
allowlist is a description**. (5) test-site service account – Todd's,
support@ is a forward not a sign-in.

RULED on CCC's question: **mint the PAT** – fine-grained, read-only
(contents:read), scoped to byollm-cloud-web alone, with an expiry –
Todd's two minutes. The suites that need the dashboard schema are the
ones that catch grant outages; loud-but-skipped is still a check that
cannot fail, so loud skips land only as the interim while the PAT
propagates, not as the destination. CCC proceeds on 2, 3, 4 and the
ledger half of 1 meanwhile, as proposed.

### 2026-09-02 – Tonight's scope so tomorrow's walk is comprehensive; a live copy/CLI mismatch caught

`latest` = .66 (Todd, after a basic test); full non-admin walk
tomorrow. Todd wants the open dashboard/daemon items landed tonight so
the walk covers the finished product.

**Caught while scoping: the device page already tells walkers to "say
YES to Connect to byollm.cloud and Run in background" – questions
`byollm setup` does not ask until the setup-finishes-the-job work
ships.** Live copy describing a version nobody is running – our own
law, on our own page, shipped this evening in item 5. Two ways out,
CCC picks by feasibility tonight: (a) ship a **.67-lite** carrying
ONLY setup-finishes-the-job (two Y/n questions, connect always exits)
so the copy is true by morning – the full .67 manifest (Your Devices
auth state, 017, stub drop) is unchanged and ships later; or (b) if
(a) can't be green tonight, soften the device-page NOTE to match the
shipped CLI and restore it when .67 lands. The walk must meet a page
that tells the truth.

Tonight's list, in order: housekeeping already in flight (verifier
wording, roll.sh unproven, error-class keying, ledger CI half; PAT
when Todd mints it) → Developer Sites trio (manifest editor always
open; values not counts; re-consent badge + save-time warning) →
post-consent one-page setup flow (mapping only when mappable) →
verify /welcome renders the ABOUT lede only → (a) or (b) above.
Freeze-at-close and per-member bandwidth stay queued – walk-invisible.

### 2026-09-02 – Setup gates on auth (Todd, ruled into tonight); FULL .67 approved for overnight

Todd: after a yes to any subscription CLI, setup probes it (the .64
canary – already there); if it cannot answer, setup must STOP the
person, not annotate them – his laptop and Rob's machine both sat in
"we thought it wasn't working" because logged-out only looked like a
note. Ruled, one notch gentler than exit-and-rerun since setup is
already idempotent:
- On a failed probe, setup prints the remedy in Todd's shape –
  "Claude is not logged in. Run `claude` in another terminal and log
  in, then press Enter here to re-check (Ctrl-C to finish later and
  re-run `byollm setup`)." – and WAITS. Enter re-probes; success
  continues the ceremony. Declining exits nonzero with the same
  remedy as the last line. Same for codex and ollama:cloud on a yes.
- The stretch goal (auto-continue on login) is the Enter-loop's
  cheaper cousin and is covered by it; a filesystem/keychain watcher
  is NOT built.
- The ruled .64 behaviour stands underneath: config is still written,
  nothing routes until it answers – the gate changes what the PERSON
  meets, not what the config records.
**Full .67 approved for tonight** (Todd: nobody upgrades before
morning; Kevin moves to `latest` going forward): Your Devices auth
state (its two conditions), 017 Phase 1, audience stub drop,
setup-finishes-the-job, this gate. Hotfix discipline still applies
inside the night: whatever is not green by morning is cut, not
waited for – the walk meets what shipped, and the device-page NOTE
matches it either way.

### 2026-09-02 – Single-terminal login, the simpler mechanism (rides tonight's gate)

Todd's aim: the auth gate must work in ONE terminal – the hosted
console has no second window. His sketch (background setup, run
claude, fg on exit) needs shell job control a child process doesn't
own. The same intent, simpler: **setup spawns the vendor CLI itself,**
inheriting the TTY – "Claude isn't logged in. Opening Claude now:
log in, then type /exit to come back here." → `claude` runs
interactively in place → on its exit setup re-probes and continues.
No bg/fg, no second terminal, works over SSH and the hosted console
alike. CCC verifies the right invocation against the shipped CLI (a
direct login subcommand if one exists, else interactive + the /exit
instruction) – verified, not assumed, per the FIXED_ARGV precedent.
The Enter-to-recheck loop stays as the fallback when spawning
interactive is unreliable (Windows conhost, say). Same for codex and
ollama:cloud.

### 2026-09-02 – .67 published and green (CCB, overnight). Cuts made rightly; CI green first time since 08-29

Shipped: setup finishes the job (two Y/n defaults-yes; install never
offered before pairing succeeds – a background service for an unpaired
device is a process with nothing to do and no way to say so); the auth
gate with INVOCATIONS VERIFIED BY RUNNING THEM – `claude auth login`
(claude login is not a command; guessing would have shipped a gate
that always fails on the first-run path) and `codex login`, both
direct subcommands, beating the spec's interactive-plus-/exit fallback
outright; `byollm connect` exits; 017 Phase 1 proven against the
registry (refusal shown, config byte-identical – the spec's headline
test). /welcome verified: renders the lede only, already correct.

Cut to .68, both rightly: the audience stub drop (stub.audience is the
enforcement check keeping a private job off another owner's daemon on
the direct lane – inert on cloud is the argument for removal AND the
reason removal is a protocol change, not a 2am edit) and Your Devices
auth state (spans daemon presence, hub store, dashboard – a partial
landing would leave the page asserting what it can't support). The
device page now names all THREE prompts including the auth gate's,
pinned by test – an unnamed prompt met only when something is wrong
reads as an error mid-walk. Dashboard batch (Developer Sites trio,
post-consent flow) not started – rides today, after the walk.

CCB's own mutation catches recorded: gate tests that passed with the
gate removed (wrote:false true for a second reason), and two tests
reaching the real runLogin – which spawns a browser sign-in and waits,
which is why the suite had stopped exiting. byollm-cloud CI green for
the first time since 2026-08-29; the PAT is the one blocked lane.

Morning list (Todd): mint the PAT → `latest` .66 → .67, all six →
the non-admin walk against what shipped (the walk notes which specced
items are not yet walkable rather than counting them as failures) →
tell Kevin: upgrade via latest, and setup now asks three things.

### 2026-09-02 – Promises made to Eric, audited against the build (one gap, one verify)

Todd told Eric: (1) quota-blocked accounts (five-hour block, weekly
cap, model block) are detected and "easy to route" around – fall back
to the site's own API; (2) multiple personal Claude accounts
round-robin "using the ones that work" (Todd flagged it himself as
needing work); (3) hosted onboarding in a few days, under two minutes;
(4) everything metered where the developer can see it, sizes never
contents.

Audit:
- (1) is a GAP in the fast path. A signed-out CLI is now detected
  (auth probe) and an unmapped slot refuses at enqueue – but a mapped
  service whose account is QUOTA-BLOCKED mid-day surfaces as
  unhealthy → unclaimable → the TRANSIENT path: the site waits the
  job's TTL before learning nobody answered. That is Kevin's-afternoon
  slow, on the case Eric cares most about. **Spec item for CCB
  (byollm_019 candidate): quota-exhaustion is a detectable CLI error
  class – classify it in the probe/failure taxonomy (distinct from
  auth), mark the service unhealthy-with-reason, and give the site a
  FAST answer when every mapped service for a slot is currently
  unhealthy – enqueue-time (satisfiability already reads the control
  plane; health could join it) or a short first-poll deadline. Design
  question to settle there: opacity – "nobody can answer right now"
  is fine; "his Claude is rate-limited" is not.**
- (2) is true between jobs across devices (claim semantics), needs
  Hosted Devices for multiple ACCOUNTS (one CLI login per machine),
  and mid-block failover inherits the (1) gap. Todd's own hedge to
  Eric was right.
- (3) is byollm_018, on schedule.
- (4) VERIFY before Eric onboards: what does a site developer actually
  see of usage today – per-site aggregates exist in the meter; is
  there a developer-facing usage surface? If not, it precedes Eric's
  onboarding as a small dashboard item, because he asked for exactly
  this.

### 2026-09-02 – Ruled: the daemon watches its services; the owner is TOLD when one goes dark. And byollm_020 (dev mode) named

**Service-loss notification (builds on .68's presence-carries-state).**
The periodic probe already detects a service that stops answering
(signed-out, gone, later quota-blocked via 019). Missing: telling the
person. Ruled:
- The hub, on a service transitioning answers → cannot-answer while
  ANY live mapping points at it, notifies the OWNER: email (the
  first-delivery-notice pattern exists), naming service, device,
  reason and the fix ("claude on tood-mbp needs sign-in – run
  `claude` in a terminal"). Transition-triggered with a debounce –
  a flapping service sends one note, not forty; at most one
  reminder/day while dark. Recovery sends nothing (the button's ⚠
  clearing is enough).
- Owner only, full reason. Sites see the class through existing
  channels; the embed ⚠ (website-sync, this date) is the in-context
  surface for the person.
- Hosted Devices make the fix one click (console link in the email).
Sequencing: needs .68's wire piece first; the notification is a hub
feature after it. Rides with or after .68, before the open door.

**byollm_020 candidate – dev mode ("your LLM wiring in minutes").**
Todd's use case: connect BYOLLM in a local app during development and
all model wiring – including trying different models – is done in
minutes; push to the web and it keeps working. The bones exist: direct
mode IS localhost-against-your-own-daemon (the product's origin
story), and the cloud lane is the deploy shape. What's missing is the
frictionless path: no site registration for localhost, no keys
ceremony, one `dev: true` (or CLI: `npx @byollm/server dev`) that
wires the local daemon with dev-scoped identity, jobs claimable ONLY
by the developer's own devices, and API parity so the same code runs
on both lanes – the switch is config, not code. Spec to write when
called; positioning entry rides now (it is pitch #1's little sibling:
"zero LLM wiring before you've picked a vendor").

### 2026-09-02 – All five P0s closed; .68 RULED as the small release carrying the Realtime fix

P0 4 fixed (per-job resolver map); the first fixture passed against
the bug – fakeClient never fired its row-change callback, so waits
settled from their opening checks and resolvers never overlapped;
mutation said so; rebuilt to interleave (both waits registered, THEN
A's event, store silent until told). Third vacuous-first-fixture this
week, all three caught by mutation – the discipline is carrying its
weight. RULED: **cut .68 after HIGHs 16/12/13, carrying the Realtime
fix plus whatever is green** – the corruption is in .67, which is what
Kevin and Eric install today, and it bites exactly the busy integrator
(Realtime delivery + concurrent jobs). The stated .68 manifest
(audience stub drop, Your Devices auth state) slides to .69. Same
hotfix playbook, third use; `latest` follows once proven from the
registry.

### 2026-09-02 – Manifest shape RULED: object, kept, for reasons now written down

Two people wrote the array form unprompted, so the question was asked
properly and closed. Object stands: **the key is an identity, not a
field** – on the left it is structurally not-casually-editable, in an
array it looks as editable as `label` (and renaming a key deletes a
purpose and unmaps everyone who chose for it); **uniqueness is
structural** – an array admits two `books` entries and mappings are
stored against (purpose, kind), so a duplicate is routing ambiguity,
which an object cannot express; **Postgres enforces the object
directly** (jsonb_object_keys / jsonb_each / `? 'default'`) where an
array needs a hand-rolled uniqueness check a CHECK constraint can't
hold; and the hot path is `Set(Object.keys()).has(purpose)` per
enqueue. The array's one real advantage – author order – is discarded
on purpose (slotsFor sorts by label everywhere).

Riders: (1) the near-miss refusals now teach the three wrong envelopes
and print the shape – shipped; (2) **the editor gains a raw-text
duplicate-key scan BEFORE parse** – JSON.parse keeps the last
duplicate silently, so a pasted manifest with two `fact-checker` keys
loses one definition with no error unless the raw text is checked;
the object shape can't express the duplicate, but the author's paste
can contain it; (3) if the wrong envelope keeps arriving after the
teaching, the answer is a FORM (label/description/kinds, key derived
and shown fixed) – never a second accepted format; (4) **the docs
manifest example is pulled forward from Batch C, now** – Kevin
inferred the format from nothing, which is most of why he got it
wrong; the example ships in the best-practice shape (site-named
everyday purpose first). Ergonomics evidence recorded honestly: the
format is right and it isn't obvious.

### 2026-09-02 – Auto-update RULED (Todd's ask, shaped): the floor and the updater are two features, both wanted

Todd: ask at setup to auto-update byollm (default on for hosted);
alternative = refuse outdated daemons with a printed remedy. Ruled:
these are complements, not alternatives – **the FLOOR is correctness,
the UPDATER is hygiene**, and the fleet needs both.

1. **The floor (first – smallest, and the backstop).** The hub
   declares a minimum supported daemon version on the channel that
   already exists (the protocol-version machinery that refuses "0"
   today). A too-old daemon is refused at connect/claim with the
   remedy printed: "byollm X.Y is below the supported floor – run
   `npm i -g byollm` then `byollm install`." Raising the floor is a
   deliberate act with a spec note, never automatic.
2. **The updater (no second runner).** The SUPERVISOR is the right
   home: the daemon learns the current version on the channel it
   already polls (no new phone-home), then DRAINS (finish the running
   job, claim nothing), runs `npm i -g byollm@<exact version>` +
   `byollm install`, restarts, and the boot canary must pass –
   **an updater must be able to un-update**: previous version kept,
   auto-rollback on a failed boot canary, and the failure reported on
   the owner surfaces.
3. **Consent posture:** setup asks "Keep byollm up to date
   automatically? [Y/n]", default YES (consistent with the other
   defaults-yes; owner's machine, owner's switch – `byollm config`
   can flip it). Hosted Devices: ON and not asked – our box, stated
   plainly on the provision page.
4. **Version semantics:** during alpha, everything auto-applies (that
   is what alpha means). From 1.0: patch/minor auto-apply; a MAJOR
   applies after a grace window or when the hub raises the floor –
   the floor is how stragglers are moved, never a silent major jump
   on day one.
5. **Staged rollout, honestly cheap:** the hosted fleet updates first
   (we watch it – it is the canary cohort), personal devices follow
   with jitter, never the whole fleet in one minute. A bad release
   must not be able to take every device down simultaneously.
6. **Named for the record – the trade:** an auto-updating daemon means
   whoever controls the npm publish controls the fleet. The controls
   are the existing 2FA on publish, exact-version installs (never
   `@latest` inside the updater), the canary+rollback, and the staged
   cohorts. This is the Chrome trade and it is the right one for a
   protocol daemon; it is written down so nobody discovers it as a
   surprise.
Sequencing: floor rides the next daemon release that touches connect
(.69 candidate); updater ships WITH byollm_018 (hosted-on by design)
and reaches personal devices the release after, behind the setup
question. Spec-fit by CCB; this entry is the ruling.

### 2026-09-02 (eve) – Batch B supervision trio done; corrections accepted; codex canary next

CCB: the Windows task XML declared UTF-16 while writeFile wrote utf8
for every platform – schtasks refused it on EVERY machine, so
restart-on-failure has never once shipped to a Windows user, uninstall
removed the never-registered XML and left the Startup entry ("a
machine doing work its owner told it to stop, and being told it had
stopped"), and status truthfully asked a supervisor that knew nothing.
All three fixed; the tests assert the BYTES on disk (BOM, UTF-16LE
NULs) because declaration-vs-write disagreeing is what broke – a
declaration-only test would have passed throughout. Fourth vacuous
first fixture of the week (uninstall test wrote into a nonexistent
dir, caught by mutation). CCB's correction to the review ACCEPTED for
the record: the fallback did print schtasks' own words; the framing
invited the permissions reading, and the substantive harm was the
unsupervised install – reviews get corrected by evidence like
everything else. Also: model-server auto-start (three tiers) filed to
the icebox top by Todd; detection-first stands.

RULED on next: **codex canary first** – it completes Batch B and it is
a hole in the auth gate itself (a signed-out Codex passes setup,
connect and the model verb while every job fails; `answers` is
undefined, never false – not-asked-is-not-no cuts both ways: a backend
that CAN be asked must actually be asked). Then cut .69 so Kevin can
re-run `byollm install` onto a real registration. byollm_019's draft
follows – it is Batch C's spec work and C follows B.

### 2026-09-02 (eve) – Codex canary green; the device-page sentence removal sequenced AFTER latest moves

CCB's trace ratified: of the device page's prerequisite note, Node and
have-a-model survive (setup finds, never installs); "run claude/codex
first to confirm signed in" becomes the daemon's job – but that
sentence is REDUNDANT for Claude and LOAD-BEARING for Codex until .69
is `latest`, because the card says `npm i -g byollm@latest` and until
the tag moves, followers get a daemon without the codex gate. Ruled
sequence: coverage the canary's failure path (84.87% vs the 85% bar –
cover it, never lower it, correct) → cut .69 → Todd moves latest →
THEN the line comes off the page. Copy that outruns the installable
daemon is the device-page NOTE bug again, avoided in advance this
time. The canary itself: property-keyed on the REGISTRY (backends
whose cost is a subscription – the ones whose credentials expire while
the binary stays put), with a control against an empty enumeration; a
third CLI next year is covered without anyone remembering the file.
Mutation-verified by name.

### 2026-09-02 (eve) – P0 IN PRODUCTION: deployed hub rejects .68 daemon reports on schema validation (lockstep)

CCB halted the .69 cut, rightly. `pair` and every report since are
rejected by the DEPLOYED hub for schema validation, from a .68 daemon
installed off `latest`. This is the lockstep failure the audience-stub-
drop entry warned about, arrived early and from a different seam:
daemon and hub disagreeing about protocol shape IN PRODUCTION, so any
customer who installed today has a daemon that cannot report. Kevin,
Eric-to-be, Todd's own devices – all on latest, all affected.

Priority: **this is the only thing that matters** – ahead of the
canary, the cut, the walk's remaining stops, everything. It is worse
than any Batch-A P0 because it is live and it silently breaks every
new install. Diagnosis discipline (for CCB, before any fix):
1. **Name the shape mismatch exactly** – which field, which direction,
   which validator (hub-side zod? relay schema? protocol version
   gate?). Capture the actual rejected payload and the actual
   expectation, not a theory.
2. **Which side moved** – did the hub deploy get ahead of the
   published daemon, or a daemon change ship in a .6x that the live
   hub predates? The digest in Pulumi.prod.yaml and the .68 daemon's
   wire shape are the two facts; compare them, do not infer.
3. **Fix on the side that is wrong, not the side that is easy** – if
   the hub deploy is newer than what daemons run, the fix may be a hub
   redeploy/rollback, not a daemon release; if a daemon shipped a
   shape the live hub never learned, the hub needs the migration
   first. **The lockstep law: a wire-shape change lands hub-first
   (accept old AND new), then daemon; never daemon-first.**
4. **Proof from outside** – a real `pair` + report against the
   deployed hub goes green, same instrument the walk uses, before this
   is called closed.
5. **The missing guardrail is the finding** – nothing caught daemon
   and hub diverging before customers did. A contract test that runs
   the published daemon's wire shape against the deployed hub's
   validator (or a shared schema both import and a check that they
   match) is owed the moment the fire is out – this is the
   satisfiability-unreachable lesson (a feature exists when its first
   consumer runs it) one level up: a protocol exists when both sides
   agree on it, and nothing asserted that.

### 2026-09-02 – Evidence + mitigation for the lockstep P0 (screenshots)

`byollm status` on Todd's .68 (installed via `latest`, so latest=.68):
- **daemon 0.1.0-alpha.68, protocol 1**; `state: NOT REPORTING`
- **the hub has rejected this device's last 811 messages** – "running
  and invisible"; error verbatim, both pair and report: **"request
  failed schema validation"**.
- Setup itself was clean – found claude, wrote config, offered connect;
  the ONLY failure is the hub rejecting the wire shape. So config,
  identity, service detection all fine; it is purely daemon↔hub schema.

Bright spot, named: the status page told the whole truth unprompted –
"anything below is what this device believes, not what the hub has
been told." The failed-read-honesty and owner-surface laws paid off in
the worst moment: the daemon that cannot report still says exactly why.

**It is schema validation, NOT a protocol-version refusal** (protocol
prints 1 and the version gate would name a remedy). So it is a
field-shape disagreement WITHIN protocol 1 – a daemon-emitted shape
the deployed hub's validator rejects. Given .65/.66/.67/.68 all
shipped after the last hub deploy (satisfiability, 09-01, digest in
Pulumi.prod.yaml), the leading hypothesis is **daemon got ahead of the
hub**: a report/pair field changed in a recent daemon release and the
live hub validates the older schema.

**Decisive test for CCB (2 minutes, no deploy):** run a real .68
pair/report payload against the CURRENT hub HEAD's validator locally.
- **Green** → the code is already correct and the deployed hub is
  simply STALE. Mitigation = **roll the hub forward** (deploy current
  HEAD via roll.sh) – restores every device; this is a normal roll,
  not a rollback, and needs no daemon release.
- **Red** → the divergence is real in code: HEAD hub and .68 daemon
  disagree. Then fix the SHAPE hub-first (accept old AND new), deploy,
  and only then consider a daemon release. Never publish a daemon that
  a deployed hub can't read again.

Mitigation ranking is not the tidy fix, it is restore-reporting-now:
every device on `latest` is invisible right now, so whichever branch,
the hub side moves first because it is one deploy vs. thousands of
reinstalls. The guardrail owed once green: a contract test that runs
the PUBLISHED daemon's wire shape against the DEPLOYED hub's validator
in CI – "a protocol exists when both sides agree, and nothing asserted
that." .69 stays halted until a real pair+report against the live hub
goes green from Todd's machine.

### 2026-09-02 (night) – P0 RESOLVED: one optional field under .strict(). The fleet reports again

Root cause, proven not reasoned (both published protocols parsing the
exact object runner.ts:604 builds, with a control): **`knownModels`**
– byollm_017 ruling 3's field – joined Capability in the daemon while
hub/package.json still pinned .65. Every wire object is `.strict()`,
the capability matrix rides BOTH PairStartRequest and HeartbeatRequest,
so one unrecognised key took out pairing and every heartbeat, once per
ten seconds – hence 811. CCB's correction to my framing, accepted: not
a deploy that failed to happen – **the pin was stale in git**; .65
through .68 all published against a hub manifest nobody moved.

Two laws minted, both CCB's words kept:
- **Under `.strict()` there is no additive-and-optional. Every new
  field is breaking – and it breaks on the side nobody upgraded, which
  is never the side running the tests.**
- **"A registry is a schema; an enum value is the contract" was one
  noun short: a field NAME is the contract too.** The old gate
  compared vocabularies (closed value sets) truthfully and passed;
  nothing compared keys.

Honest accounting against the overnight review: it FOUND this gun –
M2, "hub pins everything .65 exact; nothing resolves .67" – and triage
(mine) filed it under hygiene/icebox. Second MEDIUM this week that was
a P0 wearing a chore (declareManifest was the first). Triage rule
amended: **a stale version pin on a `.strict()` wire is never
hygiene** – any finding that two sides of a strict protocol resolve
different versions ranks as a lockstep hazard, not a sweep item.

The guardrail, shipped: wire-shapes.ts walks the protocol's own
exports into key paths; GET /wire serves them; the promotion gate
compares, importing the hub's walker so the two sides cannot drift
into answering different questions. Deliberately NOT on /healthz –
that is the liveness probe, and a reporting fault there would wear a
crash loop. Proven both ways against a stub hub (refuses .68 by name
across six schemas when serving .65's keys; passes serving .68's) –
without the second run it would be a gate that refuses forever and
looks identical from the failing side. Fifth vacuous first fixture of
the week caught by mutation (optional scalar → optional object, so
the wrapper must actually open).

Roll: clean – edge watched 143 probes over 301s, all 401; the e2e ran
a sealed job, routed a purpose-named job, and refused an unmapped slot
at enqueue, through the hub it had just deployed. Production accepts
knownModels on all three paths; promotion gate green against live prod
for .68. Exposure window: `latest` was .68 throughout, so ANY install
since knownModels shipped paired-blind – Kevin's version should be
confirmed (a .67/.68 daemon recovers on its own now; a pairing that
never completed needs `byollm connect` re-run, which is Todd's own
next command). .69 cuts when CI is green, per standing instruction.

ALSO: two CI runs at action_required on "fix(daemon): trust Codex
terminal events over exit status" – an OUTSIDE PR on the public repo.
First outside contributor. Todd reads the diff BEFORE approving the
workflow runs (action_required on a fork PR is a security gate, not a
formality) – and the title suggests they found a real thing in
exactly the territory this week's canary work lives in.

### 2026-09-02 (night) – Re-pairing must update, never replace (ruled, Todd)

Todd, on the live walk: re-running `byollm setup`/`byollm connect`
asks for the full pairing ceremony every time – new code, new
approval, a new device row on the dashboard, and the old row heads
for the Revoked list. Pairing is replacing the device when it should
be updating it.

RULED:
1. **The stored device credential IS the device.** On connect/setup,
   present it FIRST. Hub recognizes it → reconnect and print
   "Connected as <device-name> (paired <date>)" – no ceremony, no
   new row. Only a missing, revoked, or refused credential enters
   pairing. (Found is not works: present-and-probe, never assume –
   but a credential that probes good is a session, not a ceremony.)
2. **Same device, same row.** A re-pair of the same machine after a
   credential loss may mint a new keypair, but a healthy re-run must
   land on the existing dashboard row – never a revoked-row trail
   from routine re-runs.
3. Law minted: **a ceremony repeated becomes a habit, and a habit is
   not a comparison.** The fingerprint check is load-bearing exactly
   because it is rare. Asking on every run trains the person to
   approve without looking; approval fatigue is a security
   regression, not a UX blemish.
4. Likely culprit is already boarded in Batch D: the config
   migration that keeps only the services keys – the device
   credential rides in config, so every migration-touching run
   orphans it. PULLED FORWARD into the pairing-polish pass; CCB
   confirms the actual cause either way.

Acceptance: run `byollm setup` twice on a paired machine. The second
run performs no ceremony, prints the connected-as line, and the
dashboard shows one device row and nothing newly revoked.

### 2026-09-03 – Walk findings, daemon half (Todd, on .70; transcript kept)

1. **Install reported success while the service was dead (P0-class).**
   Setup's "Run in background? [Y]" printed "Installed. launchd will
   keep byollm running…" and TEST YOUR DEVICE — while `byollm status`
   showed "service: installed but NOT running (not running (last exit
   2)) — this device is on rosters and serving nothing." A manual
   `byollm install` minutes later worked and took jobs. Every law
   involved is already on the books: copy not behaviour; found is not
   works; a promise belongs to the party that can keep it (the TEST
   line printed for a dead service); the updater's boot-canary
   principle applies equally to first install. RULED: install — the
   setup step and the standalone verb — ends with the same probe
   `status` uses and prints Installed + TEST YOUR DEVICE only when
   the daemon is confirmed running; otherwise it prints the failure,
   the last exit code, the log path, and the remedy. Separately:
   root-cause the exit 2 on setup's install (a race with pairing
   state written moments before? port still held?) — status knew, so
   detection exists; install never asked.
2. **TEST YOUR DEVICE printed twice** in setup — the install step's
   own success print plus setup's completion print. One printer.
3. **`byollm models claude fake` silently ignored its arguments** and
   listed models as if called bare. A command handed arguments it
   does not understand must refuse and point at the right verb
   (`byollm model claude <name>`), never act like a different
   command. Extra is not absent — the swallowed-argument cousin of
   missing is not none.
4. **An unlabeled second fingerprint** (BYOLLM-E2RN-…) prints after
   "paired as <uuid>" in both setup and connect runs. Label what it
   is or remove it — an unlabeled fingerprint invites a comparison
   nobody defined, on the exact screen where one comparison is
   sacred.
5. Confirmed again on .70: setup AND connect run the full ceremony
   on an already-paired machine. The re-pair update-not-replace
   ruling (09-02 night) stands as specced; this transcript is its
   evidence.

Addendum, same night, after CCB's .70 report crossed this entry:
CCB shipped the TEST pointer as one constant "printed only on
success, both failure paths asserted" — and the walk transcript
shows it printed for a service at last-exit-2. Both are true, which
locates the bug precisely: the success predicate is wrong. It
accepts launchctl's load, not the daemon's life — found is not
works, one layer down. The probe must be the one `status` uses
(which caught it), waiting for the running state, not the loader's
exit. The double print now also has a shape: setup runs install,
install prints the pointer, setup prints it again — when install
runs inside setup, exactly one of them speaks. And a question for
CCB on "the reconnect" shipped in .70: Todd's `byollm connect` on
.70 still PRINTED the full ceremony (steps, code, fingerprint) and
resolved to the SAME device uuid. If it auto-resolved without
approval, the printed ceremony is theater — steps that resolve
themselves teach people to ignore steps, on the page where one step
is sacred. If it required approval, the reconnect didn't engage.
Either answer is work.

Diagnostic lead (Todd, same night): the failed install ran INSIDE
setup's interactive session; the manual one ran at a bare prompt.
That difference shouldn't matter to launchd — which is exactly why
it's a good lead if it does (environment captured into the plist at
generation time, or the daemon starting against a config setup was
still writing — a race the standalone run, seconds later against a
finished config, wouldn't hit). The evidence is already on disk:
/Users/toddsampson/.byollm/service.log from that window holds the
exit-2 run's own words. Read the log before theorizing.
