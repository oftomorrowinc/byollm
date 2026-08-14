import { describe, expect, it } from "vitest";
import { JobStub, SizeClass, sizeClassOf } from "./job.js";

const stub = {
  id: "job_1",
  kind: "llm.generate" as const,
  owner: "alice",
  audience: "self" as const,
  sizeClass: "small" as const,
  streaming: false,
  deadlineAt: 1_800_000_000_000,
};

/**
 * byollm_009 §6 states the upstream-visible metadata surface exhaustively —
 * as a commitment, not as a description of what the code happens to send.
 * These are the tests that make it a commitment.
 */

describe("the stub is exhaustive", () => {
  it("accepts exactly the enumerated fields", () => {
    expect(JobStub.safeParse(stub).success).toBe(true);
  });

  it.each([
    ["a payload", { payload: { prompt: "secret" } }],
    ["a prompt", { prompt: "secret" }],
    ["a model", { model: "claude-opus-5" }],
    ["a result", { outcome: { outcome: "ok", text: "answer" } }],
    ["a base URL", { baseUrl: "http://evil.test/v1" }],
    ["anything else at all", { note: "harmless-looking" }],
  ])("refuses a stub carrying %s", (_label, extra) => {
    // A chatty site stuffing metadata into stubs is the leak C022 closed one
    // envelope down, and this is the same rule one level up: an endpoint must
    // not emit more, and an upstream must reject more.
    expect(JobStub.safeParse({ ...stub, ...extra }).success).toBe(false);
  });

  it("carries no field naming what the job says or how it runs", () => {
    // Read positively rather than by exclusion, so a field added later has to
    // pass this assertion on purpose.
    expect(Object.keys(JobStub.shape).sort()).toEqual([
      "audience",
      "audienceAllow",
      "deadlineAt",
      "id",
      "kind",
      "owner",
      "sizeClass",
      "streaming",
    ]);
  });
});

describe("size class", () => {
  it("buckets rather than measuring", () => {
    // An exact byte count is a stronger fingerprint than routing needs.
    expect(sizeClassOf(10)).toBe("small");
    expect(sizeClassOf(4_000)).toBe("small");
    expect(sizeClassOf(4_001)).toBe("medium");
    expect(sizeClassOf(64_000)).toBe("medium");
    expect(sizeClassOf(64_001)).toBe("large");
  });

  it("reserves `unbounded` for streaming, before streaming exists", () => {
    // byollm_009 §8.1: adding a value to a published envelope later is the v2
    // break all over again. Reserved now, unused until byollm_006 lands.
    expect(SizeClass.options).toContain("unbounded");
    expect(JobStub.safeParse({ ...stub, sizeClass: "unbounded" }).success).toBe(
      true,
    );
  });

  it("never returns `unbounded` from measurement", () => {
    // It is a declaration a streamed job makes, not something a length can
    // produce — a bucket function returning it would mean a finite payload
    // had claimed to be a stream.
    for (const chars of [0, 1, 4_001, 64_001, 10_000_000]) {
      expect(sizeClassOf(chars)).not.toBe("unbounded");
    }
  });
});
