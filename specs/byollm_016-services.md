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
