import { describe, expect, it } from "vitest";
import {
  canTransition,
  ClaimedJob,
  isTerminal,
  JobState,
  provenanceFor,
  TERMINAL_STATES,
} from "./job.js";

const base = {
  runnerId: "runner-1",
  runnerOwner: "bob",
  backendClass: "http" as const,
  model: "gemma4:26b",
};

describe("job lifecycle", () => {
  it("marks exactly the four terminal states terminal", () => {
    for (const state of JobState.options) {
      expect(isTerminal(state)).toBe(
        (TERMINAL_STATES as readonly string[]).includes(state),
      );
    }
  });

  it("allows a lease-expired job back to queued so nothing is lost", () => {
    expect(canTransition("claimed", "queued")).toBe(true);
    expect(canTransition("running", "queued")).toBe(true);
  });

  it("never leaves a terminal state", () => {
    for (const state of TERMINAL_STATES) {
      for (const to of JobState.options) {
        expect(canTransition(state, to), `${state} → ${to}`).toBe(false);
      }
    }
  });

  it("refuses to skip straight from queued to ok", () => {
    expect(canTransition("queued", "ok")).toBe(false);
  });
});

describe("result provenance", () => {
  it("marks a self job trusted", () => {
    expect(provenanceFor({ ...base, audience: "private" }).untrusted).toBe(
      false,
    );
  });

  it("marks a team result untrusted — it is attacker-controlled", () => {
    // byollm_003 Rev 1: a volunteer's machine can return anything, and the app
    // would otherwise render it as its own AI's output.
    expect(provenanceFor({ ...base, audience: "team" }).untrusted).toBe(true);
  });

  it("derives untrusted rather than accepting it from a caller", () => {
    const provenance = provenanceFor({ ...base, audience: "team" });
    // No input shape can set `untrusted: false` for somebody else's machine.
    expect(provenance).toMatchObject({ audience: "team", untrusted: true });
  });
});

describe("ClaimedJob wire shape", () => {
  const valid = {
    id: "job-1",
    kind: "llm.generate" as const,
    payload: { prompt: "hi" },
    audience: "private" as const,
    owner: "alice",
    lease: {
      id: "lease_test",
      runnerId: "runner-1",
      expiresAt: Date.now() + 30_000,
    },
  };

  it("accepts a well-formed job", () => {
    expect(ClaimedJob.safeParse(valid).success).toBe(true);
  });

  it.each(["model", "backendId", "baseUrl", "command", "argv", "path"])(
    "has no field for %s — routing cannot ride the wire",
    (field) => {
      expect(
        ClaimedJob.safeParse({ ...valid, [field]: "anything" }).success,
      ).toBe(false);
    },
  );
});
