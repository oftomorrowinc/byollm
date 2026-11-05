import { ClientError, type ProtocolClient } from "./client.js";
import type { ToolTransport } from "./tool-loop.js";

/**
 * The tool loop's way to the site, over this daemon's protocol client, for
 * one lease — byollm_012 §5.2.
 *
 * Its own module, not inline in the runner, so the relay's suite can drive
 * the shipped loop through the shipped transport against the real relay
 * plane (#7440). The tool loop itself stays free of the client: it names no
 * network API, and `tool-loop-reaches-nothing.test.ts` holds it to that.
 *
 * One refusal is translated rather than thrown: the upstream saying the
 * job's tool calls are spent (`tools-spent`, byollm_012 §8). The loop reads
 * that as a tool error and goes to the closing turn. Every other failure is
 * thrown, and the loop treats it as a call that was not sent.
 */
export function clientToolTransport(
  client: ProtocolClient,
  holder: {
    readonly runnerId: string;
    readonly jobId: string;
    readonly leaseId: string;
  },
): ToolTransport {
  const lease = { jobId: holder.jobId, leaseId: holder.leaseId };
  return {
    send: async ({ callId, envelope }) => {
      try {
        await client.toolCall({
          runnerId: holder.runnerId,
          ...lease,
          callId,
          envelope,
        });
        return "sent";
      } catch (error) {
        if (error instanceof ClientError && error.kind === "tools-spent") {
          return "tools-spent";
        }
        throw error;
      }
    },
    poll: async (callId) =>
      (
        await client.toolResults({
          runnerId: holder.runnerId,
          calls: [{ ...lease, callId }],
        })
      ).results,
  };
}
