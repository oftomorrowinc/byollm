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
`public` in the enum) with roster-follow. Cowork's note for the
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
