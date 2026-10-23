---
"@byollm/protocol": patch
---

`HUB_FENCE_CLAUSES`' "and time" clause claims `first_at` and `last_at`, the two
times on the hub's pair row (`usage_served_by`, #4131), so the hub can import
the mapping as-is. They fit the clause, so this is a release under #4058, not a
ruling; `HUB_FENCE` itself is unchanged.
