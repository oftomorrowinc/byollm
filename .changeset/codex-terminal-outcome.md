---
"byollm": patch
---

Decide Codex CLI outcomes from its terminal JSON event instead of its process
exit status. Codex can report `error` / `turn.failed` while exiting zero; those
runs are now failures rather than successful answers containing provider error
text. Subscription exhaustion and sign-in failures are classified without
exposing either detail to the site.
