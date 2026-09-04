---
"byollm": patch
---

A claimed job the upstream has never heard of is handed back instead of
silently abandoned. It was left holding the lease, so the hub re-offered it
and the same daemon re-claimed the same id every twenty seconds forever —
the device looked wedged while fresh jobs still ran fine.
