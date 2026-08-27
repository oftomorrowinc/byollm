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

**1. Declare a manifest at site registration.** Todd has ruled press's v1;
labels and descriptions are final wording:

```json
{
  "books": {
    "label": "Books",
    "description": "Reads and parses your existing books for use across the site",
    "kinds": ["llm.generate"]
  },
  "fact-checker": {
    "label": "Fact Checker",
    "description": "Reviews facts in your non-fiction work and builds the reference list",
    "kinds": ["llm.generate"]
  },
  "revenue": {
    "label": "Revenue",
    "description": "Analyzes your sales, revenue, and ad spend performance",
    "kinds": ["llm.generate"]
  },
  "writing-assistant": {
    "label": "Writing Assistant",
    "description": "Outlining and brainstorming to beat the blank page",
    "kinds": ["llm.chat", "llm.generate"]
  },
  "style-trainer": {
    "label": "Style Trainer",
    "description": "Trains a model on your writing style to generate draft content in your voice",
    "kinds": ["llm.generate"]
  }
}
```

**The key is a wire id; the label is what people read.** Separate fields, and
no surface derives one from the other. A key travels on every job press
enqueues and is what mappings are stored against, so it has to be stable —
renaming one is deleting a purpose and creating another. A label is prose,
changeable whenever you like, and is the **only** thing the consent screen
renders. `description` is optional and gives that screen a line of context.

Two things about purposes worth knowing:

- A purpose is the unit a user maps and revokes. Two uses somebody might
  reasonably want pointed at different models are two purposes — which is why
  `writing-assistant` and `style-trainer` are separate even though both
  produce prose in the author's voice.
- Changing the manifest later never silently remaps anyone. New purposes and
  new kinds start **unmapped**, and an unmapped slot makes that purpose
  unavailable until the user maps it — press falls back meanwhile, and the
  user gets a notification asking them to come update it. Adding a purpose is
  therefore cheap. Renaming a key is not.

**2. Enqueue by purpose + kind, never by service name.** The exact SDK
signature ships with the release; the shape is that the job names the purpose
**key** it serves and the kind it needs, and nothing else about *what will run
it*. The key, never the label — labels are for people.

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

Questions to Todd or to me. The vocabulary above is ruled, so the hard part is
already decided — but if a use of inference in press does not fit one of those
five, say so before wiring it to the nearest one. An extra purpose is cheap to
add; a key that means two things is not.
