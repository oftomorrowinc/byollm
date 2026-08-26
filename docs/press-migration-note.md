# Press migration note — the admission redesign (2026-08-26)

Kevin: this landed while you were offline, deliberately. It breaks press until
press adopts a manifest, and the breakage is safe — press falls back to its own
API the whole time, the way it already does for users who never connected.
Nothing is on fire. Read this before you start.

## What changed, in one paragraph

Sites used to ask for a **service by name** and the device decided whether to
admit the user. Both halves were wrong. Sites now declare what they **need** —
purposes and the kinds each purpose uses — and each user maps those needs to
their own services on the byollm.cloud consent screen. The mapping *is* the
consent. The hub resolves (purpose, kind) → service per user at claim time and
signs a grant the device verifies. **Press never sees a service name again**, in
either direction: not to select one, not to display one.

## What press has to do

**1. Declare a manifest at site registration.** Purposes to kinds:

```json
{
  "writing_assistant": ["llm.chat", "llm.generate"],
  "revenue": ["llm.generate"],
  "advertising": ["llm.generate", "llm.image"]
}
```

Those are illustrative — pick the purposes that match how press actually uses
inference, in press's own vocabulary. They are the labels your users will read
on the consent screen when they choose which of their services drives each one,
so name them for a reader, not for the code. A site with a single undifferentiated
use can declare a flat kind list (`["llm.generate"]`), which is sugar for one
site-wide purpose.

Two things about purposes worth knowing before you pick them:

- A purpose is the unit a user maps and revokes. Two uses that a user might
  reasonably want pointed at different models are two purposes.
- Changing the manifest later never silently remaps anyone. New purposes and new
  kinds start **unmapped**, and an unmapped slot makes that purpose unavailable
  until the user maps it — press falls back meanwhile, and the user gets a
  notification asking them to come update it. So graduating from a flat list to
  named purposes unmaps every existing user once. Better to name them now.

**2. Enqueue by purpose + kind, never by service name.** The exact SDK signature
ships with the release; the shape is that the job names the purpose it serves and
the kind it needs, and nothing else about *what will run it*.

**3. Handle "unmapped" the same way you already handle "unavailable."** Press
already has the fallback branch for users with no connected device. An unmapped
slot arrives on that same branch. You learn *that* a slot is unsatisfiable; you
never learn why — that opacity is deliberate and load-bearing.

## What to delete

- Any code that reads an advertised capability list or service names.
- Any code that passes a service name to select a model. The selection path is
  gone on both routes; `REFUSED_SELECTION`, capability rows and `isDefault` all
  retire.
- Any UI that displays which model or service is going to run a user's job.
  Press does not have that fact anymore and cannot get it.

## What press does *not* have to do

- Nothing about users, teams, or admission. Press never decided who could run —
  that is the hub's, enforced by a signature the device checks. There is no
  allowlist, roster, or per-user anything on your side.
- No fallback rewrite. The branch you have is the branch this uses.

## Timing

The rip publishes as byollm 0.1.0-alpha.58+; `latest` stays at .56 until the
acceptance probe passes. Press stays on its current version and keeps falling
back until you adopt the manifest — there is no deadline and no half-migrated
state to sit in.

Questions to Todd or to me. If a purpose vocabulary for press is the hard part,
say so and we will work it out together — it is the one decision here that is
genuinely press's to make and hard to change later.
