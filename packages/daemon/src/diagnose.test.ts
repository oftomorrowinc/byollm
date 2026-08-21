import { describe, expect, it } from "vitest";
import { diagnoseRoute } from "./diagnose.js";

/**
 * Saying why a route is down — cloud_002's detection-first ruling.
 *
 * The sentence being replaced was "0 of 2 routes are healthy", which is true
 * and leaves the reader exactly as stuck. Every answer here carries the
 * command that fixes it: a diagnosis with no next step is a more precise way
 * of being stuck.
 */

describe("a local port with nothing on it", () => {
  it("names the tool that usually serves it, and how to start it", async () => {
    const hint = await diagnoseRoute({
      baseUrl: "http://127.0.0.1:11434/v1",
      detail: "could not reach the model server (fetch failed)",
      onPath: () => Promise.resolve(false),
    });
    expect(hint).toMatch(/Nothing is listening on http:\/\/127\.0\.0\.1:11434/);
    expect(hint).toMatch(/Ollama/);
    // The fixing command, whichever branch: installed → start it, absent →
    // install it. Both mention the binary by name.
    expect(hint).toMatch(/ollama/);
  });

  it("says so plainly for a port it has no guess about", async () => {
    const hint = await diagnoseRoute({ baseUrl: "http://127.0.0.1:9999/v1" });
    expect(hint).toMatch(/Nothing is listening/);
    expect(hint).toMatch(/config\.json/);
    // No invented tool name for a port nobody standardised on.
    expect(hint).not.toMatch(/Ollama|vLLM|MLX/);
  });
});

describe("what it declines to guess about", () => {
  it("says nothing about a remote server that is down", async () => {
    // Somebody else's outage. The daemon has no useful advice about
    // infrastructure it cannot see, and inventing some would be noise at the
    // moment a person is already confused.
    expect(
      await diagnoseRoute({ baseUrl: "https://models.example.com/v1" }),
    ).toBeUndefined();
  });

  it("says nothing without a base URL", async () => {
    // A process-class backend has no port to diagnose.
    expect(await diagnoseRoute({ baseUrl: undefined })).toBeUndefined();
    expect(await diagnoseRoute({ baseUrl: "not a url" })).toBeUndefined();
  });
});

describe("something answering, wrongly", () => {
  it("distinguishes a wrong server from an absent one", async () => {
    // The case the port table would otherwise mislabel: something *is*
    // listening, so "start Ollama" would be wrong advice.
    const hint = await diagnoseRoute({
      baseUrl: "http://127.0.0.1:11434/v1",
      detail: "model list returned HTTP 404",
      onPath: () => Promise.resolve(true),
    });
    expect(hint).toMatch(/Something is listening/);
    expect(hint).not.toMatch(/Nothing is listening/);
  });
});

describe("what it says about the tool itself", () => {
  // The probe is injected so these assert the *sentence*, not the machine the
  // suite happens to run on: with Ollama installed, a real `which` would send
  // CI and a developer's laptop down different branches of the same test.

  it("offers the install command when the binary is absent", async () => {
    const hint = await diagnoseRoute({
      baseUrl: "http://127.0.0.1:11434/v1",
      onPath: () => Promise.resolve(false),
    });
    expect(hint).toMatch(/is not\s+on your PATH/);
    expect(hint).toMatch(/brew install ollama/);
  });

  it("offers the start command when it is installed but idle", async () => {
    // The likelier case a week in, and the one where "install it" would be
    // wrong advice that costs somebody ten minutes.
    const hint = await diagnoseRoute({
      baseUrl: "http://127.0.0.1:11434/v1",
      onPath: () => Promise.resolve(true),
    });
    expect(hint).toMatch(/and is installed/);
    expect(hint).toMatch(/ollama serve/);
    expect(hint).not.toMatch(/brew install/);
  });

  it("claims nothing about the binary when it cannot tell", async () => {
    // No shell, a timeout, a locked-down box. Saying "not installed" here
    // would be a confident lie, so it says the true smaller thing.
    const hint = await diagnoseRoute({
      baseUrl: "http://127.0.0.1:11434/v1",
      onPath: () => Promise.resolve(undefined),
    });
    expect(hint).toMatch(/usually serves/);
    expect(hint).not.toMatch(/is installed/);
    expect(hint).not.toMatch(/not\s+on your PATH/);
  });
});
