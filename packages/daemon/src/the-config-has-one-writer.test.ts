import { readFile, readdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONFIG_VERSION,
  ConfigTooNew,
  DaemonConfig,
  loadConfig,
  migrateConfig,
  writeConfig,
} from "./config.js";

/**
 * `~/.byollm/config.json` says which shape it is, and one function writes it
 * — B236.
 *
 * ## What the version is for, and why it could not wait
 *
 * The file is the owner's and it is precious: the services they configured,
 * the defaults they chose, the spend caps they acknowledged. Until now it
 * carried nothing that said which shape it was, which is survivable exactly
 * once — the first time the shape has to change, every file on every machine
 * is of indeterminate age and the only way to read one is to guess from its
 * contents. That is how a migration becomes a heuristic.
 *
 * ## Why one writer, and why that is the harder half
 *
 * There were three, and they disagreed. `byollm model` and `byollm offer`
 * wrote the parsed config, baking every schema default into the owner's file;
 * `byollm services` — which `setup` also writes through — wrote a merged raw
 * object, baking none. A version stamped by two doors of three is a version
 * you cannot trust to be present, and being trustably present is the only
 * thing a version does.
 */
const SRC = fileURLToPath(new URL(".", import.meta.url));

describe("the version on the file", () => {
  it("is added to a config that predates the field", () => {
    /**
     * The unversioned era, and the one migration this chain performs today.
     *
     * These files ARE version 1 — the shape they hold is the shape this build
     * reads — so the migration is to say so. It runs on every config on every
     * machine that has one, which is what keeps the mechanism from being a
     * chain whose only link is unreachable.
     */
    const before = { services: {} };
    expect(migrateConfig(before, "/x/config.json")).toEqual({
      services: {},
      version: CONFIG_VERSION,
    });
  });

  it("leaves a config that already declares this version alone", () => {
    const already = { version: CONFIG_VERSION, services: {} };
    expect(migrateConfig(already, "/x/config.json")).toBe(already);
  });

  it("refuses a config from a newer byollm, by number and in words", () => {
    /**
     * Not "unrecognized key". A config written by a future byollm is not
     * malformed, and the schema can only ever complain about its shape — which
     * sends its owner to delete a field they were told to add, to make an
     * error go away, on the file that holds their spend caps.
     *
     * The version is read BEFORE the schema for exactly this reason, so the
     * refusal names the situation instead of describing its symptom.
     */
    let thrown: unknown;
    try {
      migrateConfig({ version: 2, services: {} }, "/x/config.json");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigTooNew);
    expect(String(thrown)).toContain("newer byollm");
    expect(String(thrown)).toContain("Upgrade byollm rather than editing");
    expect(String(thrown)).not.toContain("Unrecognized");
  });

  it("refuses it through loadConfig, which is the path that has a file", () => {
    /* The unit above proves the function; this proves the wiring. A migration
       nothing calls is the shape of defect this whole repository keeps
       finding. */
    return (async () => {
      const dir = await mkdtemp(join(tmpdir(), "byollm-config-"));
      const path = join(dir, "config.json");
      await writeConfigRaw(path, { version: 99, services: {} });
      await expect(loadConfig(path)).rejects.toThrow(ConfigTooNew);
    })();
  });

  it("loads an unversioned config exactly as it used to", async () => {
    /**
     * The control, and the whole compatibility claim in one line: every config
     * written before today still loads, still resolves the same routes, and
     * gains nothing but a number nobody asked for.
     */
    const dir = await mkdtemp(join(tmpdir(), "byollm-config-"));
    const path = join(dir, "config.json");
    await writeConfigRaw(path, {
      services: {
        ollama: {
          type: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "llama3.2",
          kinds: ["llm.generate"],
        },
      },
    });
    const loaded = await loadConfig(path);
    expect(loaded.config.version).toBe(CONFIG_VERSION);
    expect(loaded.routes.map((route) => route.kind)).toEqual(["llm.generate"]);
  });
});

describe("writeConfig", () => {
  it("stamps the version first, whatever it was handed", async () => {
    /* Including a config claiming a version this build cannot read. A writer
       that can emit what its own loader refuses is not a writer, it is a
       second format — and the loader is right there to prove it. */
    const dir = await mkdtemp(join(tmpdir(), "byollm-config-"));
    const path = join(dir, "config.json");
    await writeConfig(path, { version: 99, services: {} });

    const written: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(Object.keys(written as object)[0]).toBe("version");
    expect((written as { version: unknown }).version).toBe(CONFIG_VERSION);
    await expect(loadConfig(path)).resolves.toBeDefined();
  });

  it("writes nothing else that was not handed to it", async () => {
    /* The rule setup.test.ts states and this one guards at the writer: a file
       full of today's defaults for settings nobody was asked about is a file
       that freezes them. The version is the exception because it describes the
       file rather than configuring the daemon. */
    const dir = await mkdtemp(join(tmpdir(), "byollm-config-"));
    const path = join(dir, "config.json");
    await writeConfig(path, { services: {} });

    const written: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(Object.keys(written as object)).toEqual(["version", "services"]);
  });

  it("creates the directory, which two of the three callers used to do", async () => {
    const dir = await mkdtemp(join(tmpdir(), "byollm-config-"));
    const path = join(dir, "nested", "config.json");
    await writeConfig(path, { services: {} });
    expect(JSON.parse(await readFile(path, "utf8"))).toHaveProperty(
      "version",
      CONFIG_VERSION,
    );
  });
});

describe("there is no second writer", () => {
  /**
   * Read from the source, because the property is an absence.
   *
   * A test that drove every command and checked the files would pass the day
   * somebody added a fourth command and forgot to drive it — and the fourth
   * command is precisely what this is for. B229's wizard and B230's installer
   * are not written yet; this is the check that meets them.
   */
  it("finds the writer, or this is looking at nothing", async () => {
    const config = await readFile(join(SRC, "config.js"), "utf8").catch(
      async () => readFile(join(SRC, "config.ts"), "utf8"),
    );
    expect(config).toContain("export async function writeConfig");
  });

  it("has no other module writing the config path", async () => {
    const offenders: string[] = [];
    for (const entry of await readdir(SRC)) {
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
      if (entry === "config.ts") continue;
      const source = await readFile(join(SRC, entry), "utf8");
      for (const line of source.split("\n")) {
        /* `writeFile(...)` whose target is a config path. Matched on the
           argument rather than on the call, because this module tree writes
           plenty of other files and none of them are this one. */
        if (!line.includes("writeFile(")) continue;
        if (!/config(Path|\b)/i.test(line)) continue;
        offenders.push(`${entry}: ${line.trim()}`);
      }
    }
    expect(
      offenders,
      "a second writer of ~/.byollm/config.json — the version it does not " +
        "stamp is the version nothing can rely on",
    ).toEqual([]);
  });
});

/** A config written straight to disk, bypassing the writer under test. */
async function writeConfigRaw(path: string, value: unknown): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe("the schema", () => {
  it("accepts the version it stamps and no other", () => {
    expect(DaemonConfig.safeParse({ services: {}, version: 1 }).success).toBe(
      true,
    );
    expect(DaemonConfig.safeParse({ services: {}, version: 2 }).success).toBe(
      false,
    );
  });

  it("defaults it, so a config assembled in code need not restate it", () => {
    expect(DaemonConfig.parse({ services: {} }).version).toBe(CONFIG_VERSION);
  });
});
