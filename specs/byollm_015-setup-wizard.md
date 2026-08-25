# byollm_015 — Setup wizard, peer CLI backends, and the first modality kind

**Status: specced 2026-08-24, not yet scheduled. Graduated from
discussion (Todd, 2026-08-24) after the pairing walk showed the
out-of-box experience is "edit JSON."**
**Depends on: byollm_002 (routing), byollm_004 §2 (process isolation),
byollm_007 (cost class), byollm_008 (promoted by Phase 2), byollm_013
(detection must run the thing).**

Three phases, deliberately ordered by leverage over cost: the wizard is
small and huge, the adapters are medium and mechanical, the new kind is
protocol work that earns its own threat review. Each phase ships alone.

## Phase 1 — the first-run wizard

`byollm setup`: an interactive first-run flow, invoked automatically by
`byollm connect` when no config exists, and runnable any time on its
own. It converts setup from "edit JSON" to three questions:

1. **"What should this device be called?"** — the `--name` prompt,
   folded in so identity has a human label from minute one.
2. **"Use your Claude subscription for your own jobs? [Y/n]"** — asked
   only when detection finds a working `claude` CLI. Yes writes the
   `claude-cli` backend and default routes into config on the spot.
3. **"Add a custom or local model now? [y/N]"** — default no, with a
   pointer to the models guide. The mainstream path stays three
   answers long; the LoRA path is a link, not a fourth interrogation.

**Service adds reuse the same flow.** `byollm add` re-enters the wizard
scoped to one backend: detect, ask, write config, re-advertise. There
is one setup conversation in the product, not a first-run one and a
different later one.

Laws the wizard lives under, restated as its own obligations:

- **Detection means running the thing (byollm_013).** The wizard's
  checkmark next to a detected CLI must mean the probe exercised the
  argv we will actually send — never `which` alone. A wizard that
  advertises what detection didn't run recreates Kevin's Windows bug
  with a friendlier face.
- **The wizard never touches credentials.** Subscription CLIs
  authenticate out-of-band; the daemon inherits a session it cannot
  see (byollm_008 question 3). The wizard neither reads, copies,
  tests-by-spending, nor logs any credential. Its health probe must
  not cost a token.
- **The self-lock is spoken, not buried.** Enabling a
  subscription-class backend states in the wizard's own words that
  this backend serves only its owner's work, forever
  (`SUBSCRIPTION_IS_SELF_ONLY`). Consent wording is product law: the
  moment of enablement is the moment of disclosure.
- **Config is the only output.** The wizard writes the same
  `~/.byollm/config.json` a hand would — `type` (per the field
  rename), named backends, routes per kind. No wizard-only state, no
  second config surface. A user who never runs the wizard loses
  nothing but convenience.
- **Advertise at pair time.** Because the wizard runs before first
  connect, the mainstream daemon advertises something the moment it
  pairs — dissolving the connect-with-no-backends amber state for the
  common case while keeping connect-first (alpha.34–39) for the rest.

## Phase 2 — Gemini CLI and codex as peer backends

Promotes byollm_008 from stub. The economy is stated there and stands:
these are not registry lines; each CLI is its own binary with its own
argv, stdin contract, env allowlist, output parser, and adversarial
corpus rows — the byollm_004 §2 treatment, once per binary, no shared
`subscription-cli` transport (sharing argv construction is precisely
what byollm_004 forbids being generic).

Phase 2 must answer byollm_008's five questions per CLI, and one more
from byollm_007: **whether `subscription` is even the right class for
each** — decided by reading that vendor's terms, not by the fact that
it is a CLI. A CLI that bills per token is `metered` and rides that
law instead (ceiling required to widen, `REMOTE_IS_NEVER_FREE`
unaffected — these run locally but spend an account).

The wizard then detects all present binaries and asks per provider.
The self-lock applies identically to every subscription-class CLI:
their terms forbid third-party use the same way, so the lock is the
same law, not Claude-specific courtesy.

Why before strangers: "works with the subscription you already have"
is the pitch, and most strangers' subscription is not necessarily
Claude.

## Phase 3 — `image.generate`, the first modality kind

**Ruling (already made in discussion, recorded here): kinds are
modalities, never vendors.** A kind is on the wire — the *site*
chooses it at enqueue. `gemini.generate` as a kind would let sites
demand a vendor, breaking the abstraction this protocol sells (the
site asks for work; the owner decides what serves it) and handing
vendors leverage over an open protocol's vocabulary. The real use
case — "Gemini handles my images" — is a route: `image.generate`
mapped to the gemini backend because the owner chose it.
Owner-side preference, wire-side neutrality.

Adding `image.generate` is a protocol change to the closed kind enum
and gets the full review that implies: payload shape and size limits
(image outputs ride the large-payload path cloud_012 flags), sealing
both ways for binary payloads, `provenance.untrusted` unchanged, and
`NO_PAYLOAD_ROUTING` untouched — a job still never names a model, and
a modality kind must not become a covert routing channel through
parameter creep.

The wizard's phase-3 face is the routing conversation: "You have
Claude and Gemini. Which handles conversations? Which handles one-shot
text? Which handles images?" — routes made conversational, nothing
more.

## Sequencing

This spec is capture, not a queue jump. The current lane runs first:
alpha.44 (terminal-"gone" + rename strings), hub `/devices`, web_004's
device section, the LoRA walk. Phase 1 slots after that and before
strangers; Phase 2 before strangers if review attention allows; Phase
3 when its review can be paid for properly.

## Done when

Phase 1: a fresh install on a clean account reaches a paired,
advertising daemon through the wizard alone — no JSON edited — and
Todd has walked it through the real path. Phase 2: byollm_008's
questions answered per CLI in this spec series, corpus rows landed,
conformance green. Phase 3: the kind enum change passes protocol
review with the size/sealing questions answered in writing.

---

2026-08-24: Phase 1 is blocked on byollm_016 (the services config re-shape) — the wizard writes config and must write the settled shape from birth, not a shape about to break.

---

## Sequencing amendment + wizard defaults question (Todd, 2026-08-24, night)

**Phase order reversed: peer CLI backends (old Phase 2) build before
the wizard (old Phase 1).** Reason: three integrators are ready now
and need llm.chat + llm.generate working out of the box with the
subscription they already have — Claude first, Gemini and OpenAI
close behind. The wizard comes last so it detects the full set of
CLIs and is built once against the finished landscape. The full
pipeline, ruled tonight: byollm_016 Phase A → Phase B → gemini +
openai CLI backends (byollm_008's five questions each, per binary) →
this wizard. Phase 3 (image.generate) unchanged, later.

**The wizard gains a fourth question, conditional:** when more than
one service on the device serves a kind, the wizard asks which should
be the default for that kind and writes the `defaults` stanza. This
makes the wizard the primary author of defaults — byollm_016's
load-time ambiguity error becomes the fallback for hand-written
configs, not the mainstream experience. The unblock condition
stands: the wizard writes the byollm_016 shape, so it builds only
after Phase A settles it (now satisfied by the pipeline order).

---

## Wizard shipped (CCC, 2026-08-25 night, rides alpha.46)

`byollm setup` landed: three questions, writes the config, and parses
what it built with the daemon's own schema before writing a byte —
the wizard cannot author a config the daemon would refuse. Codex
shipped beside it with its tools proven off: canary read blocked,
plus a control leak confirming the test can detect (live check gated
behind BYOLLM_CODEX_LIVE=1) — the sixth question answered with both
controls. Pipeline-order note: this ran ahead of Phase B's hub half;
deviation ratified because wizard-last existed to build once against
the final CLI set, and the set went final when gemini-cli was
disqualified. To confirm in daylight: the conditional fourth question
(authoring `defaults` when a kind has two claimants) is present per
this spec.

Two findings worth more than the feature, both kept:

- **Detection is a parameter.** The empty-machine test failed because
  the developer's laptop has claude — "a test whose answer depends on
  the developer's install would say one thing here and another in CI,
  which is worse than no test." Rule: tests never read the
  developer's environment; they're handed it.
- **The runtime outranks the declaration.** @types/node declares
  isTTY boolean; Node sets undefined off-terminal. The linter argued
  three times from the wrong declaration, and obeying it put
  undefined into a boolean field — caught by the terminal-adapter
  test. The eslint-disable carries its explanation. Same family as
  the no-as-casts ratchet: types are claims, runtime is truth.

**The honest gap, stated as the handoff it is:** the interactive path
has never run against a human terminal (pty attempts hit readline EOF
then hung; killed rather than sunk time). Proven: 19 unit tests + the
CLI refusal path. Todd's one-minute morning task: run `byollm setup`
in a real terminal — the standing rule (Todd tests through the real
path) applied to the wizard's first breath.

alpha.46 publishing; per the release-ordering rule, latest moves only
after CCC's hub-on-.46 deploy report exists — not merely after time
has passed.
