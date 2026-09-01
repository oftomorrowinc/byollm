# byollm_017 – Choosing the model behind a service

**Status: spec, 2026-08-31 (Todd's ask; Cowork wrote it). Direction: the
device decides what runs on it; the dashboard asks and renders what the
device reports. Phase 1 is CLI + wizard + dashboard read; Phase 2 is the
dashboard control. Does not block Kevin; rides after .64.**

## Why

Today a subscription service's model is a literal the wizard writes and
nobody can change without editing JSON: `claude-cli` → `sonnet`,
`codex-cli` → `gpt-5.6-terra` (`setup.ts` SUBSCRIPTION_CLIS). The product's
first promise is "new models work the moment you get them" – and the
person who just got Opus 5 on their plan has no way to say so short of a
text editor. Todd: "let you choose your claude and openai models in
settings."

## What already exists, and is kept

- byollm_016 made the **service** the noun and put `model` on it:
  `services.<name>.model`, owner-chosen, never payload-derived. This spec
  changes WHO can set that field and FROM WHERE – never what it means.
- The backends build argv from a frozen literal plus `--model <model>`
  (`claudeArgv`, `codexArgv`). The model is the one variable; it stays the
  one variable.
- The capability announcement already carries `model`; Your Devices and the
  mapping picker already show it. Rendering needs no new field.

## Rulings

1. **The config on the device is the truth.** Every path to a model change
   ends in the daemon writing `services.<name>.model` and re-announcing
   capabilities. No hub-side "desired model" column that the device may or
   may not honour; the dashboard is not the boundary, and a cloud row that
   disagrees with the machine is two truths.
2. **Found is not works – a model is verified before it is stored.** Setting
   a model runs the same can-it-answer probe the auth work introduces (one
   cheap real call, `--model <candidate>`). The CLI's own first line comes
   back on refusal ("model not found", "not available on your plan",
   "needs sign-in"). A model that cannot answer is never written.
3. **No frozen list anywhere a person picks from.** The daemon ships a
   `known` list per backend (claude: `opus`, `sonnet`, `haiku` plus the
   dated ids; codex: its current ids) as SUGGESTIONS, updated with
   releases, and announced with the capability so the dashboard shows
   what THIS device's CLI knows. Free text is always allowed – that is
   the promise – and ruling 2 is what makes free text safe. The dashboard
   never carries its own model list.
4. **Only the owner.** A service's model is set by the person who runs the
   device – never a teammate the service is shared with, never a platform
   admin. Shared readers see the model name, not a control.
5. **One model per service; a model per site is a service per model.**
   No per-mapping model field. Someone who wants Opus for one site and
   Sonnet for another defines two services on the same CLI (`claude-opus`,
   `claude-sonnet`) and the mapping picker already offers both. Phase 1
   permits more than one `claude-cli` / `codex-cli` service in config;
   the wizard still creates one.
6. **The wizard does not grow a question.** `byollm setup` keeps its
   default and says it: "claude · model: sonnet – change any time with
   `byollm model claude opus`". Three questions stays three.

## Phase 1 – CLI, wizard, dashboard read (daemon .65 or the first release after .64)

- `byollm model <service> <model>` – probe (ruling 2), write, re-announce,
  print the CLI's line on refusal. `byollm model <service>` alone prints
  the current model and the known suggestions. `byollm models` lists every
  service with its model.
- Wizard line per ruling 6.
- Config: allow N services of one subscription type (ruling 5); the
  subscription self-lock and the 016 withheld-kind rules apply per service
  exactly as now.
- Capability announcement gains `knownModels: string[]` beside `model`.
- Dashboard (Your Devices → service): shows the model (already) and, for
  the owner, the exact command to change it – copied, not typed. Not a
  control yet; a control that can only say "run this" is a sentence.
- docs.byollm.cloud/guides/models: the section this spec describes, one
  screen, with the "new model day" story: type it, the device checks it.

## Phase 2 – the dashboard control

Your Devices → service → **Model** (owner only, device reporting only): a
text field pre-filled with the current model, the device's `knownModels` as
suggestions, Save. Save sends a *request* to the device over the existing
device channel; the device probes, writes, re-announces; the dashboard
renders the announcement, not the request. States: "asked tood-mbp –
waiting" (failing-is-not-refusing; the device answers in seconds or the
page says it did not hear back and why); refused with the CLI's line;
applied, with the new name on the card. Offline device: no control, one
sentence ("tood-mbp is not reporting – change it there, or when it is
back"). No queued changes: a request nobody is there to verify is a
"desired" column wearing a message.

## Out of scope, named

- Which model a SITE asks for. Sites ask for kinds and purposes; the
  person maps them to services; the service names the model. A site that
  wants "Opus specifically" is a site trying to reach past consent.
- Cost/quota warnings per model. Subscription-class, owner's plan, owner's
  choice; the daemon's cap and pause verbs are unchanged.
- Ollama/MLX model switching from the dashboard rides the same Phase 2
  mechanics (the probe asks the server for its model list); Phase 1 covers
  them via the CLI verb only.

## Tests that prove it (the fixture must reach the failing state)

- `byollm model claude not-a-model` refuses with the CLI's own line and
  the config is byte-identical afterwards.
- A shared reader never receives a model control; an owner does.
- A model request from a non-owner session is refused at the hub, not the
  device.
- Two `claude-cli` services with different models announce two candidates
  and the picker offers both.
