---
"@byollm/server": patch
---

A cloud-lane job whose first device dies after being sealed to is now sealed
again to the device that claims it next. `MemoryStore.adopt` kept the dead
device's adopted lease and refused the relay's new one, so `pump()` reported
the job in `refused` on every cycle until its deadline. The second device,
never sealed to, lost its grant when the relay's ten-second wait for the seal
ran out, and logged "unknown job". An adopted lease is now replaced by the
next one the relay grants, and the dead device's lease can no longer complete
the job. A lease the site granted itself on the direct lane is still refused.
The Supabase adapter already replaced adopted leases. (#9585)
