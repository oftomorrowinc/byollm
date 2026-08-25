import { describe, expect, it } from "vitest";
import { JobStub, SizeClass, sizeClassOf } from "./job.js";

const stub = {
  id: "job_1",
  kind: "llm.generate" as const,
  owner: "alice",
  site: "BYOLLM-TEST-SITE-KEY-ID",
  audience: "private" as const,
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
    // Membership, which is the rule this list now carries: a class the
    // router acts on may travel, a list of people never does (cloud_008
    // §0.2). It used to be a field here, and `.strict()` is what makes its
    // removal enforcement rather than a decision to keep making.
    ["who may run it", { audienceAllow: ["carol"] }],
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
    //
    // `service` was added on purpose, byollm_016 Phase B, and it is the one
    // field on this list that had to argue for itself. It names a service
    // **key** the owner published — not a model, not a URL, not a flag. The
    // rejection table above is what keeps that distinction real: a site may
    // say "the one you called studio" and may still never say
    // "claude-opus-5". A key means nothing off the owner's machine; a value
    // would mean the same thing everywhere, which is the difference between
    // choosing from a menu and ordering off it.
    expect(Object.keys(JobStub.shape).sort()).toEqual([
      "audience",
      "deadlineAt",
      "id",
      "kind",
      "owner",
      "service",
      "site",
      "sizeClass",
      "streaming",
    ]);
  });

  it("takes a service key and still refuses a service's contents", () => {
    // The amended NO_PAYLOAD_ROUTING, as one assertion. Selection is allowed;
    // supplying what the selection resolves to is not, and adding the first
    // must not have quietly enabled the second.
    expect(JobStub.safeParse({ ...stub, service: "studio" }).success).toBe(
      true,
    );
    for (const value of [
      { service: "studio", model: "claude-opus-5" },
      { service: "studio", baseUrl: "http://evil.test/v1" },
      { service: "studio", type: "openai-http" },
      { service: "studio", apiKeyEnv: "ANTHROPIC_API_KEY" },
    ]) {
      expect(JobStub.safeParse({ ...stub, ...value }).success).toBe(false);
    }
  });

  it("refuses an empty service, because absent and blank are different", () => {
    // Absent means "the owner's default". A blank string is a selection that
    // names nothing, and letting it through would make it mean the same as
    // absent — a second spelling for a decision, which is how two code paths
    // start disagreeing about one.
    expect(JobStub.safeParse({ ...stub, service: "" }).success).toBe(false);
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
