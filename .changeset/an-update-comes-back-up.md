---
"byollm": patch
---

An automatic update no longer leaves a Mac with no service and no daemon
running (#9572). The updater re-registered by running `byollm start` from
inside the daemon, and on macOS `start` first removes the launchd job — the
job that daemon was. launchd stopped it and, with it, the `start` that was
about to add the job back. Now `byollm start` notices when the daemon it is
about to replace is the one that ran it, and hands the re-registration to a
copy of itself that waits for that daemon to exit. Because a device runs the
`start` it just installed, this also brings a 0.1.4 or 0.1.5 device back up
when it takes this release. On Windows the same hand-off is what starts the
new version at all: re-running a task that is still running starts nothing.
The updater now re-registers only after the new version has answered with
the right number, and never after a failed install or a rollback.

If an automatic update to 0.1.5 left a Mac on `NOT RUNNING` with
`service: not installed`, run `byollm start` once.
