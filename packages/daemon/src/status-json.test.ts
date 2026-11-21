import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runCli,
  STATUS_FORMAT,
  type CliIo,
  type ServiceIo,
  type StatusJson,
} from "./cli.js";
import { writeHealth } from "./health.js";
import { writeHeartbeat } from "./heartbeat.js";
import { DAEMON_VERSION, formatVersion } from "./index.js";
import { Pairings } from "./pairings.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import { writeKeptRunningBy } from "./supervised.js";
import { noSupervisor, removeTemp } from "./test-support.js";

/**
 * `byollm status --json` — cloud_016 phase 1, for the tray in its §6.
 *
 * The tray runs this command rather than opening a port, and it may be a
 * release or two older than the daemon it is reading, because the daemon
 * updates itself and the tray does not. So the cases here are about the
 * shape holding still as much as about what it says: one object, one of
 * three words, every field of format 1 pinned by name and type — and plain
 * `status` held to a recorded output, word for word.
 */
let home: string;
let paths: DaemonPaths;
let out: string;
let errored: string;

const io = (): Partial<CliIo> => ({
  out: (text) => {
    out += text;
  },
  err: (text) => {
    errored += text;
  },
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "byollm-status-json-"));
  paths = daemonPaths(join(home, ".byollm"));
  await mkdir(paths.root, { recursive: true });
  out = "";
  errored = "";
});
afterEach(() => removeTemp(home));

/**
 * A Linux supervisor that answers `is-active` with `word`.
 *
 * `home` is the temp directory, so nothing here reads or writes the real
 * `~/.config/systemd`.
 */
const systemd = (word: string): ServiceIo => ({
  ...noSupervisor(),
  home,
  run: () => Promise.resolve({ code: 0, output: `${word}\n` }),
});

const unsupervised = (): ServiceIo => ({ ...noSupervisor(), home });

const statusJson = async (service: ServiceIo = unsupervised()) => {
  const code = await runCli(["status", "--json"], {
    paths,
    io: io(),
    service,
  });
  return {
    code,
    status: JSON.parse(out) as Partial<Record<keyof StatusJson, unknown>>,
  };
};

const paired = async () => {
  const pairings = new Pairings(paths.pairings);
  await pairings.load();
  await pairings.put({
    origin: "https://hub.test",
    runnerId: "runner_1",
    owner: "kevin@example.test",
    ownerLabel: "Kevin Example",
    sites: {},
    pairedAt: Date.now(),
  });
};

const CONFIG = {
  autoUpdate: true,
  services: {
    "my claude": { type: "claude-cli", model: "sonnet", kinds: ["llm.chat"] },
    studio: {
      type: "openai-http",
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "qwen",
      kinds: ["llm.generate"],
    },
  },
};

const configured = async (config: object = CONFIG) => {
  await writeFile(paths.config, JSON.stringify(config), "utf8");
};

/** A beat from this process, which is alive: a daemon that is up. */
const beating = () =>
  writeHeartbeat(paths.heartbeat, { at: Date.now(), pid: process.pid });

describe("byollm status --json", () => {
  it("writes one JSON object on stdout, with its format, and exits 0", async () => {
    const { code, status } = await statusJson();

    expect(code).toBe(0);
    expect(out.endsWith("}\n")).toBe(true);
    expect(out.trim().split("\n")).toHaveLength(1);
    expect(errored).toBe("");
    expect(status.format).toBe(1);
    expect(status.format).toBe(STATUS_FORMAT);
  });

  /**
   * The contract a tray built today is built against.
   *
   * Every field of format 1, by name and by type, and nothing else. Adding a
   * field fails this case by design: the person adding it adds it here, and
   * that is the moment to read STATUS_FORMAT's comment. Removing or renaming
   * one fails it too, and the only way to make it pass again without
   * putting the field back is to change the number — which is the point.
   */
  it("carries exactly format 1's fields, and a change to them moves the number", async () => {
    await configured();
    await paired();
    const { status } = await statusJson();

    const shape = Object.fromEntries(
      Object.entries(status).map(([key, value]) => [
        key,
        Array.isArray(value) ? "array" : typeof value,
      ]),
    );
    expect({ format: STATUS_FORMAT, shape }).toEqual({
      format: 1,
      shape: {
        format: "number",
        state: "string",
        daemonVersion: "string",
        services: "array",
        autoUpdate: "boolean",
        paired: "boolean",
      },
    });
  });

  it("says what a tray needs: version, services by the owner's names, auto-update, paired", async () => {
    await configured();
    await paired();
    const { status } = await statusJson();

    expect(status.daemonVersion).toBe(DAEMON_VERSION);
    expect(status.services).toEqual(["my claude", "studio"]);
    expect(status.autoUpdate).toBe(true);
    expect(status.paired).toBe(true);
  });

  it("says a machine nobody set up runs nothing, is not paired, and does not update", async () => {
    const { status } = await statusJson();

    expect(status.services).toEqual([]);
    expect(status.autoUpdate).toBe(false);
    expect(status.paired).toBe(false);
  });

  it("names no account, no owner and no app — only that it is paired", async () => {
    await configured();
    await paired();
    await statusJson();

    expect(out).not.toContain("kevin");
    expect(out).not.toContain("Kevin");
    expect(out).not.toContain("hub.test");
    expect(out).not.toContain("runner_1");
  });

  it("does not retire the old allowlist, or print its notice, from a tray's poll", async () => {
    await writeFile(paths.allowlist, JSON.stringify({ entries: [] }), "utf8");
    const { status } = await statusJson();

    expect(status.format).toBe(1);
    await expect(access(paths.allowlist)).resolves.toBeUndefined();
  });
});

describe("the three states", () => {
  it("running: under a supervisor, and beating", async () => {
    await configured();
    await paired();
    await beating();

    expect((await statusJson(systemd("active"))).status.state).toBe("running");
  });

  it("running: kept running by a box's own supervisor", async () => {
    await configured();
    await paired();
    await beating();
    await writeKeptRunningBy(paths.supervisor, {
      by: "the box's supervisor",
      pid: process.pid,
      at: Date.now(),
    });

    expect((await statusJson()).status.state).toBe("running");
  });

  it("stopped: nothing is installed to start it", async () => {
    await configured();
    await paired();

    expect((await statusJson()).status.state).toBe("stopped");
  });

  it("stopped: a machine nobody has set up", async () => {
    expect((await statusJson()).status.state).toBe("stopped");
  });

  /* These two start where nothing else already says "not running": not
     paired, so no beat is not stale, or beating from a live pid. Only the
     supervisor's "down" decides, so dropping that check turns them green
     (review #68852: paired with no beat was stale on its own). */
  it("needs_attention: installed, crash-looping before its first beat", async () => {
    await configured();

    expect((await statusJson(systemd("failed"))).status.state).toBe(
      "needs_attention",
    );
  });

  it("needs_attention: the supervisor says down, though a beat is fresh", async () => {
    await configured();
    await paired();
    await beating();

    expect((await statusJson(systemd("failed"))).status.state).toBe(
      "needs_attention",
    );
  });

  it("needs_attention: the supervisor says active, and nothing is beating", async () => {
    await configured();
    await paired();

    expect((await statusJson(systemd("active"))).status.state).toBe(
      "needs_attention",
    );
  });

  it("needs_attention: running, and the hub refuses everything it sends", async () => {
    await configured();
    await paired();
    await beating();
    await writeHealth(paths.health, {
      at: Date.now(),
      consecutiveFailures: 10,
      origin: "https://hub.test",
      lastError: "401",
    });

    expect((await statusJson(systemd("active"))).status.state).toBe(
      "needs_attention",
    );
  });

  it("needs_attention: running, and the hub has revoked this device", async () => {
    await configured();
    await paired();
    await beating();
    await writeHealth(paths.health, {
      at: Date.now(),
      consecutiveFailures: 0,
      revoked: { at: Date.now(), origin: "https://hub.test" },
    });

    expect((await statusJson(systemd("active"))).status.state).toBe(
      "needs_attention",
    );
  });

  it("needs_attention: Windows's Startup-folder fallback, and nothing beating", async () => {
    await configured();
    await paired();
    const appData = join(home, "AppData");
    const windows: ServiceIo = {
      ...noSupervisor(),
      platform: "win32",
      home,
      appData,
    };
    const startup = join(
      appData,
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
    );
    await mkdir(startup, { recursive: true });
    await writeFile(join(startup, "byollm.cmd"), "", "utf8");

    const { status } = await statusJson(windows);
    // Fallback found: installed. Nothing beating: not running.
    expect(status.state).toBe("needs_attention");
  });
});

/**
 * Plain `status`, word for word, against what it printed before `--json`.
 *
 * Recorded from the tree before this change, then normalised for the parts
 * that belong to the machine running the suite rather than to the command:
 * the version tuple (platform, node), the fingerprint, the memory reading
 * and the temp directory. Everything else is the command's own words.
 */
const normalised = (text: string) =>
  text
    .replace(formatVersion(), "<VERSION>\n")
    .replace(/^identity: .*$/m, "identity: <FINGERPRINT>")
    .replace(/^memory guard:[\s\S]*?\n\n/m, "<MEMORY>\n\n")
    .split(home)
    .join("<HOME>");

describe("plain byollm status is unchanged", () => {
  it("prints what it printed for a device running under a supervisor", async () => {
    await configured();
    await paired();
    await beating();
    const code = await runCli(["status"], {
      paths,
      io: io(),
      service: systemd("active"),
    });

    expect(code).toBe(0);
    expect(normalised(out)).toBe(RECORDED_RUNNING);
  });

  it("prints what it printed for a machine nobody has set up", async () => {
    const code = await runCli(["status"], {
      paths,
      io: io(),
      service: unsupervised(),
    });

    expect(code).toBe(0);
    expect(normalised(out)).toBe(RECORDED_NOT_SET_UP);
  });
});

/* Recorded from `byollm status` before `--json` existed (HEAD 1d3d48d). */
const RECORDED_RUNNING = [
  "<VERSION>",
  "identity: <FINGERPRINT>",
  "state: running",
  "service: running under systemd (user)",
  "",
  "<MEMORY>",
  "",
  "paired apps",
  "  https://hub.test  as Kevin Example",
  "",
  "services",
  "  my claude",
  "      sonnet  (claude-cli)",
  "      private (only you) · answers llm.chat · your default for llm.chat",
  "  studio",
  "      qwen  (openai-http)",
  "      private (only you) · answers llm.generate · your default for llm.generate",
  "",
  "who can use this device",
  "  you, always",
  "  nobody else, through https://hub.test — it has no control plane, so nothing",
  "   can tell this device who anybody else is",
  "",
  "community work done for others",
  "  0 in the last hour (cap 20), 0 today (cap 100)",
  "",
  "this device has run",
  "  0 prompts, 0 ok, 0 failed, 0 refused",
  "  full log: <HOME>/.byollm/ingress.log — `byollm logs` reads it",
  "  other people's prompts are kept 7 days, then hashed",
  "",
].join("\n");
const RECORDED_NOT_SET_UP = [
  "<VERSION>",
  "identity: <FINGERPRINT>",
  "state: NOT SET UP",
  "  no config at <HOME>/.byollm/config.json, and nothing has run here yet.",
  "  Run `byollm setup` to find what this computer already has.",
  "service: not installed — jobs only run while `byollm run` is open (`byollm start` fixes that)",
  "",
  "<MEMORY>",
  "",
  "paired apps",
  "  (none — run `byollm connect <url>`)",
  "",
  "services",
  "  (none — run `byollm setup`)",
  "",
  "who can use this device",
  "  you, always",
  "  nobody else — this device is not paired with anything",
  "",
  "community work done for others",
  "  0 in the last hour (cap 20), 0 today (cap 100)",
  "",
  "this device has run",
  "  0 prompts, 0 ok, 0 failed, 0 refused",
  "  full log: <HOME>/.byollm/ingress.log — `byollm logs` reads it",
  "  other people's prompts are kept 7 days, then hashed",
  "",
].join("\n");
