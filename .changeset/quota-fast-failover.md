---
"byollm": patch
---

A quota-blocked service is its own failure now, not a generic backend error.
It stops being advertised after one job, tells its owner when it expects to be
back, and re-advertises itself on that clock without anybody doing anything.
The corpus that recognises a block admits only strings a CLI was actually seen
to print.
