import { describe, expect, it } from "vitest";
import { DEFAULT_FLOOR_BYTES } from "./memory-gate.js";
import { modelLoadQuestion } from "./model-memory.js";

/**
 * The guard on the owner's own command — B106.
 *
 * `guardApplies` and `memoryGate` appeared in `runner.ts` and nowhere else,
 * so all of B080/B090 protected the job path only — while `byollm model <svc>
 * <name>` was a documented, guard-free model load. The canary it runs is "the
 * cheapest true call the backend has", and for a local server a true call
 * loads the model. H2, from a line in the help text.
 */
const GB = 1024 ** 3;
const reading = (availableGb: number) => ({
  kind: "read" as const,
  availableBytes: availableGb * GB,
  totalBytes: 36 * GB,
});

const ask = (over: Partial<Parameters<typeof modelLoadQuestion>[0]> = {}) =>
  modelLoadQuestion({
    backendId: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "gemma4:26b",
    memory: reading(12),
    pressure: "normal",
    floorBytes: DEFAULT_FLOOR_BYTES,
    ...over,
  });

describe("loading a model from the owner's own command", () => {
  it("asks below the floor, and says what is about to happen", () => {
    const verdict = ask({ memory: reading(0.4) });
    expect(verdict.ask).toBe(true);
    if (verdict.ask) {
      /* What is being loaded, what is left, and the question. Somebody
         answering has to be able to answer it. */
      expect(verdict.question).toContain("gemma4:26b");
      expect(verdict.question).toContain("0.4 GB available");
      expect(verdict.question).toContain("Load it anyway?");
    }
  });

  it("says nothing above the floor", () => {
    /**
     * A decision, not an omission. A guard that narrates on the happy path
     * teaches people to skip reading it, and then it is furniture on the day
     * it matters — which is the day this exists for.
     */
    expect(ask({ memory: reading(12) }).ask).toBe(false);
  });

  it("asks rather than refuses, which is the ruling", () => {
    /* An owner typing the command is consent; a remote job is not. The type
       has no refusal to return — the only outcomes are ask and do not ask,
       so a later edit cannot quietly turn this into a wall. */
    const verdict = ask({ memory: reading(0.1) });
    expect(Object.keys(verdict)).toContain("ask");
    expect(verdict).not.toHaveProperty("refuse");
  });

  it("says nothing about a model that does not load here", () => {
    /* A proxy holds no model on this machine, so asking would be a prompt
       about somebody else's hardware — and at 0.1 GB, which is the point:
       the memory is dire and it still must not ask. */
    expect(
      ask({
        backendId: "anthropic",
        baseUrl: undefined,
        model: "claude-opus-4",
        memory: reading(0.1),
      }).ask,
    ).toBe(false);
    /* And the cloud-tagged case B097 settled: local address, hosted model. */
    expect(ask({ model: "glm-5.2:cloud", memory: reading(0.1) }).ask).toBe(
      false,
    );
  });

  it("asks at critical pressure even with room on the disk of free memory", () => {
    /* The other half of the gate's rule, reached through the same function
       rather than restated: the kernel is already killing things. */
    expect(ask({ memory: reading(12), pressure: "critical" }).ask).toBe(true);
  });

  it("uses the owner's floor, not the one we shipped", () => {
    /* Same field, same meaning, whoever asked — `minAvailableMemoryBytes`.
       8 GB is comfortably above the 2 GB default and below a raised floor. */
    expect(ask({ memory: reading(8), floorBytes: 16 * GB }).ask).toBe(true);
    expect(
      ask({ memory: reading(8), floorBytes: DEFAULT_FLOOR_BYTES }).ask,
    ).toBe(false);
  });
});
