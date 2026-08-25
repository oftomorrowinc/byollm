import { BACKENDS, BACKEND_IDS } from "@byollm/protocol";
import { describe, expect, it } from "vitest";
import { createBackend } from "../../src/backends/index.js";
import { HTTP_CORPUS, PROCESS_CORPUS, corpusFor } from "./corpus.js";

/**
 * byollm_004's "Done when": *a third-party backend cannot be added without
 * adding its adversarial rows (enforced by a coverage check that every
 * registered backend has a corresponding hostile-payload suite).*
 *
 * This is that check. It is what turns the corpus from a set of tests
 * somebody remembered to write into a gate a new backend has to pass through.
 */
describe("adversarial coverage [byollm_004 §5]", () => {
  it("has a corpus for every registered backend", () => {
    for (const id of BACKEND_IDS) {
      const descriptor = BACKENDS[id];
      const corpus = corpusFor(descriptor.adversarialCorpus);
      expect(
        corpus.length,
        `backend "${id}" declares the ${descriptor.adversarialCorpus} corpus, which is empty`,
      ).toBeGreaterThan(0);
    }
  });

  it("constructs every backend the protocol registers, as its declared class", () => {
    // cloud_008 Tier 3, finding 15. This compared `IMPLEMENTED_BACKEND_IDS`
    // to `BACKEND_IDS` — and the constant was *defined* as `BACKEND_IDS`, so
    // the assertion was `x === x`. It could not fail, and it sat under a
    // comment about a registered-but-unimplemented backend failing at runtime
    // rather than at load: the exact failure it did not check.
    //
    // The honest question is whether the daemon can actually build one, and
    // whether what it builds is what the registry promised. A provider whose
    // class says `process` and which comes back speaking HTTP is a config
    // that loads and a job that fails.
    for (const id of BACKEND_IDS) {
      const backend = createBackend(id, {
        baseUrl: "http://127.0.0.1:1/v1",
      });
      expect(backend, id).toBeDefined();
      expect(backend.class, id).toBe(BACKENDS[id].class);
      // And, for process class, that it is the backend that was *asked for*.
      //
      // The class check alone cannot establish that — the same defect as
      // finding 15, one level down. Two process-class backends are
      // indistinguishable by class, so `codex-cli` came back as a
      // `ClaudeCliBackend` and this test passed: right class, wrong argv, and
      // an argv is the whole of what a process backend is.
      //
      // The rule is class-conditional because the two classes genuinely
      // differ, and the first draft of this assertion got it wrong by
      // demanding identity everywhere. HTTP *providers* share one transport
      // on purpose — byollm_007 §3, they all speak the same
      // `/v1/chat/completions`, so `ollama` coming back as `openai-http` is
      // the architecture rather than a substitution. Process backends share
      // nothing: each is a distinct binary with a distinct argv, and
      // silently handing one another's argv over is a job that runs the
      // wrong program.
      if (BACKENDS[id].class === "process") {
        expect(backend.id, `${id} constructed as ${backend.id}`).toBe(id);
      }
    }
  });

  it("covers both corpus kinds", () => {
    const declared = new Set(
      BACKEND_IDS.map((id) => BACKENDS[id].adversarialCorpus),
    );
    for (const kind of declared) {
      expect(corpusFor(kind).length).toBeGreaterThan(5);
    }
  });

  it("gives every row a unique, stable id", () => {
    const ids = [...PROCESS_CORPUS, ...HTTP_CORPUS].map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });

  it("explains what every row is trying to do", () => {
    for (const row of [...PROCESS_CORPUS, ...HTTP_CORPUS]) {
      expect(row.threat.length, row.id).toBeGreaterThan(5);
      expect(row.prompt.length, row.id).toBeGreaterThan(0);
    }
  });

  it("covers each threat family byollm_004 §5 names", () => {
    // The spec lists the families by name. Losing one to a refactor should
    // fail here rather than quietly shrink the gate.
    const ids = PROCESS_CORPUS.map((row) => row.id);
    for (const prefix of [
      "SHELL_",
      "ARGV_",
      "PATH_",
      "ENV_",
      "UNICODE_",
      "CONTROL_",
      "INJECT_",
      "SIZE_",
    ]) {
      expect(
        ids.some((id) => id.startsWith(prefix)),
        `no ${prefix}* rows in the process corpus`,
      ).toBe(true);
    }
  });
});
