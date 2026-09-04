---
"byollm": patch
---

`retryable` becomes a property of the site-facing class and is `true` for
`service_unavailable`, restoring the transient-retry behaviour a previous
flatten broke; the dead per-adapter field is removed so it cannot drift back.
Every service state change now writes — the lift as well as the block, and
sign-out as well as quota — so `byollm status` stops reporting a fault that
has cleared. The quota corpus may be empty, and the suite now agrees.
