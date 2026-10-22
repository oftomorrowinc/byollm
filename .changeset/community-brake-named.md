---
"byollm": patch
---

`byollm status` names the community brake that refused work in the last hour
— "refused 21 in the last hour: hourly cap (20) — raise it: byollm budget
community --per-hour N" — and the new `byollm budget community [--per-hour N]
[--per-day N] [--count-team-jobs yes|no]` sets those caps without editing
JSON, then tells the supervisor or prints `byollm stop && byollm start`.
`byollm offer` now ends with the same line, since the running daemon does not
see a config change until then.

A teammate's job on a metered service you shared with your team no longer
counts toward the hourly and daily job caps by default: that service's daily
spend ceiling already bounds it. Payload, wall-clock and output limits still
apply, and work on free services is always counted. `--count-team-jobs yes`
counts it again.
