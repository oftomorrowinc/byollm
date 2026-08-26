# byollm_005 — Landing site + docs

**Status: bones in `site/index.html`; this spec is the build-out.**
The landing page exists as a single self-contained HTML file (dark,
developer-focused, no dependencies). Two jobs: harden the landing
into a deployable site, and stand up real docs.

## 1. Landing (`site/`)

- The current `site/index.html` is the design + copy of record. Keep
  it **self-contained and dependency-free** (it must open from a file
  and deploy to any static host / GitHub Pages / Vercel with zero
  build).
- Add: an OG/Twitter card image + meta; a favicon (the green dot);
  a real "copy" affordance with copied-state feedback; prefers-
  reduced-motion honored; Lighthouse ≥95 all categories; the
  npm/GitHub links go live when the packages publish.
- Keep the honesty rules from the product itself: never claim a
  capability the code doesn't ship (the security section's
  breakout-vs-injection boundary is load-bearing marketing *and*
  true — do not soften it).
- Deploy target: `byo-llm.com` (static), on Vercel — **live 2026-08-12**
  from the `byo-llm-www` project, apex CNAME through Cloudflare
  (DNS-only; proxying Vercel redirect-loops). `getbyollm.com` was
  considered and dropped — one canonical name, no redirect to keep
  alive.

## 2. Docs

Docs are **generated, never hand-drifted** (the standards rule).
Structure:

- **Quickstart (devs)** — the three-file integration, runnable.
- **Quickstart (users)** — `npx byollm connect`, config, the trust
  commands.
- **Protocol reference** — rendered from `@byollm/protocol` (the
  normative `docs/protocol.md` + generated type docs).
- **Server adapters** — in-memory, Next mount, Supabase; how to
  write your own against `JobStore`/`RunnerStore`.
- **Backends** — Ollama, claude CLI, MLX; how to add one (and the
  requirement that a new backend ships adversarial-suite rows).
- **Security** — the full threat model from `byollm_004`, verbatim,
  with the breakout-vs-injection distinction front and center.
- **Audience & sharing** — the nine-way matrix, the subscription
  self-lock, how to enable community compute.
- **Conformance** — how to certify a server; the one command.

Tooling: a lightweight docs generator (e.g. a static-site tool that
consumes markdown + TSDoc); **every code sample executes in CI** so
docs can't rot. Docs and site share the landing's visual language
(same tokens) but docs are their own surface — do not cram reference
material onto the landing page.

## Out of scope

Blog/changelog site (later), i18n, interactive playground (a
"try it" sandbox is tempting but needs a hosted model — defer).

## Done when

`site/` deploys to `byo-llm.com` as static files; docs build from source with every example passing in CI;
protocol + type reference are generated, not hand-written; Lighthouse
≥95; nothing on either surface claims a capability the shipped code
lacks.

---

2026-08-25 (Todd's ruling): the models guide gains a **model-name
reference** per provider: claude-cli (aliases — sonnet, opus, haiku —
float to current; full ids — e.g. claude-opus-5 — pin; both accepted),
codex-cli (OpenAI's current names, e.g. gpt-5.6-terra), and
openai-http servers (the name is whatever the server's /v1/models
lists — teach the curl), with a link to ollama's cloud model catalog
for `:cloud` names. House style applies: teach the verification with
the names — a model name goes through detection, so the guide says
"edit, restart, run `byollm services`; a wrong name fails loudly
there," never just a table of strings to trust. Aliases-vs-pinning
stated plainly (float tracks the vendor's default; pin survives it).

## Docs sweep for the identity + selection wiring (Todd's ask, 2026-08-25)

**Now (rides the paste-id interim):** the integrate guide is actively
wrong — it teaches owner-from-session, direct-mode truth and
cloud-route error, the exact confusion the first real integrator hit.
It gains the two-mode split: direct = your app's own user ids;
cloud = the byollm.cloud id, user must have connected your site,
read-and-paste from the account page today, save-time validation via
available({kind, owner}) with the existence-neutral wording taught as
the pattern. Same content in the @byollm/server package README (npm
is where integrators actually land). Cheap riders: the reference
documents Phase B selection (the service field, key-vs-value, the
menu, selection-unavailable — shipped in .48, never documented); the
glossary gains "your BYOLLM id" (caveat in the UI's own words) and
"consent/connect."

**Queued, already ruled:** model-name reference; supported-backends
table incl. gemini's not-supported entry; connect guide re-opened
wizard-first (byollm setup, byollm install, NOT REPORTING in
troubleshooting).

**Deliberately not yet:** the Connect button (cut-until-true — the
connect-flow PR documents itself atomically); trust-page MUST
additions (wait for Amendment G's RATIFIED, cite law not drafts).

Addendum (2026-08-25, from Kevin's first-test checklist): the
integrate guide's testing section gains the **owner-side first-job
checklist**, because the first real integrator's otherwise-correct
checklist missed the device-side door: (1) daemon running (byollm
status: running, not NOT REPORTING); (2) the serving backend healthy
(for openai-http, the model server up — curl its /v1/models); (3)
site connected on Connections (consent — permission to the cloud);
(4) **site approved on the daemon** (byollm sites → byollm approve —
permission to the app; the two doors are different on purpose and
the missing one produces a meaningful-looking timeout); (5) owner id
pasted site-side. Teach it as the owner's half of the test, beside
the integrator's half the guide already carries.

## byo-llm.com review vs alpha.56 (Cowork, 2026-08-26) — cloud never mentioned

Ordered list, from source review of site/index.html (banner already
says alpha.56, making stale content read as current):

Breaks-if-pasted: (1) enqueue example says audience: "self" — the
schema refuses it; must be "private". (2) Step 2 teaches
backends+routes with the "backend" field — becomes services/defaults
with "type".

Wrong/missing law: (3) Sharing-section scope words self/named →
private/team (CSS class names may stay; rendered words may not).
(4) The ruled gemini-cli not-supported entry never landed — add with
reason + date + re-test sentence. (5) Ollama's unqualified "free"
gains the :cloud footnote (tagged models run on Ollama's cloud,
metered — the money direction may not be implied wrong on a
marketing page).

Stale: (6) banner news line says alpha.5/relay under an alpha.56
version — replace with cloud-free current news (services config,
setup wizard, codex). (7) hero "no keys leave their computer" →
"their device" per the keys-are-identity scope ruling. (8)
daemon-side "backend" naming the config entry → "service".
(9) Security's "process backends (the claude CLI)" → claude and
codex CLIs.

Missing product: (10) byollm setup and byollm install absent — the
page implies hand-edited JSON and a foreground process; the
direct-mode onboarding sell (three questions, background service)
is shipped and unmade.

Constraint held throughout: direct-mode framing only; no cloud,
no rosters, no hub.

## Full docs/readme discrepancy sweep, all three repos (Cowork, 2026-08-26)

Method: grep battery over the week's stale-marker taxonomy (retired
scope vocab, old config shape, renamed commands, adapter-path,
gemini, owner guidance), specs/ excluded as dated records. Result:
**all drift lives in the byollm repo's prose; byollm-cloud-web and
byollm-cloud are clean.**

**byollm repo:**
1. **README.md — the changelog knows, the body doesn't.** Top notes
   correctly announce setup/install/PATH/the services rename; the
   body still teaches the old world: config sample in
   backends+routes with the "backend" field and offer "self"/"named"
   (~408–418); `byollm backends` in the commands list (424) two
   hundred lines below the note announcing its rename (222); the
   sharing section (466) in `named` vocabulary. Sweep: config →
   services/defaults/"type" + private/team; commands → services;
   sharing → team words. The byollm-allow description is TRUE until
   B2 — mark it to retire with B2, don't fix it early (claims ship
   with their proof, in both directions).
2. **packages/daemon/README.md:** full old config sample (~166–183),
   `byollm backends` twice (80, 187), "Keep it running" opens with
   terminal-holding — rewrite to services shape and lead with
   `byollm install`.
3. **docs/protocol.md (149, 413) + docs/security.md (397) — law
   docs teaching refused wire values.** `offer: self|named|public`
   table and `audience !== "self"` derivation (twice): the schema
   refuses "self" since the one-vocabulary rename. Same
   breaks-if-followed class as the site's enqueue sample — highest
   priority of the sweep.
4. Clean: packages/{protocol,server,relay,conformance}/README.md;
   the README's gemini not-supported note is present and correct.

**byollm-cloud-web:** clean — guides, www, llms.txt all current;
models guide's adapter-path mention is the honest callout. Cosmetic
only: apps/docs pins @byollm/protocol alpha.38 (dep freshness).

**byollm-cloud:** clean — README's "machine" is plain-English
hardware per the scope rule.

Priority order: (3) law docs (breaks if followed), then (1) README
body, then (2) daemon README. Batch with the byo-llm.com ten-item
list; same PR sweep is natural.
