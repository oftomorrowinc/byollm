#!/usr/bin/env node
/**
 * A child that accepts a prompt and never answers.
 *
 * Stands in for a wedged model so the suite can prove two ceilings byollm_004
 * §2 requires: the wall-clock timeout, and cancellation aborting a call in
 * flight. It ignores SIGTERM, so the escalation to SIGKILL is exercised too —
 * a child that could outlive its budget by being impolite would make the
 * budget a suggestion.
 */
process.on("SIGTERM", () => {
  /* deliberately unresponsive */
});

if (process.argv.includes("--version")) {
  process.stdout.write("probe-hang 0.0.0\n");
  process.exit(0);
}

setInterval(() => {
  // Leave when orphaned, which is the one way this stub outlives its purpose.
  //
  // Ignoring SIGTERM is the point of the file, and it has a cost nobody
  // designed: if the test run dies before it escalates to SIGKILL — Ctrl-C,
  // a crashed worker — the child is reparented to init and then *cannot* be
  // cleaned up by anything polite. Four of these were found on the founder's
  // machine fourteen days after the run that spawned them, each holding a
  // node process, immune to `kill` without `-9`.
  //
  // A parent of 1 means the process that was supposed to kill this is gone,
  // so there is nobody left to be impolite towards. No live test can observe
  // this: the suite's parent outlives every child it spawns.
  if (process.ppid === 1) process.exit(0);
}, 1_000);
