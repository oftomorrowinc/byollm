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
    audience: "self",
    owner: "user_from_your_session",
    payload: { prompt: `Summarize this transcript:\n\n${transcript}` },
  });

  const { outcome } = await job.result({
    timeoutMs: 120_000,
    // A whole result, not just the text. This substitutes for the record the
    // daemon would have produced, so it carries the same shape — which the
    // README got wrong until this file was compiled against it. That is the
    // second documentation defect this example has caught, and it had been
    // there since the fallback was written.
    onNoRunner: () => ({
      jobId: job.id,
      state: "ok" as const,
      outcome: { outcome: "ok" as const, text: "Nobody was online." },
    }),
  });

  return typeof outcome === "string" ? outcome : JSON.stringify(outcome);
}
