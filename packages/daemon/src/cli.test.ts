import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeys, publicIdentityOf, keyId } from "@byollm/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "./cli.js";
import { IngressLog } from "./ingress.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import { Pairings } from "./pairings.js";
import { noSupervisor, removeTemp } from "./test-support.js";

const SITE = publicIdentityOf(generateKeys(1_800_000_000_000));

/**
 * The CLI is the trust surface, so it is tested like one.
 *
 * These drive the real commands against a temporary `BYOLLM_HOME` and assert
 * what a user would actually see — including the cases byollm_002 singles
 * out: four different truths never sharing a message, zero never looking like
 * unknown, and widening access never happening without an explicit yes.
 */

let home: string;
let paths: DaemonPaths;
let out: string;
let err: string;
let confirmAnswer: boolean;
let confirmQuestions: string[];

function io(): Partial<CliIo> {
  return {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    confirm: (question) => {
      confirmQuestions.push(question);
      return Promise.resolve(confirmAnswer);
    },
  };
}

const run = (...argv: string[]) =>
  runCli(argv, { paths, io: io(), service: noSupervisor() });

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "byollm-cli-"));
  paths = daemonPaths(home);
  out = "";
  err = "";
  confirmAnswer = true;
  confirmQuestions = [];
});

afterEach(async () => {
  await removeTemp(home);
});

/** A config pointing at a backend that is definitely not running. */
async function writeConfig(): Promise<void> {
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
}

describe("byollm — usage", () => {
  it.each([[], ["help"], ["--help"], ["-h"]])(
    "prints usage for %s",
    async (...argv) => {
      expect(await run(...(argv as string[]))).toBe(0);
      expect(out).toContain("byollm connect");
      expect(out).toContain("byollm log");
    },
  );

  it("prints a version", async () => {
    expect(await run("--version")).toBe(0);
    expect(out.trim()).not.toBe("");
  });

  it("rejects an unknown command with usage and exit 2", async () => {
    expect(await run("frobnicate")).toBe(2);
    expect(err).toContain("unknown command: frobnicate");
  });
});

describe("byollm pause / resume", () => {
  it("pauses, reports it, and resumes", async () => {
    expect(await run("pause")).toBe(0);
    expect(out).toContain("paused");

    out = "";
    expect(await run("status")).toBe(0);
    expect(out).toContain("PAUSED");

    out = "";
    expect(await run("resume")).toBe(0);
    expect(out).toContain("resumed");

    out = "";
    await run("status");
    expect(out).toContain("running");
    expect(out).not.toContain("PAUSED");
  });
});

describe("byollm allow — widening access", () => {
  it("says nobody can use the machine when the list is empty", async () => {
    expect(await run("allow", "--list")).toBe(0);
    // Zero must not look like unknown: an empty list says so in words.
    expect(out).toContain("Nobody but you");
  });

  it("names what widening means before doing it", async () => {
    expect(await run("allow", "https://app.test", "alice")).toBe(0);
    expect(confirmQuestions).toHaveLength(1);
    const question = confirmQuestions[0] ?? "";
    expect(question).toContain("your hardware");
    expect(question).toContain("subscription-backed models are never included");
  });

  it("changes nothing when the answer is no", async () => {
    confirmAnswer = false;
    expect(await run("allow", "https://app.test", "alice")).toBe(0);
    expect(out).toContain("nothing changed");

    out = "";
    await run("allow", "--list");
    expect(out).toContain("Nobody but you");
  });

  it("adds, lists and removes an entry", async () => {
    await run("allow", "https://app.test", "alice", "a", "friend");
    out = "";
    await run("allow", "--list");
    expect(out).toContain("alice");
    expect(out).toContain("https://app.test");
    expect(out).toContain("a friend");

    out = "";
    expect(await run("disallow", "https://app.test", "alice")).toBe(0);
    expect(out).toContain("can no longer use this device");

    out = "";
    await run("allow", "--list");
    expect(out).toContain("Nobody but you");
  });

  it("says so plainly when removing someone who was never allowed", async () => {
    await run("disallow", "https://app.test", "nobody");
    expect(out).toContain("nothing changed");
  });

  it("refuses malformed arguments with exit 2", async () => {
    expect(await run("allow", "https://app.test")).toBe(2);
    expect(err).toContain("usage:");
    expect(await run("disallow", "https://app.test")).toBe(2);
  });
});

describe("byollm status", () => {
  it("says there are no paired apps rather than printing nothing", async () => {
    expect(await run("status")).toBe(0);
    expect(out).toContain("byollm connect");
    expect(out).toContain("nobody else");
  });

  it("lists a paired app and its owner", async () => {
    const pairings = new Pairings(paths.pairings);
    await pairings.load();
    await pairings.put({
      origin: "https://app.test",
      runnerId: "runner_1",
      owner: "alice",
      sites: { [keyId(SITE.identity)]: SITE },
      pairedAt: Date.now(),
    });

    await run("status");
    expect(out).toContain("https://app.test");
    expect(out).toContain("alice");
  });

  it("reports a route whose backend cannot be reached as a problem", async () => {
    await writeFile(
      paths.config,
      JSON.stringify({
        services: {
          ghost: { model: "m", kinds: ["llm.generate"], type: "openai-http" },
        },
      }),
    );
    await run("status");
    expect(out).toContain("baseUrl");
  });
});

describe("byollm log", () => {
  it("says nothing has run rather than printing an empty list", async () => {
    expect(await run("log")).toBe(0);
    expect(out).toContain("nothing has run on this device yet");
  });

  it("shows a prompt, its audience and where it came from", async () => {
    const log = new IngressLog({
      path: paths.ingressLog,
      communityPromptDays: 7,
      keepSelfPrompts: true,
    });
    await log.recordPrompt({
      at: Date.now(),
      origin: "https://app.test",
      jobId: "job_1",
      kind: "llm.generate",
      audience: "public",
      owner: "stranger",
      backendId: "openai-http",
      backendClass: "http",
      model: "gemma4:26b",
      prompt: "summarise the thing",
    });

    expect(await run("log")).toBe(0);
    expect(out).toContain("public");
    expect(out).toContain("stranger");
    expect(out).toContain("summarise the thing");
  });

  it("distinguishes a dropped prompt from an empty one", async () => {
    const log = new IngressLog({
      path: paths.ingressLog,
      communityPromptDays: 7,
      keepSelfPrompts: false,
    });
    await log.recordPrompt({
      at: Date.now(),
      origin: "https://app.test",
      jobId: "job_1",
      kind: "llm.generate",
      audience: "private",
      owner: "me",
      backendId: "openai-http",
      backendClass: "http",
      model: "m",
      prompt: "private",
    });

    await run("log");
    // Retention removed the text. A blank line would read as "empty prompt".
    expect(out).toContain("prompt not retained");
    expect(out).toContain("sha256");
  });

  it("strips control characters from a hostile prompt before printing [OUTPUT_INERT]", async () => {
    const log = new IngressLog({
      path: paths.ingressLog,
      communityPromptDays: 7,
      keepSelfPrompts: true,
    });
    await log.recordPrompt({
      at: Date.now(),
      origin: "https://app.test",
      jobId: "job_1",
      kind: "llm.generate",
      audience: "public",
      owner: "stranger",
      backendId: "openai-http",
      backendClass: "http",
      model: "m",
      prompt: "\u001b[2Jharmless\u0007",
    });

    await run("log", "--full");
    // The stored bytes stay verbatim; only the display is sanitised.
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("\u0007");
    expect(out).toContain("harmless");
    const raw = await readFile(paths.ingressLog, "utf8");
    expect(raw).toContain("\\u001b");
  });

  it("honours -n", async () => {
    const log = new IngressLog({
      path: paths.ingressLog,
      communityPromptDays: 7,
      keepSelfPrompts: true,
    });
    for (let i = 0; i < 5; i += 1) {
      await log.recordOutcome({
        at: Date.now() + i,
        jobId: `job_${String(i)}`,
        outcome: "ok",
        durationMs: 1,
        outputChars: 1,
      });
    }
    await run("log", "-n", "2");
    expect(out).toContain("job_4");
    expect(out).not.toContain("job_0");
  });
});

describe("byollm services", () => {
  it("reports an unreachable backend as not advertised, and exits 1", async () => {
    await writeConfig();
    // The daemon never advertises what it cannot actually run.
    expect(await run("services")).toBe(1);
    expect(out).toContain("llm.generate");
    expect(out).toContain("0 of 1 services are");
    expect(out).toContain("not advertise what it cannot actually run");
  });

  it("shows a withheld kind by name, never merely omits it", async () => {
    // **The loudness obligation.** A kind two services answer is not
    // advertised until the owner picks a default — correct, and invisible in
    // any surface that lists only what *is* advertised. The failure that
    // makes it matter: an owner adds a second `llm.generate`, their team's
    // jobs quietly stop matching, and nothing anywhere says why.
    await writeFile(
      paths.config,
      JSON.stringify({
        services: {
          qwen: {
            model: "qwen3",
            kinds: ["llm.generate"],
            type: "openai-http",
            baseUrl: "http://127.0.0.1:1/v1",
          },
          llama: {
            model: "llama3.2",
            kinds: ["llm.generate"],
            type: "openai-http",
            baseUrl: "http://127.0.0.1:2/v1",
          },
        },
      }),
    );

    await run("services");

    // Named, with both claimants and the fix — not absent, and not a count.
    expect(out).toContain("withheld");
    expect(out).toContain("llm.generate");
    expect(out).toContain("qwen, llama");
    expect(out).toContain("defaults.llm.generate");
    expect(out).toContain("not offered to anyone until you choose");
  });

  it("says team enforcement is still the local allowlist in this build", async () => {
    // The build describes its own limitation where the owner is looking. A
    // value named for central membership, enforced by a local list, has to say
    // so in the place the name is written — release notes are not where
    // somebody is standing when they type `"offer": "team"` and conclude their
    // roster is now in force.
    await writeFile(
      paths.config,
      JSON.stringify({
        services: {
          qwen: {
            model: "qwen3",
            kinds: ["llm.generate"],
            type: "openai-http",
            baseUrl: "http://127.0.0.1:1/v1",
            offer: "team",
          },
        },
      }),
    );

    await run("services");
    expect(out).toContain("team enforcement is local-allowlist in this build");
    expect(out).toContain("roster sync lands next");
  });

  it("says nothing about team when no service offers it", async () => {
    // The control: a notice printed unconditionally would pass the case above
    // and tell a private-only owner about a limitation that cannot reach them.
    await writeConfig();
    await run("services");
    expect(out).not.toContain("team enforcement");
  });

  it("stops saying withheld once a default resolves it", async () => {
    // The control: a surface that always said "withheld" would pass the case
    // above while telling the owner nothing.
    await writeFile(
      paths.config,
      JSON.stringify({
        services: {
          qwen: {
            model: "qwen3",
            kinds: ["llm.generate"],
            type: "openai-http",
            baseUrl: "http://127.0.0.1:1/v1",
          },
          llama: {
            model: "llama3.2",
            kinds: ["llm.generate"],
            type: "openai-http",
            baseUrl: "http://127.0.0.1:2/v1",
          },
        },
        defaults: { "llm.generate": "qwen" },
      }),
    );

    await run("services");
    expect(out).not.toContain("withheld");
    expect(out).toContain("qwen");
  });
});

describe("byollm forget", () => {
  it("forgets a pairing and says the app may still list it", async () => {
    const pairings = new Pairings(paths.pairings);
    await pairings.load();
    await pairings.put({
      origin: "https://app.test",
      runnerId: "runner_1",
      owner: "alice",
      sites: { [keyId(SITE.identity)]: SITE },
      pairedAt: Date.now(),
    });

    expect(await run("forget", "https://app.test")).toBe(0);
    expect(out).toContain("revoke it there too");

    out = "";
    await run("forget", "https://app.test");
    expect(out).toContain("not paired with");
  });

  it("refuses without a url", async () => {
    expect(await run("forget")).toBe(2);
  });
});

describe("byollm run", () => {
  it("says to connect first when nothing is paired", async () => {
    expect(await run("run")).toBe(2);
    expect(err).toContain("byollm connect");
  });
});
