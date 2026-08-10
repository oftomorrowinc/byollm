# Roadmap & known limitations

Recorded after the 001–004 build (2026-08-08). Honest gaps, not
excuses — the security posture depends on naming these out loud.

## npm naming (decided)

- Libraries publish scoped: `@byollm/protocol`, `@byollm/server`,
  `@byollm/conformance`.
- The **daemon publishes UNSCOPED as `byollm`** with a `bin` so
  `npx byollm connect …` works. Claimed by publishing a real
  pre-release (`0.1.0-alpha.N`, `--tag alpha` so it's off `latest`),
  not a placeholder. Org team added as maintainers of the unscoped
  package. npm has no package-to-package redirect; the unscoped
  package *is* the CLI.

## v1 known limitations (documented, not hidden)

- **No OS-level sandbox yet** for process-class backends. The
  guarantee against breakout is structural (fixed argv, stdin,
  stripped env, no tools) — strong, but there is no
  `sandbox-exec`/`seatbelt` (macOS) or `bubblewrap`/Landlock (Linux)
  jail around the child. A future spec adds one for defense in depth;
  it does not change today's honesty, it strengthens it. HTTP-class
  backends don't spawn, so this is a process-class concern only.
- **`HOME` stays in the child env** for the `claude` CLI to find its
  credentials — the child can reach the filesystem the user can
  reach; what stops it is having no tools, not the environment.
  Stated in `docs/security.md`.
- **`payload.system` fidelity on process-class backends.** The
  `claude` CLI has no `--system-prompt-file` and argv is forbidden
  for payload text, so a system prompt is folded into stdin, losing
  the role boundary. HTTP-class backends (OpenAI-compatible body)
  **preserve the system role** properly. Apps that need strict system
  fidelity should prefer an HTTP-class backend for that kind, or
  accept the fold on claude CLI. (Relevant to Press: the Claude
  polish pass should confirm folded-system output is acceptable, or
  route that kind to an HTTP model.)

## Next, roughly ordered

1. Claim `byollm` unscoped (above).
2. **First production integration = Press** (its spec 034): the three
   local apps go hosted and consume `@byollm/server`'s Supabase
   adapter. MLX *inference* is HTTP-class via `mlx_lm.server`, so v1
   is sufficient to prove the whole path (generation on your box as
   `named`, Claude review on Lis's as `self`, chained via
   `dependsOn`). MLX *training* (`train.*`, process-class
   `mlx_lm.lora`) is a later kind.
3. `byollm_005` — site build-out + generated docs.
4. Future: OS sandbox for process-class; streaming lane (v2);
   `train.*` job kinds.

## Finding from the first integration (Press, 2026-08-08)

Press's fact-checker verification calls the model with WebSearch —
which byollm_004 §2 forbids ("no tools, functions, retrieval, or
MCP"), ~96% of that app's calls. The ban is **correct and essential
for `named`/`public`** (tools + untrusted payload + someone else's
machine = breakout/exfiltration). But for **`self` jobs on the
owner's own box, the ban is overbroad** — it's identical to the user
running the tool-enabled CLI themselves, which they already do; no
new risk surface exists.

Two consequences:

1. **Billing-lane principle (adopt in the framework doc):** whether
   an app needs tools/web is what sorts it into a lane. Tool-free →
   BYOLLM (user's subscription + box). Needs-web/tools → metered API
   (the app pays). An app doesn't "fail" to be a BYOLLM app; the tool
   requirement just names its lane.
2. **Future byollm capability (not v1):** a `self`-only,
   explicitly-owner-opted, **per-kind declared toolset** — a job kind
   may request a named set of tools, runnable only when audience is
   `self` AND the daemon owner enabled that toolset for that kind.
   `named`/`public` stay tool-free forever. This would let a
   fact-checker-style app run on the daemon without a metered key,
   without weakening the community-compute guarantee. Needs its own
   threat review before it ships.
