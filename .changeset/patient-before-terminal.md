---
"byollm": patch
---

A job whose payload does not arrive is retried before it is given up on. The
previous release refused it on the first failure, which turned a site that
merely sealed slowly into a job that never ran at all.
