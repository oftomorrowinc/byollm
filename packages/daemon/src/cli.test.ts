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

describe("byollm status — what it says about sharing", () => {
  it("names the offer that took effect, not the one in the file", async () => {
    // The same defect `services` had, on the other surface. This line read
    // `service.offer`, so a metered service asked to be shared — and narrowed
    // straight back to `private` for want of a spend acknowledgment — printed
    // "team (you and people you allow)" while refusing every one of them.
    //
    // A status surface declares whose knowledge it shows. This one shows the
    // daemon's, and the daemon narrowed it.
    await writeFile(
      paths.config,
      JSON.stringify({
        services: {
          paid: {
            model: "gpt-4o",
            kinds: ["llm.generate"],
            type: "openai",
            offer: "team",
          },
        },
      }),
    );

    expect(await run("status")).toBe(0);
    expect(out).toContain("private (only you)");
    expect(out).toContain("narrowed from team");
    expect(out).not.toContain("team (you and people you allow)");
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

  it("refuses someone who was never allowed, rather than doing nothing", async () => {
    /**
     * `disallow` used to remove an allow entry and report "nothing changed"
     * when there was none. Under Amendment G it also records a veto, and a
     * veto needs no entry to exist first — the case it is *for* is a roster
     * member this device has no local row for at all.
     *
     * Reporting "nothing changed" about a veto it had just written would be
     * the flattering-copy bug in the sentence about who may use somebody's
     * computer.
     */
    await run("disallow", "https://app.test", "nobody");
    expect(out).toContain("is now refused");

    out = "";
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
      audience: "team",
      owner: "stranger",
      backendId: "openai-http",
      backendClass: "http",
      model: "gemma4:26b",
      prompt: "summarise the thing",
    });

    expect(await run("log")).toBe(0);
    expect(out).toContain("team");
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
      audience: "team",
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

  it("says who each service is offered to", async () => {
    // The question `byollm services` could not answer. On 2026-08-26 "is
    // anything on this machine offered publicly?" had to be answered by
    // reading config.json, because this command printed the kind, the
    // service, the backend, the model, the address and who pays — and left
    // out who it is shared with.
    await writeFile(
      paths.config,
      JSON.stringify({
        services: {
          mine: {
            model: "qwen3",
            kinds: ["llm.generate"],
            type: "openai-http",
            baseUrl: "http://127.0.0.1:1/v1",
            offer: "private",
          },
          shared: {
            model: "llama3.2",
            kinds: ["llm.chat"],
            type: "openai-http",
            baseUrl: "http://127.0.0.1:2/v1",
            offer: "team",
          },
        },
      }),
    );

    await run("services");

    expect(out).toContain("offered to: you only");
    expect(out).toContain("offered to: you and the people you allow");
  });

  it("says the offer that took effect, not the one that was asked for", async () => {
    // A metered service asked to be shared without a spend acknowledgment is
    // narrowed to `private` — correct, and previously invisible here: the
    // line read from `service.offer`, so it reported the request as though it
    // were the state, and a service shared with nobody printed as shared.
    await writeFile(
      paths.config,
      JSON.stringify({
        services: {
          paid: {
            model: "gpt-4o",
            kinds: ["llm.generate"],
            type: "openai",
            offer: "team",
          },
        },
      }),
    );

    await run("services");

    expect(out).toContain("offered to: you only");
    expect(out).toContain("narrowed from team");
    // Never the un-narrowed claim on its own.
    expect(out).not.toContain("offered to: you and the people you allow");
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

  it("no longer claims team is local-allowlist, because it is not", async () => {
    /**
     * Retired with the release that made its opposite true — Amendment G, B2.
     *
     * This notice was correct for every build that carried it: `team` was
     * named for central membership and enforced through the same per-person
     * list `named` used, so the name ran ahead of its behaviour and said so
     * where the name is written.
     *
     * It is gone rather than reworded because the fact it reported stopped
     * being a fact about the build. Which authority decides is now a property
     * of each *pairing* — a roster where one is held, the local list where no
     * control-plane key was ever pinned — and this code cannot see pairings.
     * `byollm status` can, and says so per pairing.
     *
     * Asserted as an absence, which is the only way to check that a sentence
     * stopped being told.
     */
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
    expect(out).not.toContain("team enforcement is local-allowlist");
    expect(out).not.toContain("roster sync lands next");
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

describe("connect when already paired", () => {
  /**
   * `connect` mints a code, prints it and polls for ten minutes. Todd ran it
   * while already paired, read the docs, and typed the code after it had
   * expired — a failure that was entirely avoidable, because he did not need
   * to pair at all.
   *
   * It informs rather than refuses: re-pairing is sometimes exactly right,
   * and it is how a device that predates roster sync gets the control-plane
   * key. So it answers the question somebody is actually asking.
   */
  const alreadyPaired = async (extra: Record<string, unknown> = {}) => {
    await mkdir(home, { recursive: true });
    await writeFile(
      paths.pairings,
      JSON.stringify({
        version: 1,
        pairings: [
          {
            origin: "https://hub.test",
            runnerId: "r1",
            owner: "alice",
            sites: {},
            pairedAt: 1_800_000_000_000,
            ...extra,
          },
        ],
      }),
      "utf8",
    );
  };

  it("says so, and does nothing when the answer is no", async () => {
    await alreadyPaired();
    confirmAnswer = false;
    expect(await run("connect", "https://hub.test")).toBe(0);
    expect(out).toContain("already paired with https://hub.test");
    expect(out).toContain("Nothing changed");
    // No code was minted, which is the point — the ceremony never started.
    expect(out).not.toMatch(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
  });

  it("says re-pairing is how a keyless pairing gets a key", async () => {
    // The one reason to say yes, named where the decision is made.
    await alreadyPaired();
    confirmAnswer = false;
    await run("connect", "https://hub.test");
    expect(out).toContain("holds no control-plane key");
    expect(out).toContain("Re-pairing is how it gets one");
  });

  it("says re-pairing changes nothing when a key is already held", async () => {
    await alreadyPaired({ controlPlanePublic: "some-key" });
    confirmAnswer = false;
    await run("connect", "https://hub.test");
    expect(out).toContain("already holds a control-plane key");
    expect(out).toContain("will not change that");
  });
});

describe("refusing to offer, and in what order", () => {
  /**
   * `byollm offer my-claude team --cap 2500` used to answer:
   *
   *   --cap sets a daily spend ceiling, and my-claude is subscription-class,
   *   so sharing it costs you nothing.
   *   Drop --cap, or offer a metered service to a wider scope.
   *
   * Three defects in four lines. It leads with the flag, whose premise is
   * that sharing is possible; drop the flag and re-run, and only then does it
   * say the service cannot be offered at all. It says "subscription-class",
   * which is this codebase's vocabulary on somebody else's screen. And the
   * message that finally arrives names "Claude CLI (your subscription)" — a
   * registry label — rather than the service the owner typed.
   */
  const write = async (config: unknown) => {
    await mkdir(join(home, ".byollm"), { recursive: true });
    await writeFile(paths.config, JSON.stringify(config), "utf8");
  };

  /**
   * Assert on what a message says, not on where it wraps.
   *
   * These messages are wrapped to a terminal width, so a phrase can be split
   * across a newline — "runs on this\nmachine". A test that matched the raw
   * string would fail on a re-wrap and pass on a rewrite, which is exactly
   * backwards from what it is for.
   */
  const said = () => err.replace(/\s+/g, " ");

  const SUBSCRIPTION = {
    services: {
      "my-claude": {
        type: "claude-cli",
        model: "opus",
        kinds: ["llm.generate"],
      },
    },
  };
  const FREE = {
    services: {
      "my-ollama": {
        type: "ollama",
        model: "llama3.2",
        kinds: ["llm.generate"],
      },
    },
  };

  it("leads with the fact that cannot be fixed, not the flag that can", async () => {
    // The ordering rule: a fixable detail never precedes an unfixable fact.
    // Dropping --cap is an edit somebody can make; a subscription's terms are
    // not something they can negotiate, so leading with the flag buries the
    // answer behind an errand.
    await write(SUBSCRIPTION);
    const code = await run("offer", "my-claude", "team", "--cap", "2500");
    expect(code).toBe(1);
    expect(said()).toContain("cannot be offered to other people");
    expect(said()).not.toContain("--cap");
  });

  it("names the service the owner typed, and the product once", async () => {
    await write(SUBSCRIPTION);
    await run("offer", "my-claude", "team", "--cap", "2500");
    expect(said()).toContain("my-claude");
    // The registry label is "Claude CLI (your subscription)", which inside a
    // sentence that already says "a subscription" reads as a stutter. Prose
    // gets the product's name; the sentence carries the meaning.
    expect(said()).not.toContain("(your subscription)");
    expect(said()).toContain("Claude CLI");
  });

  it("says what the class means, never what it is called", async () => {
    // Minted as a rule: class vocabulary stays off user surfaces. Nobody's
    // mental model has classes in it.
    await write(FREE);
    const code = await run("offer", "my-ollama", "team", "--cap", "2500");
    expect(code).toBe(2);
    expect(said()).toContain("runs on this machine");
    for (const jargon of [
      "free-class",
      "subscription-class",
      "metered-class",
    ]) {
      expect(said(), jargon).not.toContain(jargon);
    }
  });

  it("ends with a line that can be pasted", async () => {
    await write(FREE);
    await run("offer", "my-ollama", "team", "--cap", "2500");
    expect(said()).toContain("`byollm offer my-ollama team`");
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

  it("asks about the service the owner named, not the registry's label", async () => {
    /**
     * The ceremony read: "This lets other people's jobs run on Any
     * OpenAI-compatible endpoint — it bills your account per token." Todd was
     * being asked to consent to a category. The service he was sharing has a
     * name, a model and an address, and none of the three appeared.
     *
     * Consent is to a specific thing or it is not consent.
     */
    await write(cloudService);
    confirmAnswer = false;
    await run("offer", "glm-5.2", "team", "--cap", "2500");
    const asked = confirmQuestions.join("\n");
    expect(asked).toContain("glm-5.2");
    expect(asked).toContain("glm-5.2:cloud");
    expect(asked).toContain("http://127.0.0.1:11434/v1");
    // The label of the transport that happens to carry it is not the subject.
    expect(asked).not.toContain("Any OpenAI-compatible");
  });

  it("states the rule that actually fired, not the one the label implies", async () => {
    // `openai-http` has no declared cost — it was classified metered by the
    // `:cloud` tag on the model. A reader told "it bills per token" would go
    // looking for a bill from the wrong account.
    await write(cloudService);
    confirmAnswer = false;
    await run("offer", "glm-5.2", "team", "--cap", "2500");
    const asked = confirmQuestions.join("\n");
    expect(asked).toContain(":cloud");
    expect(asked).toContain("cloud account");
  });

  it("keeps the ceiling sentence, and the amount in it", async () => {
    // The one part of the ceremony that was already exactly right. It says
    // what recurs and when it stops, which is the thing being consented to.
    await write(cloudService);
    confirmAnswer = false;
    await run("offer", "glm-5.2", "team", "--cap", "2500");
    const asked = confirmQuestions.join("\n");
    expect(asked).toContain("$25.00 a day");
    expect(asked).toContain("until you change it");
  });

  it("wraps the ceremony narrow enough for a terminal to leave alone", async () => {
    // The reason is assembled from a rule, so it cannot be hard-wrapped where
    // it is written — unwrapped it ran past 150 columns, where the terminal
    // breaks it mid-word and the reader skims. A consent nobody reads is not
    // one anybody gave.
    await write(cloudService);
    confirmAnswer = false;
    await run("offer", "glm-5.2", "team", "--cap", "2500");
    for (const line of confirmQuestions.join("\n").split("\n")) {
      expect(line.length, line).toBeLessThanOrEqual(72);
    }
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
