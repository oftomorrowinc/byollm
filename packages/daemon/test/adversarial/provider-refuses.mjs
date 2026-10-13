#!/usr/bin/env node
/**
 * A stand-in for a real CLI that never reaches a model turn, or reaches one
 * and answers without the canary — the two outcomes `live-canary.ts` must
 * tell apart.
 *
 * The mode is the first argument, never the environment: the live rows spawn
 * through `childEnv()`, which strips everything outside the daemon's
 * allowlist, so an env-driven mode here would never fire (the reason
 * `probe-backend.mjs` gives too).
 *
 * The codex refusal is verbatim — codex-cli 0.149.1, on the account Todd and
 * the runner share, 2026-10-13. Not paraphrased: a fixture in our own words
 * would prove only that the classifier agrees with us.
 */
const LIMIT =
  "You've hit your usage limit. Upgrade to Plus to continue using Codex " +
  "(https://chatgpt.com/explore/plus), or try again at Oct 28th, 2026 6:09 PM.";

const lines = (...events) =>
  process.stdout.write(events.map((e) => JSON.stringify(e)).join("\n") + "\n");

const answer = (text) =>
  lines(
    { type: "thread.started", thread_id: "fake" },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", text } },
    { type: "turn.completed" },
  );

const [mode, canary = ""] = process.argv.slice(2);

switch (mode) {
  case "codex-usage-limit":
    process.stdout.write("Reading prompt from stdin...\n");
    lines(
      { type: "thread.started", thread_id: "fake" },
      { type: "turn.started" },
      { type: "error", message: LIMIT },
      { type: "turn.failed", error: { message: LIMIT } },
    );
    process.exit(1);
    break;
  case "codex-answers":
    answer("CANNOT");
    break;
  case "codex-answers-about-limits":
    // A model *talking about* a usage limit is an answer, not a refusal.
    answer("I have hit no usage limit; I simply cannot read files. CANNOT");
    break;
  case "codex-leaks":
    answer(canary);
    break;
  case "claude-not-logged-in":
    // claude's own words, as `process-backend.ts` records them.
    process.stdout.write("Not logged in · Please run /login\n");
    process.exit(1);
    break;
  case "claude-answers":
    process.stdout.write("CANNOT — and I am not logged in to anything.\n");
    break;
  default:
    process.stderr.write(`provider-refuses: unknown mode ${String(mode)}\n`);
    process.exit(2);
}
