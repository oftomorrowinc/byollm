---
"byollm": patch
---

Give the codex canary room for the envelope its answer now arrives in. Under
`--json` the CLI spends about 340 bytes to say "ok"; the canary's budget was
256, and an overrun is a killed child read as "cannot answer". Signed-in codex
devices would have reported themselves unusable.
