import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateKeys, publicIdentityOf, keyId } from "@byollm/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "./cli.js";
import { IngressLog } from "./ingress.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import { Pairings } from "./pairings.js";
import { noSupervisor, removeTemp } from "./test-support.js";
import { servicePlan } from "./service.js";

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
    // **The loudness obligation.** A kind two services answer gets no default
    // until the owner picks one — correct, and invisible in any surface that
    // lists only what resolved. The failure that makes it matter: an owner
    // adds a second `llm.generate`, jobs that named nothing quietly stop
    // matching, and nothing anywhere says why.
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
    expect(out).toContain("no default");
    expect(out).toContain("llm.generate");
    expect(out).toContain("qwen, llama");
    expect(out).toContain("defaults.llm.generate");

    // And it says what is actually true now, which is the half that went
    // stale when the meaning changed under it. Both services *are* advertised
    // and selectable; what has no answer is a job that named neither. The
    // old sentence — "not offered to anyone until you choose" — described
    // Phase A and survived the change that falsified it.
    expect(out).toContain("a job naming one of them runs");
    expect(out).not.toContain("not offered to anyone");
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

describe("byollm setup, from the command line", () => {
  it("declines when stdin is not a terminal, and exits non-zero", async () => {
    // The command's own contract, exercised through the router rather than
    // through `runSetup` directly — under vitest stdin is not a TTY, which is
    // exactly the pipe case a scripted install would hit.
    const code = await run("setup");
    expect(code).toBe(1);
    expect(err).toContain("needs a terminal");
    // And it wrote nothing, which is the part that matters: a wizard that
    // half-writes a config on refusal leaves a daemon in a state nobody chose.
    await expect(readFile(paths.config, "utf8")).rejects.toThrow();
  });

  it("is listed in help, where somebody would look for it", () => {
    // byollm_015's whole premise is that people should not have to know the
    // config file exists. A command that solves that and is not in `--help`
    // has not solved it.
    return run("--help").then(() => {
      expect(out).toContain("byollm setup");
    });
  });
});

describe("status shows services and defaults, not only routes", () => {
  /**
   * Todd's finding on a real config, and it is a Phase B consequence.
   *
   * `routes` is what *resolved* — one line per kind that has a winner. In
   * Phase A that was the whole story, because a kind had exactly one claimant.
   * It is not the story now: a service can be declared, healthy, and serving
   * nothing this moment because another is the default for its kinds. Listing
   * only routes made that service invisible, so an owner could read their own
   * config, read `status`, and find an entry missing with no line saying why.
   */
  const write = async (config: unknown) => {
    await mkdir(join(home, ".byollm"), { recursive: true });
    await writeFile(paths.config, JSON.stringify(config), "utf8");
  };

  const CONFIG = {
    services: {
      claude: { type: "claude-cli", model: "sonnet", kinds: ["llm.chat"] },
      studio: {
        type: "openai-http",
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "qwen",
        kinds: ["llm.generate"],
        offer: "team",
      },
      spare: {
        type: "openai-http",
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "mistral",
        kinds: ["llm.generate"],
      },
    },
    defaults: { "llm.generate": "studio" },
  };

  it("tells apart the default and the merely selectable", async () => {
    // Two different facts that had one sentence between them. `spare` loses
    // `llm.generate` to the default, and is still a service a site may name —
    // "serves nothing right now" said the opposite of what is true, and "not
    // on the menu" would have been a third wrong answer.
    await write(CONFIG);
    await run("status");
    expect(out).toContain("spare");
    expect(out).toContain("selectable for llm.generate");
    expect(out).toMatch(/studio[\s\S]*?default for llm\.generate/);
    expect(out).not.toContain("serves nothing");
  });

  it("says what a scope means beside the word for it", async () => {
    // "offered to private" asks the reader to already know. The config's word
    // stays, because the card and the file should read alike, and the
    // consequence sits next to it.
    await write(CONFIG);
    await run("status");
    expect(out).toContain("private (only you)");
    expect(out).toContain("team (you and people you allow)");
  });

  it("says the default once, on the service that is it", async () => {
    // There was a separate `defaults` section for about an hour. It printed
    // `llm.generate → studio` beside a service line already reading
    // `studio — default for llm.generate`: the same fact twice, which is the
    // criticism that removed `routes` the same afternoon. A display that
    // restates itself is two things to keep in step, and only one gets
    // updated.
    await write(CONFIG);
    await run("status");
    expect(out).toMatch(/studio[\s\S]*?default for llm\.generate/);
    expect(out).not.toMatch(/^defaults$/m);
  });

  it("has no routes section, because it said nothing the rest did not", async () => {
    // Ruled 2026-08-25. `routes` was the old shape's ghost: one line per
    // resolved kind, which in Phase A *was* the service list. By Phase B it
    // was a third section describing facts the first two carry — a route is a
    // (service, kind) pair plus which is default, and both are above. Three
    // displays of two facts is how they drift.
    await write(CONFIG);
    await run("status");
    expect(out).not.toMatch(/^routes$/m);
    // The information did not go with it. The model and the backend are on
    // separate lines now — a service line that read
    // `openai-http:mlx-community/Qwen2.5-14B-Instruct-4bit  team (…)` wrapped
    // at any sane width, and a wrapped line in a column layout stops being a
    // column.
    expect(out).toContain("qwen");
    expect(out).toContain("(openai-http)");
    expect(out).toContain("llm.generate");
  });
});

describe("byollm services speaks for the shell, not the daemon", () => {
  /**
   * The wording change that cost a morning to earn.
   *
   * It said "healthy and will be advertised" — a promise only the daemon can
   * make. On the machine that produced this, it was false: the daemon runs
   * under launchd with launchd's PATH, `claude` lives in `~/.local/bin`, so a
   * probe from the shell found the CLI and the daemon could not execute it.
   * The device advertised nothing, and the surface somebody turns to for "why"
   * was the one lying.
   *
   * PATH is fixed at install now, but it is one divergence among many — a
   * different user, a different HOME, a credential a login shell can see and a
   * background agent cannot. So the command stops claiming to know.
   */
  it("does not promise what the daemon will advertise", async () => {
    await run("services");
    expect(out).toContain("from this shell");
    expect(out).not.toContain("will be advertised");
  });

  it("warns about the divergence when a service is installed", async () => {
    // The unit path comes from the same plan `install` writes, rather than
    // being spelled again here — a test that guesses the location tests its
    // own guess. `servicePlan` is exported for exactly this.
    const service = { ...noSupervisor(), platform: "darwin" as const, home };
    const plan = servicePlan({
      platform: "darwin",
      execPath: service.execPath,
      scriptPath: service.scriptPath,
      home,
      root: paths.root,
    });
    await mkdir(dirname(plan.unitPath), { recursive: true });
    await writeFile(plan.unitPath, "", "utf8");

    await runCli(["services"], { paths, io: io(), service });
    expect(out).toContain("your shell's view");
    expect(out).toContain("byollm uninstall && byollm install");
  });

  it("says nothing about it when no service is installed", async () => {
    // The control. A warning on every invocation is a warning nobody reads,
    // and somebody running the daemon in a terminal has no divergence to warn
    // about — their shell *is* the daemon's environment.
    await run("services");
    expect(out).not.toContain("your shell's view");
  });
});

describe("a device that is running and invisible", () => {
  /**
   * `state: running` was true for hours while every heartbeat this device
   * sent was refused. The daemon was running; it was also reporting nothing,
   * invisible to the hub, and its page showed data frozen before the upgrade.
   * The only surface that knew was a log line nobody tails, and the visible
   * symptom was one missing chip on a card.
   *
   * A persistent rejection is a state, not a louder log. One refusal is a
   * rolling deploy; forty in a row is a device that has stopped participating
   * and does not know it — and only a count tells those apart.
   */
  const health = async (record: unknown) => {
    await mkdir(join(home, ".byollm"), { recursive: true });
    await writeFile(join(home, "health.json"), JSON.stringify(record), "utf8");
  };

  it("leads with it, rather than saying running", async () => {
    await health({
      at: Date.now(),
      consecutiveFailures: 47,
      lastError: "request failed schema validation",
      origin: "https://hub.test",
    });
    await run("status");
    expect(out).toContain("NOT REPORTING");
    expect(out).not.toMatch(/^state: running$/m);
    expect(out).toContain("47");
    expect(out).toContain("request failed schema validation");
  });

  it("warns that everything below is unreported belief", async () => {
    // The line that matters most. Without it a reader sees NOT REPORTING and
    // then a healthy-looking service list, and takes the second as evidence
    // against the first — when the list is exactly what the hub has *not*
    // been told.
    await health({ at: Date.now(), consecutiveFailures: 20 });
    await run("status");
    expect(out).toContain("not what the hub has been told");
  });

  it("says nothing about a handful of failures", async () => {
    // One refusal is noise, and a warning on every blip is a warning nobody
    // reads. The threshold is the whole difference between a state and a log.
    await health({ at: Date.now(), consecutiveFailures: 2 });
    await run("status");
    expect(out).toMatch(/^state: running$/m);
    expect(out).not.toContain("NOT REPORTING");
  });

  it("says running when the daemon has never recorded anything", async () => {
    // No file is not "healthy" — it is "this daemon has not said", which is
    // also the state of one that predates the file. Both read as running,
    // which is the honest collapse: nothing here claims otherwise.
    await run("status");
    expect(out).toMatch(/^state: running$/m);
  });

  it("keeps PAUSED ahead of it, because a pause is a decision", async () => {
    // Somebody who paused their device does not need to be told it is not
    // reporting. They know; they did it.
    await health({ at: Date.now(), consecutiveFailures: 99 });
    await run("pause");
    await run("status");
    expect(out).toContain("PAUSED");
    expect(out).not.toContain("NOT REPORTING");
  });
});

describe("offering a cloud-tagged service to a team", () => {
  /**
   * Todd ran `byollm offer glm-5.2 team --cap 2500`, was told "glm-5.2 is now
   * offered to team", and `byollm status` then showed it narrowed back with a
   * problem line telling him to run the command he had just run.
   *
   * `resolveCost` reads a backend id, a base URL and a model. This command
   * passed two of the three; `resolveConfig` passed all three. So for
   * `glm-5.2:cloud` on `http://127.0.0.1:11434/v1` the command saw a loopback
   * address and called it free — no consent needed, no spend block written —
   * while the daemon saw the `:cloud` tag, called it metered, found no
   * consent, and narrowed it. Both were right about what they were asked.
   *
   * Two implementations of one rule, arriving through a signature.
   */
  const cloudService = {
    services: {
      "glm-5.2": {
        type: "openai-http",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "glm-5.2:cloud",
        kinds: ["llm.generate"],
      },
    },
  };

  const write = async (config: unknown) => {
    await mkdir(join(home, ".byollm"), { recursive: true });
    await writeFile(paths.config, JSON.stringify(config), "utf8");
  };

  const service = async () =>
    (
      JSON.parse(await readFile(paths.config, "utf8")) as {
        services: Record<
          string,
          { offer?: string; spend?: Record<string, unknown> }
        >;
      }
    ).services["glm-5.2"];

  it("treats a cloud tag as metered even on a loopback address", async () => {
    // The tag means the work leaves this machine, whatever the address says.
    // Widening a metered service needs an explicit yes, so refusing without
    // one is the proof this command now reads the same cost the daemon does.
    await write(cloudService);
    confirmAnswer = false;
    await run("offer", "glm-5.2", "team", "--cap", "2500");
    // Asserted on the config rather than the exit code: declining is a
    // choice, not an error, and the command exits 0 either way. What must be
    // true is that nothing was widened — and before this fix the command
    // never asked, because it believed the service was free.
    expect((await service())?.offer).not.toBe("team");
    expect(confirmQuestions.length).toBeGreaterThan(0);
  });

  it("records the consent and the ceiling when the owner agrees", async () => {
    // The half that was silently missing: `--cap` went nowhere, so the config
    // said `offer: "team"` with no spend block at all — a state the daemon
    // must refuse, and did.
    await write(cloudService);
    confirmAnswer = true;
    const code = await run("offer", "glm-5.2", "team", "--cap", "2500");
    expect(code).toBe(0);
    const written = await service();
    expect(written?.offer).toBe("team");
    expect(written?.spend?.["acknowledged"]).toBe(true);
    expect(written?.spend?.["dailyCapCents"]).toBe(2500);
  });

  it("survives the round trip the first attempt failed", async () => {
    // The whole bug, end to end: offer it, then load it, and it is still
    // shared. Previously this is exactly where it snapped back.
    await write(cloudService);
    confirmAnswer = true;
    await run("offer", "glm-5.2", "team", "--cap", "2500");
    out = "";
    await run("status");
    expect(out).toContain("team (you and people you allow)");
    expect(out).not.toContain("was narrowed to");
  });

  it("says private, not self, when it does narrow", async () => {
    // The message survived the alpha.44 rename: it told a reader about a
    // scope named `self` in a build whose scopes are private, team, public.
    await write(cloudService);
    await run("offer", "glm-5.2", "team");
    out = "";
    await run("status");
    if (out.includes("was narrowed")) {
      expect(out).toContain('narrowed to "private"');
      expect(out).not.toContain('narrowed to "self"');
    }
  });
});
