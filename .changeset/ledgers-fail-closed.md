---
"byollm": patch
---

The three ledgers fail closed. A spend ledger, community budget file or
spent-grants record that cannot be read no longer counts as empty: the gates
it protected brake instead of opening, the file is never overwritten while
untrusted, and `byollm status` names it. All three are written temp-sync-rename
so an interrupted write can no longer manufacture the state that opened them.
A grant whose burn cannot be made durable is refused rather than run.

Reported by Robertson Price (vibewrk), whose regression matrix this was built
from.
