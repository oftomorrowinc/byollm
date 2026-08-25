"use server";

import { getApp } from "@/lib/byollm";

/**
 * The README's step 3, so that it compiles too — byollm_014.
 *
 * Not here to work: nothing in CI runs this, and with no site keys it could
 * not. It is here because "enqueue a job and wait for a result" is the other
 * half of the documented integration, and a build that only compiles the
 * mount proves half a pattern.
 *
 * Note where the credential is needed. `getApp()` is called inside the
 * action, not at module scope, so importing this file during `next build`
 * costs nothing — the same rule as the route, in the place people are most
 * likely to break it, because an action *feels* like ordinary server code.
 */
export async function summarize(transcript: string): Promise<string> {
  const job = await getApp().enqueue({
    kind: "llm.generate",
    audience: "private",
    owner: "user_from_your_session",
    payload: { prompt: `Summarize this transcript:\n\n${transcript}` },
  });

  const { outcome, fallback } = await job.result({
    timeoutMs: 120_000,
    // A string — the sugar. Whatever comes back is labelled `fallback: true`
    // by the wait itself, so an answer that did not run on somebody's machine
    // cannot be reported as though it did.
    onNoRunner: () => "Nobody was online to run this.",
  });

  if (fallback === true) {
    return `[not run on your machine] ${describe(outcome)}`;
  }

  return describe(outcome);
}

function describe(outcome: unknown): string {
  return typeof outcome === "string" ? outcome : JSON.stringify(outcome);
}
