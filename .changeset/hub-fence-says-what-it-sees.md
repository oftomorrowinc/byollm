---
"@byollm/protocol": patch
---

`HUB_FENCE` is the sentence Todd ruled on 2026-10-22 (#4058): "byollm.cloud
sees who asked, which devices and sites are connected, which device did each
job, and each job's kind, size, outcome and time. Never prompts, never answers,
never credentials." The "only what routing and metering need" opening is gone;
the fence is the column mapping, not a justification. `HUB_FENCE_CLAUSES`
gains a "who asked" clause (`owner_id`, `member_id`) and claims
`served_by_owner_id`, the hub's per-pair device owner, under "which devices and
sites are connected, which device did each job". Consumers that pin the
sentence (`byollm-cloud`, `byollm-cloud-web`) change their literals when they
move to this version.
