---
"byollm": patch
---

`FORCE_COLOR=0` now disables the pairing-code highlight instead of forcing it
on. A signed-out service stays visible in `byollm status` across heartbeats
rather than appearing once and vanishing, keeps its sign-in remedy, and a
state write that fails is retried on the next pass.
