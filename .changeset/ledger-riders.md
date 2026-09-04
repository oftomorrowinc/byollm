---
"byollm": patch
---

Concurrent writes to a ledger no longer lose entries — twenty-five records
left twenty-one on disk, because two writes could finish out of order and the
earlier snapshot won. The spend ledger's wrong-schema arm now brakes like its
other two, and `byollm status` stops telling somebody their own work is
unaffected on the one brake that stops it.
