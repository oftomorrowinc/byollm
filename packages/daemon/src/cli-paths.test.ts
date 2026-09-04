import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { payloadTextLength, keyId } from "@byollm/protocol";
import { generateKeys, publicIdentityOf } from "@byollm/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeOrigin, UnusableOrigin } from "./origins.js";
import { composePrompt } from "./compose.js";
import {
  DEFAULT_ORIGIN,
  connectTarget,
  main,
  runCli,
  type CliIo,
} from "./cli.js";
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
        services: {
          local: {
            model: "m",
            kinds: ["llm.generate"],
            type: "openai-http",
            baseUrl: "http://127.0.0.1:1/v1",
          },
        },
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
    expect(err).toContain("Nothing will route to this device yet");
    /* Still points somewhere. It used to say `byollm services`; the lines
       themselves are printed inline now, so it points at the surface that
       keeps saying it rather than the one that lists backends. */
    expect(err).toContain("byollm status");
    expect(err).not.toContain("nothing to offer");
    // It got past the backend check to the part where it names where it is
    // going — the proof that pairing was attempted rather than refused.
    expect(out).toContain("Connecting to");
  });

  it("goes to the reference hub when nobody says otherwise", () => {
    // It used to refuse without a URL. Every user would have pasted the same
    // string, from a page they had not opened yet — so the daemon knows it.
    //
    // **Asserted as the constant, and deliberately not by running `connect`.**
    // This test used to call the CLI with no argument, which sent a real pair
    // request to the real hub on every run: tolerable while the hub refused
    // that shape in 400ms, and not tolerable now that it answers — the run
    // hung for the full poll and left a pending code in production Valkey
    // behind it. A unit test that reaches the internet is a unit test that
    // fails when somebody is on a train, and this one had also become a
    // little machine for littering the live service.
    //
    // The behaviour it was reaching for — "no argument means the default" —
    // is covered where it can be checked without a network: the integration
    // test drives the whole `connect` path against a local server.
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
        services: {
          ghost: { model: "m", kinds: ["llm.generate"], type: "openai-http" },
        },
      }),
    );
    await runCli(["connect", "http://127.0.0.1:1"], { paths, io: io() });
    expect(err).toContain("config:");
    expect(err).toContain("baseUrl");
  });
});

describe("byollm run — no url to give it", () => {
  it("refuses an argument rather than guessing what it meant", async () => {
    /**
     * `run <url>` is gone — byollm_020.
     *
     * It meant "serve only this one app", which nobody wanted and everybody
     * misread: the url in `connect <url>` is where you pair, and the same
     * shape here reads as "point the daemon at this address". Two commands
     * taking a url, one of which does not mean what it looks like, is what
     * the audit is for.
     *
     * Refused rather than ignored, and pointing at the command that does
     * take a url. **A verb handed an argument it has no use for must say so
     * and name the verb that does** — the ruling `models` earned, applied to
     * the other command that had the same hole.
     */
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
    expect(err).toContain("byollm run takes no arguments");
    // The url belongs to `connect`, and the message says so with theirs in it.
    expect(err).toContain("byollm connect https://not-paired.test");
  });
});

describe("byollm model — the verb, through the router", () => {
  it("shows the three shapes rather than guessing which was meant", async () => {
    // `byollm model` alone is ambiguous between "list them" and "which
    // service?", and guessing either would be wrong half the time. Usage,
    // exit 2 — a bad argument, not a run that went wrong.
    expect(await runCli(["model"], { paths, io: io() })).toBe(2);
    expect(err).toContain("byollm services");
    expect(err).toContain("byollm model <service> <name>");
  });

  it("says where to look when there is no config at all", async () => {
    expect(await runCli(["models"], { paths, io: io() })).toBe(1);
    expect(err).toContain("byollm setup");
  });

  it("is in help, where somebody would look for it", async () => {
    await runCli(["--help"], { paths, io: io() });
    /* `models` left the surface in byollm_020 — its listing is a column of
       `services` now, because "services" is the ruled word and two lists of
       one table is what the audit exists to remove. The setter stays: it
       names a real thing somebody is choosing. */
    expect(out).toContain("byollm services");
    expect(out).toContain("byollm model");
    expect(out).not.toContain("byollm models");
  });
});

describe("main", () => {
  it("returns an exit code rather than throwing", async () => {
    expect(await main(["--help"])).toBe(0);
  });

  it("answers a mistyped address with a remedy, not a stack trace", async () => {
    // Handled centrally in `main` rather than at each command that takes an
    // address, so a command written next year gets it without anybody
    // remembering to add it — the failure mode of the check that missed the
    // stop-ship was a hand-maintained list that did not grow with the code.
    const written: string[] = [];
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    try {
      // Exit 2: a bad argument is a usage error, the same as an unknown
      // command, and not the 1 that means "this ran and went wrong".
      expect(await main(["forget", "ftp://x.test"])).toBe(2);
    } finally {
      stderr.mockRestore();
    }
    const said = written.join("");
    expect(said).toContain("ftp://x.test");
    expect(said).toContain("not a usable address");
    expect(said).toContain("https://app.example.com");
    expect(said).not.toContain("UnusableOrigin");
  });
});

describe("small edges elsewhere", () => {
  it("refuses an origin that is not a URL at all", () => {
    // This test used to assert the opposite, and its reason was written down:
    // "a malformed origin should compare consistently rather than throw."
    // Consistently *with what* was never asked. It compared consistently with
    // itself and with nothing else, so `hub.byollm.cloud` never matched the
    // pairing stored as `https://hub.byollm.cloud` — the 2026-08-26 stop-ship.
    // Unparseable input now refuses. See origins.test.ts for the law.
    expect(() => normalizeOrigin("not a url///")).toThrow(UnusableOrigin);
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
      audience: "private",
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

describe("what this device calls itself", () => {
  it("defaults to the hostname, and remembers a name it is given", async () => {
    // The name is shown on the approval screen — the one moment somebody is
    // deciding whether to trust this device, and the one moment "which of my
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

describe("which upstream connect was pointed at", () => {
  // Checked without a network, which is the point: the version of this that
  // ran the real command sent a pair request to the live hub on every test
  // run.

  it("uses the reference hub when nobody says otherwise", () => {
    expect(connectTarget([])).toBe(DEFAULT_ORIGIN);
    expect(connectTarget(["--name", "studio-mac"])).toBe(DEFAULT_ORIGIN);
  });

  it("goes where it is pointed, which is what keeps this hostable by others", () => {
    expect(connectTarget(["https://acme.test"])).toBe("https://acme.test");
  });

  it("finds the url on either side of --name", () => {
    // The bug this guard exists for: without checking that `--name` is
    // present, its index arithmetic filters out the *url* instead, and every
    // `connect <url>` quietly goes to the default.
    expect(connectTarget(["https://acme.test", "--name", "box"])).toBe(
      "https://acme.test",
    );
    expect(connectTarget(["--name", "box", "https://acme.test"])).toBe(
      "https://acme.test",
    );
  });

  it("is not fooled by a flag that looks like a url", () => {
    expect(connectTarget(["--verbose"])).toBe(DEFAULT_ORIGIN);
  });
});
