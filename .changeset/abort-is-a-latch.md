---
"byollm": patch
---

The daemon answers a stop when it arrives. An `AbortSignal` that had already
fired left the polling loop waiting out a full heartbeat — ten seconds, long
enough for launchd to escalate a polite stop to a kill — and left a loop
started during an abort with nothing that could ever stop it.
