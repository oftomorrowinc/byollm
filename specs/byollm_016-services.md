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
