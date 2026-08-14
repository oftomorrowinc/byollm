import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { payloadTextLength } from "@byollm/protocol";
import { generateKeys, publicIdentityOf } from "@byollm/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeOrigin } from "./allowlist.js";
import { composePrompt } from "./compose.js";
import { main, runCli, type CliIo } from "./cli.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import { Pairings } from "./pairings.js";

const SITE = publicIdentityOf(generateKeys(1_800_000_000_000));

/** The CLI paths a successful run never reaches. */

let home: string;
let paths: DaemonPaths;
let err: string;

const io = (): Partial<CliIo> => ({
  out: () => {
    // This file asserts the failure paths, which all report on stderr.
  },
  err: (text) => {
    err += text;
  },
  confirm: () => Promise.resolve(false),
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "byollm-clipaths-"));
  paths = daemonPaths(home);
  err = "";
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("byollm connect — when it cannot", () => {
  it("refuses to pair while advertising nothing, and says where to look", async () => {
    await writeFile(
      paths.config,
      JSON.stringify({
        backends: {
          local: { backend: "openai-http", baseUrl: "http://127.0.0.1:1/v1" },
        },
        routes: { "llm.generate": { backend: "local", model: "m" } },
      }),
    );

    // Pairing while offering nothing produces a runner that silently never
    // gets work — a failure the user could not diagnose.
    expect(
      await runCli(["connect", "http://127.0.0.1:1"], { paths, io: io() }),
    ).toBe(1);
    expect(err).toContain("nothing to offer");
    expect(err).toContain("byollm backends");
  });

  it("requires a url", async () => {
    expect(await runCli(["connect"], { paths, io: io() })).toBe(2);
    expect(err).toContain("usage:");
  });

  it("reports config problems before it tries anything", async () => {
    await writeFile(
      paths.config,
      JSON.stringify({
        backends: { ghost: { backend: "openai-http" } },
        routes: { "llm.generate": { backend: "ghost", model: "m" } },
      }),
    );
    await runCli(["connect", "http://127.0.0.1:1"], { paths, io: io() });
    expect(err).toContain("config:");
    expect(err).toContain("baseUrl");
  });
});

describe("byollm run — when the pairing is missing", () => {
  it("names the origin it is not paired with", async () => {
    const pairings = new Pairings(paths.pairings);
    await pairings.load();
    await pairings.put({
      origin: "https://other.test",
      runnerId: "runner_1",
      token: "t",
      owner: "alice",
      site: SITE,
      pairedAt: Date.now(),
    });

    expect(
      await runCli(["run", "https://not-paired.test"], { paths, io: io() }),
    ).toBe(2);
    expect(err).toContain("not paired with https://not-paired.test");
  });
});

describe("main", () => {
  it("returns an exit code rather than throwing", async () => {
    expect(await main(["--help"])).toBe(0);
  });
});

describe("small edges elsewhere", () => {
  it("normalises an origin that is not a URL at all", () => {
    // A malformed origin should compare consistently rather than throw.
    expect(normalizeOrigin("not a url///")).toBe("not a url");
  });

  it("labels a system-role message in a conversation", () => {
    const composed = composePrompt({
      id: "j",
      kind: "llm.chat",
      payload: {
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hi" },
        ],
      },
      audience: "self",
      owner: "me",
      lease: { id: "lease_test", runnerId: "r", expiresAt: Date.now() + 1_000 },
    });
    expect(composed).toContain("System: be brief");
    expect(composed).toContain("User: hi");
  });

  it("counts a chat payload with no system text", () => {
    expect(
      payloadTextLength({
        kind: "llm.chat",
        payload: { messages: [{ role: "user", content: "12345" }] },
      }),
    ).toBe(5);
  });

  it("reads an empty pairings file as no pairings", async () => {
    await writeFile(paths.pairings, "{ not json");
    const pairings = new Pairings(paths.pairings);
    await pairings.load();
    expect(pairings.list()).toEqual([]);
  });
});
