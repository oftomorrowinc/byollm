import { describe, expect, it } from "vitest";
import {
  pasteableService,
  unusedModels,
  unusedModelsReport,
} from "./unused-models.js";

/**
 * The models on this machine that nothing points at — B100b.
 *
 * Todd pulled `smollm2:135m`, `ollama list` showed five models, and `byollm
 * services` showed the two his config names. The reader existed the whole
 * time — `probeLocalServers` is called once, by `setup`, and never again.
 */
const OLLAMA = {
  label: "Ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  models: ["llama3.2", "smollm2:135m", "gemma4:26b"],
};
const MLX = {
  label: "MLX",
  baseUrl: "http://127.0.0.1:6999/v1",
  models: ["qwen-2.5-14b"],
};

describe("models nothing is using", () => {
  it("names the ones no service points at, and not the ones that are used", () => {
    const spare = unusedModels({
      servers: [OLLAMA, MLX],
      configured: [
        { baseUrl: "http://127.0.0.1:11434/v1", model: "llama3.2" },
        { baseUrl: "http://127.0.0.1:6999/v1", model: "qwen-2.5-14b" },
      ],
    });
    /* MLX has nothing spare, so it does not appear at all — an empty heading
       is a section that says "look here" about nothing. */
    expect(spare.map((server) => server.label)).toEqual(["Ollama"]);
    expect(spare[0]?.models).toEqual(["smollm2:135m", "gemma4:26b"]);
  });

  it("matches the ADDRESS and the model, not the model alone", () => {
    /**
     * The same id can sit behind two servers — `qwen-2.5-14b` on MLX and on
     * Ollama — and a service pointing at one says nothing about the other.
     * Keying on the name would hide a genuinely unused model because its
     * namesake elsewhere was in use.
     */
    const spare = unusedModels({
      servers: [{ ...OLLAMA, models: ["qwen-2.5-14b"] }, MLX],
      configured: [
        { baseUrl: "http://127.0.0.1:6999/v1", model: "qwen-2.5-14b" },
      ],
    });
    expect(spare.map((server) => server.label)).toEqual(["Ollama"]);
  });

  it("counts a service configured with a different spelling of the address", () => {
    /**
     * A config written by hand and a probe's own URL will not agree on the
     * trailing `/v1`, the scheme, or a slash. An owner whose service is
     * already configured must not be told its model is unused — that would
     * invite them to add a second service for something they already have.
     */
    for (const spelling of [
      "http://127.0.0.1:11434",
      "http://127.0.0.1:11434/",
      "http://127.0.0.1:11434/v1/",
    ]) {
      const spare = unusedModels({
        servers: [{ ...OLLAMA, models: ["llama3.2"] }],
        configured: [{ baseUrl: spelling, model: "llama3.2" }],
      });
      expect(spare, spelling).toEqual([]);
    }
  });

  it("does not treat a different host as the same server", () => {
    /* The control on the normalising above: it may forgive a path, never a
       machine. A model on somebody else's box is not one of yours. */
    const spare = unusedModels({
      servers: [{ ...OLLAMA, models: ["llama3.2"] }],
      configured: [
        { baseUrl: "http://192.168.1.9:11434/v1", model: "llama3.2" },
      ],
    });
    expect(spare[0]?.models).toEqual(["llama3.2"]);
  });

  it("ignores a service with no address or no model", () => {
    /* A subscription CLI has neither, and reading its absent model as a
       match would silence a real server's whole catalogue. */
    const spare = unusedModels({
      servers: [{ ...OLLAMA, models: ["llama3.2"] }],
      configured: [{ model: "sonnet" }, { baseUrl: undefined }],
    });
    expect(spare[0]?.models).toEqual(["llama3.2"]);
  });

  it("prints a block that parses, with the scope written out", () => {
    /**
     * The fallback byollm_023 named in advance for exactly this case. It has
     * to be pasteable, so it is parsed here rather than eyeballed — a config
     * snippet that does not parse is the B081b defect, where the page taught
     * a shape the daemon rejects by name.
     */
    const block = pasteableService({
      model: "smollm2:135m",
      baseUrl: "http://127.0.0.1:11434/v1",
    });
    const parsed = JSON.parse(block) as Record<
      string,
      { offer?: string; model?: string; type?: string }
    >;
    const [entry] = Object.values(parsed);
    expect(entry?.model).toBe("smollm2:135m");
    expect(entry?.type).toBe("openai-http");
    /* Never defaulted silently — B100's second constraint applies to a
       printed block exactly as it would to a wizard. */
    expect(entry?.offer).toBe("private");
  });

  it("suggests a service name somebody can type", () => {
    /* The tag is dropped because `smollm2:135m` is a name you would have to
       quote, and the part before the colon is the part people say. */
    expect(
      Object.keys(
        JSON.parse(
          pasteableService({
            model: "smollm2:135m",
            baseUrl: "http://127.0.0.1:11434/v1",
          }),
        ) as object,
      ),
    ).toEqual(["smollm2"]);
    /* And a path-shaped id keeps only its last segment. */
    expect(
      Object.keys(
        JSON.parse(
          pasteableService({
            model: "mlx-community/Qwen2.5-14B-Instruct-4bit",
            baseUrl: "http://127.0.0.1:6999/v1",
          }),
        ) as object,
      ),
    ).toEqual(["Qwen2.5-14B-Instruct-4bit"]);
  });
});

describe("what `byollm services` prints about them", () => {
  const report = (
    servers: { label: string; baseUrl: string; models: string[] }[],
    configured: { baseUrl?: string; model?: string }[] = [],
  ) => unusedModelsReport({ servers, configured }).join("\n");

  it("says nothing when every model is already configured", () => {
    /* A section that is always there is furniture — the same reason the
       memory guard stays quiet above the floor. */
    expect(
      unusedModelsReport({
        servers: [{ ...OLLAMA, models: ["llama3.2"] }],
        configured: [
          { baseUrl: "http://127.0.0.1:11434/v1", model: "llama3.2" },
        ],
      }),
    ).toEqual([]);
  });

  it("marks a model that is not local compute, and leaves local ones plain", () => {
    /**
     * Found by running it on Todd's machine: Ollama serves `kimi-k3:cloud`
     * beside three genuinely local models, and a list headed "on this
     * machine" would have said the friendlier half. Ollama proxies hosted
     * models through the same loopback port — B097's subject, on a new
     * surface three rows later.
     */
    const text = report([
      { ...OLLAMA, models: ["smollm2:135m", "kimi-k3:cloud"] },
    ]);
    expect(text).toContain("kimi-k3:cloud  (metered");
    /* The control: a local model carries no mark, or the mark means nothing. */
    expect(text).toMatch(/ {4}smollm2:135m\n/);
  });

  it("holds up a FREE model as the example, not merely the first", () => {
    /* Taking the first blindly would offer a paste that quietly creates a
       metered service. */
    const text = report([
      { ...OLLAMA, models: ["kimi-k3:cloud", "smollm2:135m"] },
    ]);
    expect(text).toContain('"model": "smollm2:135m"');
    expect(text).not.toContain('"model": "kimi-k3:cloud"');
  });

  it("still shows an example when every model here is hosted", () => {
    /**
     * The control on the line above, and the honest half: with nothing local
     * to suggest, staying silent would leave somebody with a list and no way
     * to use any of it. The mark on the entry above still tells the truth.
     */
    const text = report([{ ...OLLAMA, models: ["kimi-k3:cloud"] }]);
    expect(text).toContain('"model": "kimi-k3:cloud"');
    expect(text).toContain("(metered");
  });

  it("names every unused model, not only the one it demonstrates", () => {
    const text = report([
      { ...OLLAMA, models: ["smollm2:135m", "gemma4:26b"] },
      MLX,
    ]);
    for (const model of ["smollm2:135m", "gemma4:26b", "qwen-2.5-14b"]) {
      expect(text, model).toContain(model);
    }
    expect(text).toContain("Ollama (http://127.0.0.1:11434/v1)");
    expect(text).toContain("MLX (http://127.0.0.1:6999/v1)");
  });
});
