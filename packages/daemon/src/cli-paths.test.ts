import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { payloadTextLength, keyId } from "@byollm/protocol";
import { generateKeys, publicIdentityOf } from "@byollm/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeOrigin } from "./allowlist.js";
import { composePrompt } from "./compose.js";
import { DEFAULT_ORIGIN, main, runCli, type CliIo } from "./cli.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import { Pairings } from "./pairings.js";
import { removeTemp } from "./test-support.js";

const SITE = publicIdentityOf(generateKeys(1_800_000_000_000));

/** The CLI paths a successful run never reaches. */

let home: string;
let paths: DaemonPaths;
let err: string;
// `out` was discarded when this file only asserted failure paths. `byollm
// name` answers on stdout, so it is captured now — a helper that throws
// away half the output is a helper that quietly limits what can be tested.
let out: string;

const io = (): Partial<CliIo> => ({
  out: (text) => {
    out += text;
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
  out = "";
});

afterEach(async () => {
  await removeTemp(home);
});

describe("byollm connect — when it cannot", () => {
  it("pairs while advertising nothing, and says so loudly", async () => {
    await writeFile(
      paths.config,
      JSON.stringify({
        backends: {
          local: { backend: "openai-http", baseUrl: "http://127.0.0.1:1/v1" },
        },
        routes: { "llm.generate": { backend: "local", model: "m" } },
      }),
    );

    // Reversed by cloud_002's connect-first ruling. This used to return 1,
    // on the argument that pairing while offering nothing produces a runner
    // that silently never gets work — but a paired daemon whose model server
    // dies an hour later is already in that state, so the refusal guarded t=0
    // and nothing else. The requirement is never to be *silent* about it.
    //
    // There is no hub at this URL, so the run still fails; what matters is
    // that it failed at the *network*, having said its piece and tried.
    await runCli(["connect", "http://127.0.0.1:1"], { paths, io: io() });
    expect(err).toContain("0 backends are healthy");
    expect(err).toContain("byollm backends");
    expect(err).not.toContain("nothing to offer");
    // It got past the backend check to the part where it names where it is
    // going — the proof that pairing was attempted rather than refused.
    expect(out).toContain("Connecting to");
  });

  it("goes to the reference hub when nobody says otherwise", async () => {
    // It used to refuse without a URL. Every user would have pasted the same
    // string, from a page they had not opened yet — so the daemon knows it.
    //
    // A *default*, not a lock: `connect <url>` still goes where it is
    // pointed, which is what keeps the protocol something other people can
    // host. The assertion is on the URL it reaches for, not on reaching it:
    // there is no hub in a unit test, and the failure to connect is the
    // proof it tried.
    // This test could not see the origin until connect stopped refusing at
    // zero backends: the run ended before it named one, so the assertion was
    // "it accepted no argument" plus the constant. Now it says where it is
    // going before it tries, so the default is observable rather than
    // inferred — which is what the comment above always wanted.
    const code = await runCli(["connect"], { paths, io: io() });
    expect(code).not.toBe(2);
    expect(err).not.toContain("usage:");
    expect(out).toContain(DEFAULT_ORIGIN);
    expect(DEFAULT_ORIGIN).toBe("https://hub.byollm.cloud");
  });

  it("still refuses a --name with nothing after it", async () => {
    expect(await runCli(["connect", "--name"], { paths, io: io() })).toBe(2);
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
      owner: "alice",
      sites: { [keyId(SITE.identity)]: SITE },
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

describe("what this machine calls itself", () => {
  it("defaults to the hostname, and remembers a name it is given", async () => {
    // The name is shown on the approval screen — the one moment somebody is
    // deciding whether to trust this machine, and the one moment "which of my
    // three laptops is this" has consequences. A hostname answers it badly.
    expect(await runCli(["name"], { paths, io: io() })).toBe(0);
    expect(out.trim().length).toBeGreaterThan(0);

    expect(await runCli(["name", "studio"], { paths, io: io() })).toBe(0);
    // It says what it will *not* do, because a rename that silently rewrote
    // every app's record of a past decision would be this daemon editing
    // somebody else's memory.
    expect(out).toContain("keeps the name it introduced");

    await runCli(["name"], { paths, io: io() });
    expect(out.trim().endsWith("studio")).toBe(true);
  });

  it("truncates rather than refusing a long name", async () => {
    // The wire caps a label at 120. Refusing at 121 would be a validation
    // error about a field nobody knows exists; truncating is what the
    // hostname path already does.
    await runCli(["name", "x".repeat(200)], { paths, io: io() });
    await runCli(["name"], { paths, io: io() });
    expect(out.trim().split("\n").pop()).toHaveLength(120);
  });
});
