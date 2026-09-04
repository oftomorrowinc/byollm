#!/usr/bin/env node
/**
 * A stand-in for the `claude` binary that reports exactly what it received.
 *
 * The adversarial suite runs this instead of the real CLI so it can assert the
 * things byollm_004 §2 actually promises — argv, environment, cwd, and stdin —
 * rather than trusting that the code that builds them is correct. Proving the
 * contract requires observing the syscall boundary, and this is that observer.
 *
 * Note that this probe takes **no** configuration from its environment: the
 * daemon strips everything outside its allowlist, so an env-driven mode here
 * would simply never fire. Behaviours that need a different child (hanging,
 * flooding) are separate binaries for exactly that reason — which is itself a
 * small demonstration that the allowlist works.
 *
 * Output is a single JSON object on stdout for a prose backend. When the argv
 * asks for Codex JSONL, the same report is the agent message in a completed
 * event stream — so the adapter's real parser is exercised without changing
 * what this syscall-boundary probe observes.
 */
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);

if (argv.includes("--version")) {
  process.stdout.write("probe 0.0.0\n");
  process.exit(0);
}

/** Whatever arrived on stdin — which is where the prompt must be. */
let stdin;
try {
  stdin = readFileSync(0, "utf8");
} catch {
  // No stdin at all is itself a result worth reporting verbatim.
  stdin = "";
}

const report = JSON.stringify({
  argv,
  env: process.env,
  cwd: process.cwd(),
  stdin,
});
if (argv.includes("--json")) {
  process.stdout.write(
    `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: report } })}\n` +
      `${JSON.stringify({ type: "turn.completed" })}\n`,
  );
} else {
  process.stdout.write(report);
}
