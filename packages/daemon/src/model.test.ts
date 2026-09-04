import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backendVerifier, listModels, setModel, showModel } from "./model.js";
import { knownModelsFor } from "./known-models.js";
import { removeTemp } from "./test-support.js";

/**
 * Choosing a model — byollm_017 Phase 1.
 *
 * The spec's own test list leads with the one that matters: `byollm model
 * claude not-a-model` refuses with the CLI's own line and the config is
 * byte-identical afterwards. That is ruling 2 — found is not works — and it
 * is what makes ruling 3's free text safe. A frozen list would be the other
 * way of being safe, and it breaks on the morning a model ships.
 */

let home: string;
let config: string;
let out: string;
let err: string;

const io = {
  out: (text: string) => {
    out += text;
  },
  err: (text: string) => {
    err += text;
  },
};

const CONFIG = {
  services: {
    claude: { type: "claude-cli", model: "sonnet", kinds: ["llm.generate"] },
    ollama: { type: "ollama", model: "llama3.2", kinds: ["llm.generate"] },
  },
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "byollm-model-"));
  config = join(home, "config.json");
  await writeFile(config, `${JSON.stringify(CONFIG, null, 2)}\n`);
  out = "";
  err = "";
});

afterEach(async () => {
  await removeTemp(home);
});

describe("setting a model", () => {
  const refuses = (detail: string) => () =>
    Promise.resolve({ answers: false, detail });
  const accepts = () => Promise.resolve({ answers: true as const });

  it("refuses with the CLI's own line, and changes nothing", async () => {
    const before = await readFile(config, "utf8");

    const result = await setModel(
      { configPath: config, service: "claude", model: "not-a-model" },
      io,
      refuses("Model not found: not-a-model"),
    );

    expect(result.changed).toBe(false);
    expect(result.code).toBe(1);
    expect(err).toContain("Model not found: not-a-model");
    // Byte-identical, not "restored": nothing is written until the probe
    // answers, so there is no window in which the file is wrong.
    expect(await readFile(config, "utf8")).toBe(before);
  });

  it("says what it is still on, so the refusal is not a dead end", async () => {
    await setModel(
      { configPath: config, service: "claude", model: "opus-9" },
      io,
      refuses("not available on your plan"),
    );
    expect(err).toContain("still on sonnet");
  });

  it("writes a model that answered", async () => {
    const result = await setModel(
      { configPath: config, service: "claude", model: "opus" },
      io,
      accepts,
    );
    expect(result.changed).toBe(true);
    const written = JSON.parse(await readFile(config, "utf8")) as typeof CONFIG;
    expect(written.services.claude.model).toBe("opus");
    // The other service is untouched — one model per service (ruling 5).
    expect(written.services.ollama.model).toBe("llama3.2");
  });

  it("says when the change needs a restart, because it does", async () => {
    // The runner reads config once, at construction. A command that wrote the
    // file and said "done" would leave somebody watching a device answer with
    // the old model and no reason given.
    await setModel(
      { configPath: config, service: "claude", model: "opus" },
      io,
      accepts,
    );
    expect(out).toContain("Restart the daemon");
  });

  it("does not probe a model it is already on", async () => {
    let probed = 0;
    const result = await setModel(
      { configPath: config, service: "claude", model: "sonnet" },
      io,
      () => {
        probed += 1;
        return Promise.resolve({ answers: true as const });
      },
    );
    expect(probed).toBe(0);
    expect(result.changed).toBe(false);
    expect(result.code).toBe(0);
  });

  it("stores a model it had no way to check, rather than refusing it", async () => {
    /**
     * `undefined` is not `false`, one more time.
     *
     * A backend with no canary cannot be asked. Reading "not asked" as "does
     * not work" would make this command impossible for every local model
     * server — the same third state `setup` had to defend, in the command
     * that would most plausibly get it wrong.
     */
    const result = await setModel(
      { configPath: config, service: "ollama", model: "qwen3" },
      io,
      () => Promise.resolve({ answers: undefined }),
    );
    expect(result.changed).toBe(true);
    expect(out).toContain("no way to check");
  });

  it("refuses a service this device does not have", async () => {
    const result = await setModel(
      { configPath: config, service: "nope", model: "x" },
      io,
      accepts,
    );
    expect(result.code).toBe(1);
    expect(err).toContain("byollm services");
  });
});

describe("reading models back", () => {
  it("lists every service with what it runs", async () => {
    await listModels(config, io);
    expect(out).toContain("claude");
    expect(out).toContain("sonnet");
    expect(out).toContain("ollama");
  });

  it("offers suggestions as suggestions, not as a menu", async () => {
    // Ruling 3: free text is the promise. Copy that read as a closed list
    // would make somebody believe a model released this morning is
    // unavailable, which is the exact failure the ruling exists to prevent.
    await showModel(config, "claude", io);
    expect(out).toContain("Known to this build");
    expect(out).toContain("Any name its CLI accepts works");
  });

  it("says nothing about suggestions for a backend that has none", async () => {
    // A local server serves whatever has been pulled onto that machine. An
    // empty list rendered as a heading would read as "no models available".
    await showModel(config, "ollama", io);
    expect(out).not.toContain("Known to this build");
  });
});

describe("when there is nothing to read", () => {
  it("points at setup rather than at an empty list", async () => {
    // A config with no services is what a pre-alpha.44 install left behind,
    // and "no services" as a bare fact is a dead end. The remedy is the
    // command that finds what the computer already has.
    await writeFile(config, JSON.stringify({ services: {} }));
    const result = await listModels(config, io);
    expect(result.code).toBe(1);
    expect(err).toContain("byollm setup");
  });

  it("names the service it could not find, and how to see the real ones", async () => {
    const result = await showModel(config, "clawed", io);
    expect(result.code).toBe(1);
    expect(err).toContain('"clawed"');
    expect(err).toContain("byollm services");
  });

  it("does not invent a config to write into", async () => {
    // Writing one here would produce a device configured by a typo — a
    // service somebody named wrong, with a model, and nothing else.
    const result = await setModel(
      { configPath: join(home, "absent.json"), service: "claude", model: "x" },
      io,
      () => Promise.resolve({ answers: true as const }),
    );
    expect(result.code).toBe(1);
    expect(err).toContain("byollm setup");
  });
});

describe("a config somebody edited by hand", () => {
  it("says a service has no model rather than printing nothing", async () => {
    // `model` is required by the schema the daemon loads, so a config without
    // it is one somebody wrote themselves. Printing an empty column would
    // read as a model called "" — this says which field is missing.
    await writeFile(
      config,
      JSON.stringify({ services: { claude: { type: "claude-cli" } } }),
    );
    await listModels(config, io);
    expect(out).toContain("(no model set)");
    await showModel(config, "claude", io);
    expect(out).toContain("(no model set)");
  });

  it("still refuses on a probe, naming no previous model it cannot name", async () => {
    await writeFile(
      config,
      JSON.stringify({ services: { claude: { type: "claude-cli" } } }),
    );
    const result = await setModel(
      { configPath: config, service: "claude", model: "nope" },
      io,
      () => Promise.resolve({ answers: false, detail: "Model not found" }),
    );
    expect(result.code).toBe(1);
    expect(err).toContain("still on its previous model");
  });

  it("treats a service with no type as one with nothing to suggest", async () => {
    // `knownModelsFor` is keyed by backend id. An entry without one is not a
    // crash and not a claim that no models exist — there is simply nothing
    // this build can say about it.
    await writeFile(
      config,
      JSON.stringify({ services: { mystery: { model: "x" } } }),
    );
    await showModel(config, "mystery", io);
    expect(out).toContain("mystery: x");
    expect(out).not.toContain("Known to this build");
  });
});

describe("what a build knows", () => {
  it("suggests aliases first, then the dated ids", () => {
    // Aliases are what people type and what survives a refresh; dated ids are
    // what somebody pins when they need this month's behaviour to hold still.
    const known = knownModelsFor("claude-cli");
    expect(known[0]).toBe("opus");
    expect(known.some((name) => name.startsWith("claude-"))).toBe(true);
  });

  it("has nothing to suggest for a local server", () => {
    expect(knownModelsFor("ollama")).toEqual([]);
  });
});

describe("the probe behind the verb", () => {
  it("asks the backend's cheapest true call", async () => {
    const verify = backendVerifier(() => ({
      canary: (model: string) =>
        Promise.resolve({ healthy: model === "opus", detail: "said so" }),
    }));
    await expect(verify("claude-cli", "opus")).resolves.toMatchObject({
      answers: true,
    });
    await expect(verify("claude-cli", "nope")).resolves.toMatchObject({
      answers: false,
      detail: "said so",
    });
  });

  it("says not-asked for a backend with no way to be asked", async () => {
    // Extracted from the router so this could be asked at all: inline, the
    // only way to reach it was to run a real backend, whose answer depends on
    // whether a model server happens to be up on the machine running tests.
    const verify = backendVerifier(() => ({}));
    await expect(verify("ollama", "anything")).resolves.toEqual({
      answers: undefined,
    });
  });
});
