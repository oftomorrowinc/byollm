---
"byollm": patch
---

Five fixes to the quota work: the Codex adapter no longer drops the clock it
parsed, `byollm status` can say a service is blocked and until when, and
`retryable` is a property of the site-facing class rather than of the
individual failure — one path inside `service_unavailable` was reporting a
value only quota produced. The revoked remedy gains a restart step on the one
branch where nothing returns by itself.
