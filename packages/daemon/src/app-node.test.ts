import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOWEST_SAFE_NODE, nodeIsOlder, oldAppNodeLine } from "./app-node.js";
import {
  runCli,
  STATUS_FORMAT,
  type CliIo,
  type ServiceIo,
  type StatusJson,
} from "./cli.js";
import { readHeartbeat, writeHeartbeat } from "./heartbeat.js";
import { formatVersion } from "./index.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import type { ServicePlatform } from "./service.js";
import { noSupervisor, pairedForStart, removeTemp } from "./test-support.js";

/**
 * `byollm status` says when the BYOLLM app's own Node is older than this
 * release calls safe — #11052, ruled on #10660: "The warning is only for a
 * Node our installer put there, never a person's own."
 *
 * "Our Node" is the app's note naming the Node and program the daemon's
 * last heartbeat says it ran from. The Node and program are real files here,
 * because the note's paths are resolved before they are compared.
 */
let home: string;
let paths: DaemonPaths;
let out: string;
let appNode: string;
let appProgram: string;
let ownNode: string;
let ownProgram: string;

const io = (): Partial<CliIo> => ({
  out: (text) => {
    out += text;
  },
  err: () => undefined,
});

const touch = async (path: string) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "", "utf8");
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "byollm-app-node-"));
  paths = daemonPaths(join(home, ".byollm"));
  await mkdir(paths.root, { recursive: true });
  appNode = join(home, ".byollm", "node", "bin", "node");
  appProgram = join(
    home,
    ".byollm",
    "node",
    "lib",
    "node_modules",
    "byollm",
    "dist",
    "bin.js",
  );
  ownNode = join(home, "usr", "local", "bin", "node");
  ownProgram = join(
    home,
    "usr",
    "local",
    "lib",
    "node_modules",
    "byollm",
    "dist",
    "bin.js",
  );
  for (const path of [appNode, appProgram, ownNode, ownProgram])
    await touch(path);
  out = "";
});
afterEach(() => removeTemp(home));

const service = (platform: ServicePlatform = "darwin"): ServiceIo => ({
  ...noSupervisor(),
  platform,
  home,
});

/** The note the app writes when it installs (#11051). */
const noted = () =>
  writeFile(
    paths.appNote,
    JSON.stringify({
      format: 1,
      app: join(home, "Applications", "BYOLLM.app"),
      node: appNode,
      program: appProgram,
    }),
    "utf8",
  );

/** A daemon's beat, from the app's Node or a person's own. */
const beatFrom = (whose: "app" | "own" | "unrecorded", node: string) =>
  writeHeartbeat(paths.heartbeat, {
    at: Date.now(),
    pid: process.pid,
    ...(whose === "unrecorded"
      ? {}
      : whose === "app"
        ? { execPath: appNode, scriptPath: appProgram, node }
        : { execPath: ownNode, scriptPath: ownProgram, node }),
  });

const OLD = "22.13.1";
const SAFE = "24.11.0";

const statusJson = async (platform: ServicePlatform = "darwin") => {
  out = "";
  await runCli(["status", "--json"], {
    paths,
    io: io(),
    service: service(platform),
  });
  return JSON.parse(out) as Partial<Record<keyof StatusJson, unknown>>;
};

const normalised = (text: string) =>
  text
    .replace(formatVersion(), "<VERSION>\n")
    .replace(/^identity: .*$/m, "identity: <FINGERPRINT>")
    .replace(/^memory guard:[\s\S]*?\n\n/m, "<MEMORY>\n\n")
    .split(home)
    .join("<HOME>");

const status = async (platform: ServicePlatform = "darwin") => {
  out = "";
  await runCli(["status"], { paths, io: io(), service: service(platform) });
  return normalised(out);
};

describe("the lowest Node this release calls safe", () => {
  /* The ruling's point 2: it is not `engines`, and it never sits below it.
     It starts AT the floor so nothing is warned about on the day it ships;
     raising it is the release step in docs/releasing.md. */
  it("is a version at or above every `engines` floor that names the daemon", async () => {
    for (const file of ["../package.json", "../../../package.json"]) {
      const manifest = JSON.parse(
        await readFile(new URL(file, import.meta.url), "utf8"),
      ) as { engines: { node: string } };
      const floor = /^>=(\d+)\.(\d+)(?:\.(\d+))?$/u.exec(manifest.engines.node);
      expect(floor, file).not.toBeNull();
      const version = `${floor?.[1] ?? ""}.${floor?.[2] ?? ""}.${floor?.[3] ?? "0"}`;
      expect(nodeIsOlder(LOWEST_SAFE_NODE, version), file).toBe(false);
    }
  });

  it("compares as numbers, field by field", () => {
    expect(nodeIsOlder("22.13.1", "22.14.0")).toBe(true);
    expect(nodeIsOlder("v22.9.0", "22.14.0")).toBe(true);
    expect(nodeIsOlder("20.99.99", "22.14.0")).toBe(true);
    expect(nodeIsOlder("22.14.0", "22.14.0")).toBe(false);
    expect(nodeIsOlder("22.14.1", "22.14.0")).toBe(false);
    expect(nodeIsOlder("24.0.0", "22.14.0")).toBe(false);
  });

  it("calls an unreadable version not older — a warning is never a guess", () => {
    expect(nodeIsOlder("", "22.14.0")).toBe(false);
    expect(nodeIsOlder("22", "22.14.0")).toBe(false);
    expect(nodeIsOlder("22.13.1-nightly", "22.14.0")).toBe(false);
  });
});

describe("the heartbeat names the daemon's Node", () => {
  it("reads back the Node and program that wrote it", async () => {
    await beatFrom("app", OLD);
    expect(await readHeartbeat(paths.heartbeat)).toMatchObject({
      execPath: appNode,
      scriptPath: appProgram,
      node: OLD,
    });
  });

  it("still reads a beat from before it recorded them", async () => {
    await writeFile(
      paths.heartbeat,
      JSON.stringify({ at: 1, pid: 2, node: 3 }),
      "utf8",
    );
    expect(await readHeartbeat(paths.heartbeat)).toEqual({ at: 1, pid: 2 });
  });
});

describe("the daemon writes its Node into the beat", () => {
  /* The status cases below write the beat themselves, so deleting the
     daemon's half passes all of them. This is `byollm run` writing it. */
  it("names the Node and program `byollm run` runs from, and that Node's version", async () => {
    await pairedForStart(paths.pairings, "http://127.0.0.1:1");
    const stop = new AbortController();
    const done = runCli(["run"], {
      paths,
      io: io(),
      service: {
        ...service(),
        execPath: appNode,
        scriptPath: appProgram,
        run: () => Promise.resolve({ code: 0, output: "" }),
      },
      supervised: true,
      interactive: false,
      signal: stop.signal,
    });
    const deadline = Date.now() + 10_000;
    let beat = await readHeartbeat(paths.heartbeat);
    while (beat?.execPath === undefined && Date.now() < deadline) {
      await new Promise((wake) => setTimeout(wake, 20));
      beat = await readHeartbeat(paths.heartbeat);
    }
    stop.abort();
    await done;

    expect(beat).toMatchObject({
      execPath: appNode,
      scriptPath: appProgram,
      node: process.versions.node,
    });
  }, 30_000);
});

describe("status --json's appNodeOutdated", () => {
  it("is true on the app's own Node when it is older than the release calls safe", async () => {
    await noted();
    await beatFrom("app", OLD);
    const json = await statusJson();

    expect(json.appNodeOutdated).toBe(true);
    expect(json.format).toBe(1);
    expect(STATUS_FORMAT).toBe(1);
  });

  it("is false on the app's own Node at or above it", async () => {
    await noted();
    await beatFrom("app", LOWEST_SAFE_NODE);
    expect((await statusJson()).appNodeOutdated).toBe(false);
    await beatFrom("app", SAFE);
    expect((await statusJson()).appNodeOutdated).toBe(false);
  });

  /* The ruling's whole condition: never a person's own Node, whatever its
     version — with the note there, and without it. */
  it("is false on a person's own Node, however old, note or no note", async () => {
    for (const node of [OLD, "18.0.0", "0.0.1"]) {
      await beatFrom("own", node);
      expect((await statusJson()).appNodeOutdated).toBe(false);
      await noted();
      expect((await statusJson()).appNodeOutdated).toBe(false);
    }
  });

  it("is false when the app's Node is beating and there is no note", async () => {
    await beatFrom("app", OLD);
    expect((await statusJson()).appNodeOutdated).toBe(false);
  });

  it("is false on a beat that does not say which Node wrote it", async () => {
    await noted();
    await beatFrom("unrecorded", OLD);
    expect((await statusJson()).appNodeOutdated).toBe(false);
  });

  it("is false with no beat at all", async () => {
    await noted();
    expect((await statusJson()).appNodeOutdated).toBe(false);
  });

  it("is false on Linux, where the app does not ship and the note is never read", async () => {
    await noted();
    await beatFrom("app", OLD);
    expect((await statusJson("linux")).appNodeOutdated).toBe(false);
  });

  /* Red team, app first: the tray (on the app's Node) runs this, while the
     daemon was moved to the person's Node by `npm i -g byollm` and
     `byollm start`. The note still names the app's Node; the beat does not. */
  it("follows the daemon, not the note, when npm's byollm took over", async () => {
    await noted();
    await beatFrom("app", OLD);
    expect((await statusJson()).appNodeOutdated).toBe(true);
    await beatFrom("own", OLD);
    expect((await statusJson()).appNodeOutdated).toBe(false);
  });
});

describe("plain status", () => {
  it("gains exactly one line on the app's own old Node, and is otherwise the same", async () => {
    await noted();
    await beatFrom("app", SAFE);
    const safe = await status();
    await beatFrom("app", OLD);
    const old = await status();

    const line = oldAppNodeLine(OLD);
    expect(line).toBe(
      `node: this BYOLLM came with its own Node (22.13.1), which is older ` +
        `than this release calls safe (${LOWEST_SAFE_NODE}) — downloading ` +
        `BYOLLM again replaces it.\n`,
    );
    expect(old.split(line)).toHaveLength(2);
    expect(old.replace(line, "")).toBe(safe);
    // Under the service line, before the blank line that ends the headline.
    expect(old).toMatch(/\nservice: [^\n]*\nnode: [^\n]*\n\n/u);
  });

  it("says nothing on a person's own old Node", async () => {
    await noted();
    await beatFrom("own", SAFE);
    const safe = await status();
    await beatFrom("own", OLD);

    expect(await status()).toBe(safe);
    expect(safe).not.toContain("its own Node");
  });

  it("names no URL", () => {
    expect(oldAppNodeLine(OLD)).not.toMatch(/https?:|www\.|\.com/u);
  });
});
