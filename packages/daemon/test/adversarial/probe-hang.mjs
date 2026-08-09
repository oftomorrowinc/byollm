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
  /* keep the event loop alive */
}, 1_000);
