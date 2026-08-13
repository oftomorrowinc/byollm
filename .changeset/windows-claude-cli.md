---
"byollm": patch
---

Make the `claude-cli` backend work on Windows.

npm installs `claude` as `claude.cmd` / `claude.ps1` with no `.exe`, and Node
refuses to spawn a `.cmd` without a shell. `spawn("claude")` therefore failed
with `ENOENT`, the health probe reported the CLI as not installed, and `connect`
refused to pair with no healthy backend — so a Claude-subscription user on
Windows could not use the daemon at all.

`shell: true` would have fixed the symptom and breached
`NO_SHELL_INTERPOLATION`, so instead the shim is resolved to the JavaScript it
would have run and executed under the Node binary already running the daemon.
No shell, and the CLI's own argv is still the frozen literal.

Also widens the child environment allowlist on Windows only, to
`USERPROFILE` / `APPDATA` / `LOCALAPPDATA` / `TEMP` / `TMP` / `SystemRoot` /
`windir` / `PATHEXT`. The CLI reads its subscription credentials from the user
profile, which on Windows is not named by `HOME` — without these the child
starts and then cannot authenticate, which is a worse failure than not
starting. `ANTHROPIC_API_KEY` remains absent on every platform.
