import { describe, expect, it } from "vitest";
import { ChatMessage, KindedPayload } from "./kinds.js";
import { Lease } from "./job.js";
import {
  GrantRef,
  HeartbeatRequest,
  PROTOCOL_VERSION,
  PairStartRequest,
} from "./wire.js";

/**
 * Unknown fields throw — everywhere, not almost everywhere.
 *
 * The law was stated once and applied unevenly: most top-level shapes were
 * `.strict()` and six sub-schemas were not. Zod's default for a plain
 * `z.object` is strip-unknown, so an extra field on any of those parsed
 * cleanly and vanished — the "parser that silently accepts malformed input"
 * the law forbids, in the shapes nested one level down where nobody looked.
 *
 * The cost is not theoretical: our own fixtures had been putting an
 * `identity` on `Lease` — a field the schema never declared — and every test
 * that sent one was asserting against a wire that dropped it.
 *
 * One case per shape, because "strict somewhere" is what this file exists to
 * refuse.
 */
describe("every wire shape refuses what it does not know", () => {
  it("refuses an unknown field on a chat message", () => {
    // The case the law was written about: a site SDK user sends `tool_calls`
    // expecting tool use, it is silently discarded, and the job runs meaning
    // something other than what was sent.
    expect(
      ChatMessage.safeParse({
        role: "user",
        content: "hello",
        tool_calls: [{ name: "search" }],
      }).success,
    ).toBe(false);
  });

  it("refuses an unknown field on a payload envelope", () => {
    // The payloads inside were already strict; a union member that strips is
    // a door standing beside the one that is locked.
    expect(
      KindedPayload.safeParse({
        kind: "llm.generate",
        payload: { prompt: "hi" },
        priority: "high",
      }).success,
    ).toBe(false);
  });

  it("refuses an unknown field on a lease", () => {
    expect(
      Lease.safeParse({
        id: "lease_1",
        runnerId: "runner_1",
        expiresAt: 1_800_000_000_000,
        identity: { identity: "i", encryption: "e", encryptionSig: "s" },
      }).success,
    ).toBe(false);
  });

  it("refuses an unknown field on a grant reference", () => {
    expect(
      GrantRef.safeParse({ jobId: "job_1", leaseId: "lease_1", extra: 1 })
        .success,
    ).toBe(false);
  });

  it("refuses an unknown field nested inside a strict parent", () => {
    // A parent's `.strict()` does not reach a nested object, which is exactly
    // how this one was missed: the shape around it threw and it stripped.
    expect(
      PairStartRequest.safeParse({
        protocolVersion: PROTOCOL_VERSION,
        action: "start",
        daemon: {
          version: "1.0.0",
          label: "laptop",
          platform: "darwin",
          arch: "arm64",
        },
      }).success,
    ).toBe(false);
  });

  it("refuses an unknown field on an active lease in a heartbeat", () => {
    const body = HeartbeatRequest.safeParse({
      protocolVersion: PROTOCOL_VERSION,
      runnerId: "runner_1",
      daemonVersion: "1.0.0",
      capabilities: [],
      withheld: [],
      activeLeases: [{ jobId: "job_1", leaseId: "lease_1", renewed: true }],
      paused: false,
    });
    expect(body.success).toBe(false);
  });
});
