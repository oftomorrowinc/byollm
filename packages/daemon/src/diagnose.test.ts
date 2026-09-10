import { describe, expect, it } from "vitest";
import { diagnoseRoute } from "./diagnose.js";
import type { BackendId } from "@byollm/protocol";

/**
 * Saying why a route is down — cloud_002's detection-first ruling.
 *
 * The sentence being replaced was "0 of 2 routes are healthy", which is true
 * and leaves the reader exactly as stuck. Every answer here carries the
 * command that fixes it: a diagnosis with no next step is a more precise way
 * of being stuck.
 */

/** Nothing on the port, which is what most of this file is about. */
const silent = () => Promise.resolve("silent" as const);

describe("a local port with nothing on it", () => {
  it("names the tool that usually serves it, and how to start it", async () => {
    const hint = await diagnoseRoute({
      baseUrl: "http://127.0.0.1:11434/v1",
      reach: silent,
      onPath: () => Promise.resolve(false),
    });
    expect(hint).toMatch(/Nothing is listening on http:\/\/127\.0\.0\.1:11434/);
    expect(hint).toMatch(/Ollama/);
    // The fixing command, whichever branch: installed → start it, absent →
    // install it. Both mention the binary by name.
    expect(hint).toMatch(/ollama/);
  });

  it("says so plainly for a port it has no guess about", async () => {
    const hint = await diagnoseRoute({
      baseUrl: "http://127.0.0.1:9999/v1",
      reach: silent,
    });
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
      reach: () => Promise.resolve("wrong"),
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
      reach: silent,
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
      reach: silent,
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
      reach: silent,
      onPath: () => Promise.resolve(undefined),
    });
    expect(hint).toMatch(/usually serves/);
    expect(hint).not.toMatch(/is installed/);
    expect(hint).not.toMatch(/not\s+on your PATH/);
  });
});

/**
 * The offer, and the field it is about — B098, ruled (c) by Todd 09-10.
 *
 * `startCommandFor` switches on the backend id, so only `type: "ollama"` is
 * ever started — and the config people actually write for Ollama is
 * `openai-http` pointed at `127.0.0.1:11434`, which is what Todd's own machine
 * had and what the old wizard produced. The feature did not reach its own
 * common case and said nothing about it.
 *
 * These are mostly about what is NOT said: the daemon does not start a server
 * for a service that never named one, and it does not stay quiet about being
 * able to.
 */
describe("a stopped server byollm could start, under a type it will not", () => {
  const stopped = (backendId: BackendId, installed = true) =>
    diagnoseRoute({
      baseUrl: "http://127.0.0.1:11434/v1",
      backendId,
      reach: silent,
      onPath: () => Promise.resolve(installed),
    });

  it("names the one field, and says why it will not act on its own", async () => {
    const hint = await stopped("openai-http");
    expect(hint).toMatch(/byollm could start it when a job needs one/);
    expect(hint).toMatch(/its type is "openai-http"/);
    expect(hint).toMatch(/Set "type": "ollama" on this service/);
    /* And still the manual way, for somebody who does not want byollm
       starting anything. The offer is an offer. */
    expect(hint).toMatch(/Or start it yourself: ollama serve/);
  });

  it("does not make the offer when the config already named it", async () => {
    /* The control. Telling an owner to change a field to the value it already
       has is the kind of advice that makes people stop reading advice. */
    const hint = await stopped("ollama");
    expect(hint).not.toMatch(/Set "type"/);
    expect(hint).not.toMatch(/never named a server/);
  });

  it("says what this build actually does when the type is right", async () => {
    /**
     * The stale-advice half, found while reading this function for the row
     * above. It handed somebody `ollama serve` and nothing else, which was
     * the whole truth until 0.1.0-alpha.88 shipped on-demand start — telling
     * an owner to start by hand a server the daemon is about to start for
     * them.
     */
    const hint = await stopped("ollama");
    expect(hint).toMatch(/byollm starts Ollama itself when a job needs it/);
    /* Not over-promised: the memory guard can still refuse, and the screen
       that shows the guard is named rather than described. */
    expect(hint).toMatch(/memory floor/);
    expect(hint).toMatch(/byollm status/);
  });

  it("says nothing about starting anything on a port nothing can start", async () => {
    /* 8080 is MLX or llama.cpp, and `startCommandFor` has no command for
       either. An offer here would be a promise this daemon cannot keep. */
    const hint = await diagnoseRoute({
      baseUrl: "http://127.0.0.1:8080/v1",
      backendId: "openai-http",
      reach: silent,
      onPath: () => Promise.resolve(true),
    });
    expect(hint).toMatch(/MLX or llama.cpp/);
    expect(hint).not.toMatch(/byollm could start/);
    expect(hint).not.toMatch(/byollm starts/);
  });

  it("offers nothing when the binary is not there to start", async () => {
    /* Install first. An offer to start software that is not installed is the
       "install it" advice this function already gives, with a wrong sentence
       stapled on. */
    const hint = await stopped("openai-http", false);
    expect(hint).toMatch(/is not\s+on your PATH/);
    expect(hint).not.toMatch(/byollm could start/);
  });
});

/**
 * A server that IS answering, on a route that is still not usable.
 *
 * This branch was unreachable for the whole life of the function. The premise
 * "is anything listening" came from a `detail` string, **the one caller in the
 * repository never passed it**, so every unhealthy route took the
 * nothing-is-listening path. Found by running B098's new sentence against a
 * live Ollama, where it offered to change a service's `type` so byollm could
 * start a server that was already up.
 */
describe("the port answers and the service still does not work", () => {
  const answering = (backendId: BackendId = "openai-http") =>
    diagnoseRoute({
      baseUrl: "http://127.0.0.1:11434/v1",
      backendId,
      reach: () => Promise.resolve("answered"),
      onPath: () => Promise.resolve(true),
    });

  it("does not say nothing is listening when something is", async () => {
    const hint = await answering();
    expect(hint).not.toMatch(/Nothing is listening/);
    expect(hint).toMatch(/is answering, so the address is right/);
  });

  it("does not offer to change a type so byollm can start what is running", async () => {
    /* The assertion this branch exists for. An offer to start a server that
       is already serving is not merely useless — it sends somebody editing
       config to fix a problem that is somewhere else entirely. */
    const hint = await answering();
    expect(hint).not.toMatch(/Set "type"/);
    expect(hint).not.toMatch(/byollm could start/);
  });

  it("names the likeliest cause and the command that settles it", async () => {
    /* `detectCapabilities` refuses to advertise a model the server's own
       catalogue does not list, so `glm-5.2` against a server serving
       `glm-5.2:cloud` is unhealthy while the server answers perfectly. */
    const hint = await answering();
    expect(hint).toMatch(/will not advertise a model the server/);
    expect(hint).toMatch(/byollm model <service> <name>/);
  });

  it("says the backend's own words too, when it has them", async () => {
    const hint = await diagnoseRoute({
      baseUrl: "http://127.0.0.1:11434/v1",
      detail: "model list returned HTTP 401",
      reach: () => Promise.resolve("answered"),
      onPath: () => Promise.resolve(true),
    });
    expect(hint).toMatch(/HTTP 401/);
  });
});
