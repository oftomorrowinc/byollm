---
"byollm": patch
---

`byollm status` names the fix when byollm could start a stopped service. A
service at Ollama's address typed `openai-http` read only "start it yourself",
which looked like on-demand start had broken. byollm only starts a service whose
type names the server. When Ollama is installed, that line now adds: set
`"type": "ollama"` on it and byollm will start it for you. That is the same
offer `byollm diagnose` already made.
