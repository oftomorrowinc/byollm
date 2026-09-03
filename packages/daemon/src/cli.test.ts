import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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
    expect(out).not.toContain("team (you and the people your relay admits)");
  });
});

describe("the allowlist file, retired out loud", () => {
  /**
   * A file full of names this device used to honour and now ignores is the
   * worst state to leave quietly: the entries sit on disk reading like
   * grants, and whoever wrote them has no way to learn they stopped meaning
   * anything. Pre-1.0 gives us the liberty to delete the machinery; it does
   * not give us the liberty to delete it silently.
   */
  const withAllowlist = async () =>
    writeFile(
      paths.allowlist,
      JSON.stringify({
        version: 1,
        entries: [
          { origin: "https://app.test", owner: "alice", addedAt: 1 },
          { origin: "https://app.test", owner: "carol", addedAt: 2 },
        ],
      }),
    );

  it("names the people whose access ended, and where to restore it", async () => {
    // Names, not a count. "2 entries were retired" is a number; the point of
    // the notice is that somebody recognises a name and knows where to go.
    await withAllowlist();
    expect(await run("status")).toBe(0);
    expect(out).toContain("alice");
    expect(out).toContain("carol");
    expect(out).toContain("team page");
  });

  it("removes the file, and says nothing the second time", async () => {
    await withAllowlist();
    await run("status");
    await expect(readFile(paths.allowlist, "utf8")).rejects.toThrow();

    out = "";
    await run("status");
    expect(out).not.toContain("no longer allowed here");
  });

  it("retires an unreadable file too, rather than skipping it", async () => {
    // The file goes either way. Saying so without a list is better than
    // saying nothing because a parse failed — the machinery is gone whether
    // or not we can read what was in it.
    await writeFile(paths.allowlist, "{ not json");
    await run("status");
    expect(out).toContain("used to keep its own list");
    await expect(readFile(paths.allowlist, "utf8")).rejects.toThrow();
  });

  it("says nothing at all when there was never a list", async () => {
    // The half of the pair that is easy not to write. A device that never
    // had an allowlist must not be told about one.
    expect(await run("status")).toBe(0);
    expect(out).not.toContain("used to keep its own list");
  });
});

describe("byollm allow / disallow — the tombstones", () => {
  /**
   * Both commands were deleted (byollm_016 Amendments I and J). Their tests
   * went with them — a test for machinery that no longer exists is a
   * `.skip` graveyard with extra steps.
   *
   * What replaces them is a test of the *refusal*, because a tombstone is a
   * product surface: somebody's fingers still know these commands, and an
   * "unknown command" would send them looking for a typo instead of telling
   * them where the capability went.
   */
  it.each(["allow", "disallow"] as const)(
    "%s refuses with exit 2 and names where membership lives now",
    async (command) => {
      expect(await run(command, "https://app.test", "alice")).toBe(2);
      expect(err).toContain("is gone");
      expect(err).toContain("team page");
      // Never a bare rejection. A refusal that does not say what to do
      // instead is a dead end wearing a helpful tone.
      expect(err).not.toContain("unknown command");
    },
  );

  it("says why the list could not have worked, not just that it is gone", async () => {
    // The reason is the whole point. A device cannot verify a foreign site's
    // user identities, so the list only ever agreed with whoever was asking —
    // and somebody who does not know that will go looking for the setting
    // that replaced it.
    await run("allow", "https://app.test", "alice");
    expect(err).toContain("could never check the names");
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

    // Both narrow to "only you" here, and for different reasons — which is
    // the point of printing the reason. `mine` asked for private; `shared`
    // asked for team and got narrowed, because this device is paired with
    // nothing and so has no relay that could admit anybody.
    expect(out).toContain("offered to only you");
    expect(out).toContain("no relay paired");
    expect(out).not.toContain(
      "offered to you and the people your relay admits",
    );
  });

  it("says a team service is shared once a relay is paired to admit for it", async () => {
    // The other half. The narrowing above is not a permanent property of a
    // `team` offer — it is what `team` means with nobody to ask.
    await writeFile(
      paths.pairings,
      JSON.stringify({
        version: 1,
        pairings: [
          {
            origin: "https://relay.test",
            runnerId: "runner_1",
            owner: "me",
            sites: {},
            controlPlanePublic: "a-pinned-control-plane-key",
            pairedAt: Date.now(),
          },
        ],
      }),
    );
    await writeFile(
      paths.config,
      JSON.stringify({
        services: {
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

    expect(out).toContain("offered to you and the people your relay admits");
    expect(out).not.toContain("no relay paired");
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

    expect(out).toContain("offered to only you");
    expect(out).toContain("narrowed from team");
    // Never the un-narrowed claim on its own.
    expect(out).not.toContain(
      "offered to you and the people your relay admits",
    );
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

  it("says what each service answers, and which one is yours by default", async () => {
    // Two different facts that had one sentence between them. `spare` answers
    // `llm.generate` — a mapping may point at it, and "serves nothing right
    // now" said the opposite of what is true — while `studio` is additionally
    // where the owner's *own* unresolved work goes.
    //
    // "selectable for" lived here until Amendment L, meaning a site could
    // name it. No site names anything now, so the word described a power
    // nobody has.
    await write(CONFIG);
    await run("status");
    expect(out).toMatch(/spare[\s\S]*?answers llm\.generate/);
    expect(out).toMatch(/studio[\s\S]*?your default for llm\.generate/);
    expect(out).not.toContain("selectable for");
    expect(out).not.toContain("serves nothing");
  });

  it("says what a scope means beside the word for it", async () => {
    // "offered to private" asks the reader to already know. The config's word
    // stays, because the card and the file should read alike, and the
    // consequence sits next to it.
    //
    // This machine is paired with nothing, so the `team` service narrows to
    // `private` and says why — which is the direct-mode ruling on screen
    // (2026-08-26). A device with no relay has nothing that could tell it who
    // a stranger is, and printing "team" would be printing the request.
    await write(CONFIG);
    await run("status");
    expect(out).toContain("private (only you)");
    expect(out).toContain("no relay paired");
    expect(out).not.toContain("team (you and the people your relay admits)");
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

describe("connect when this device is already paired", () => {
  /**
   * Re-pairing updates, never replaces — ruled 2026-09-02 (byollm_016).
   *
   * This used to print "already paired with …" and ask `Pair again?`, and a
   * yes ran the whole ceremony. Two things were wrong.
   *
   * It could not succeed: the dashboard inserts a device row keyed on the
   * fingerprint of this machine's identity key, that key is stable, so the
   * re-pair hits the unique index and comes back "already registered on an
   * account" while the daemon polls until the code expires.
   *
   * And it trained the wrong reflex. **A ceremony repeated becomes a habit,
   * and a habit is not a comparison** — the fingerprint check is load-bearing
   * exactly because it is rare.
   *
   * These run against a real local hub rather than a stubbed client, because
   * the thing being asserted is that a *signed* heartbeat is presented and
   * believed. A fake that answers without checking a signature would pass
   * while the daemon sent nothing at all.
   */
  let hub: Server;
  let origin: string;
  let heartbeats: number;
  let beats: { paused: boolean }[];
  let answer: (res: ServerResponse) => void;

  beforeEach(async () => {
    heartbeats = 0;
    beats = [];
    answer = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          sites: {},
          cancel: [],
          lost: [],
          serverTime: Date.now(),
          awaitingConsent: [],
        }),
      );
    };
    hub = createServer((req, res) => {
      if ((req.url ?? "").endsWith("/heartbeat")) {
        heartbeats++;
        let raw = "";
        req.on("data", (chunk: Buffer) => {
          raw += chunk.toString("utf8");
        });
        req.on("end", () => {
          beats.push(JSON.parse(raw) as { paused: boolean });
          answer(res);
        });
        return;
      }
      // Any pairing traffic is a failure of the test's premise, so it is made
      // to look like one rather than quietly succeeding.
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad-request", message: "no ceremony" }));
    });
    await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${String((hub.address() as AddressInfo).port)}`;
  });

  afterEach(
    async () =>
      new Promise<void>((resolve) => {
        hub.close(() => {
          resolve();
        });
      }),
  );

  const alreadyPaired = async (extra: Record<string, unknown> = {}) => {
    await mkdir(home, { recursive: true });
    await writeFile(
      paths.pairings,
      JSON.stringify({
        version: 1,
        pairings: [
          {
            origin,
            runnerId: "r1",
            owner: "alice",
            sites: {},
            pairedAt: Date.parse("2026-09-02T00:00:00Z"),
            ...extra,
          },
        ],
      }),
      "utf8",
    );
  };

  it("reconnects on the stored credential, with no ceremony", async () => {
    await alreadyPaired();
    expect(await run("connect", origin)).toBe(0);

    expect(out).toContain("Connected as");
    expect(out).toContain("2026-09-02");
    // The whole point: the ceremony never started. Asserted on its actual
    // markers — the numbered steps and the code/fingerprint block — rather
    // than on the word "approve", which the success line legitimately uses
    // when it says there is nothing to approve.
    expect(out).not.toContain("Your steps:");
    expect(out).not.toContain("waiting for approval");
    expect(out).not.toMatch(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
    // And it was actually asked, rather than assumed from the file. Found is
    // not works.
    expect(heartbeats).toBeGreaterThan(0);
  });

  it("never asks the owner anything on a healthy re-run", async () => {
    /* A confirm here would be the old habit in a smaller costume: the point
       is not fewer keystrokes, it is that a routine re-run stops rehearsing
       the security check that only means something when it is rare. */
    await alreadyPaired();
    await run("connect", origin);
    expect(confirmQuestions).toEqual([]);
  });

  it("reports the pause honestly while it reconnects", async () => {
    /**
     * A probe is still a heartbeat, and a heartbeat says whether this device
     * is taking work. Reporting `false` for convenience would quietly resume
     * routing to a machine whose owner had paused it — the reconnect would
     * un-pause them as a side effect of saying hello.
     *
     * This exists because the comment claiming it mattered survived a
     * mutation that hard-coded `false`. A prediction ships with the check
     * that catches it.
     */
    await alreadyPaired();
    expect(await run("pause")).toBe(0);
    expect(await run("connect", origin)).toBe(0);
    expect(beats.map((b) => b.paused)).toEqual([true]);
  });

  it("pairs again when the hub says the credential is spent", async () => {
    await alreadyPaired();
    answer = (res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: "revoked",
          message: "this device was revoked",
        }),
      );
    };
    await run("connect", origin);
    /* Whitespace-flattened: these sentences go through `wrap()`, so asserting
       on the raw string tests the terminal width rather than the words. */
    const said = out.replace(/\s+/g, " ");
    expect(said).toContain("no longer accepted");
    expect(said).toContain("needs approving again");
  });

  it("does not re-pair because it could not ask", async () => {
    /**
     * The third state, and the reason this is not a boolean. An unreachable
     * hub is not a refusal — falling through to a ceremony would ask somebody
     * to re-approve a machine over a wifi problem, and mint a pairing that
     * cannot land anyway. Same law as the control plane's polls: an
     * unreadable answer is not a negative answer.
     */
    await alreadyPaired();
    await new Promise<void>((resolve) => {
      hub.close(() => {
        resolve();
      });
    });
    expect(await run("connect", origin)).toBe(1);
    expect(err.replace(/\s+/g, " ")).toContain(
      "still paired and nothing was changed",
    );
    expect(out).not.toMatch(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
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
    // Written as `team` and reported as narrowed, because this machine is
    // paired with nothing — the config round trip is what this test is about,
    // and it survived.
    expect(await readFile(paths.config, "utf8")).toContain('"offer": "team"');
    expect(out).toContain("no relay paired");
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

/**
 * A verb handed arguments it does not understand refuses — ruled 2026-09-03.
 *
 * `byollm models claude fake` listed every service's model and exited zero,
 * exactly as if called bare. The arguments were dropped, so a command asked to
 * *set* a model answered by *listing* them and reported success for work it
 * never did.
 *
 * The swallowed-argument cousin of a family this project keeps meeting:
 * `undefined` is not `false`, an unreadable answer is not a negative one, and
 * a request nobody understood is not a request nobody made.
 */
describe("byollm models, handed arguments", () => {
  it("refuses rather than behaving like a different command", async () => {
    expect(await run("models", "claude", "fake")).toBe(2);
    // Names what it got back, so somebody can see their typo rather than
    // wonder which word was wrong.
    expect(err).toContain("claude");
    expect(err).toContain("fake");
    // And points at the verb that does the thing they asked for.
    expect(err).toContain("byollm model claude fake");
  });

  it("still lists when asked bare", async () => {
    /* The control, and it needs a real config: a `models` that refused
       everything would pass the case above while breaking the command, and
       an empty home makes `models` exit non-zero for its own good reason —
       which would have made this control pass without proving anything. */
    await mkdir(home, { recursive: true });
    await writeFile(
      paths.config,
      JSON.stringify({
        services: {
          studio: {
            type: "openai-http",
            baseUrl: "http://127.0.0.1:8080/v1",
            model: "qwen",
            kinds: ["llm.generate"],
          },
        },
      }),
      "utf8",
    );

    expect(await run("models")).toBe(0);
    expect(out).toContain("studio");
    expect(err).not.toContain("takes no arguments");
  });
});

/**
 * A pairing that succeeds is a pairing you still have — the walk, 2026-09-03.
 *
 * Todd's transcript, on .70, in this order and with nothing between them:
 *
 *   waiting for approval…. paired as ff34beda-05c3-…
 *   ❯ byollm status
 *   paired apps
 *     (none — run `byollm connect <url>`)
 *
 * Every downstream symptom follows from that one fact. `byollm run` exits 2
 * when it has no pairings — silently, from `runners.length === 0` — so launchd
 * reported "last exit 2" and the device sat on rosters serving nothing, which
 * is what `install` then cheerfully called Installed.
 *
 * End to end against a real local hub rather than a stubbed client, because
 * the question is whether the thing `connect` writes is the thing `status`
 * can read: a fake that returned the pairing from memory would pass while the
 * file on disk stayed empty.
 */
describe("what connect writes, status reads", () => {
  let hub: Server;
  let origin: string;

  beforeEach(async () => {
    hub = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
      });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as { action?: string };
        res.writeHead(200, { "content-type": "application/json" });
        if (body.action === "start") {
          res.end(
            JSON.stringify({
              deviceCode: "device-code-long-enough-to-pass",
              userCode: "RGDY-YQE8",
              verificationUrl: "https://dashboard.test/devices?pair=1",
              expiresAt: Date.now() + 600_000,
              // The schema's floor; the poll answers first time anyway.
              pollIntervalMs: 500,
            }),
          );
          return;
        }
        res.end(
          JSON.stringify({
            status: "approved",
            runnerId: "runner-1",
            owner: "ff34beda-05c3-4b85-8945-fbd45f126bf8",
            sites: { [keyId(SITE.identity)]: SITE },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${String((hub.address() as AddressInfo).port)}`;
  });

  afterEach(
    async () =>
      new Promise<void>((resolve) => {
        hub.close(() => {
          resolve();
        });
      }),
  );

  it("still knows about the pairing on the very next command", async () => {
    const code = await run("connect", origin);
    expect(code, err).toBe(0);
    expect(out).toContain("paired as");

    out = "";
    expect(await run("status")).toBe(0);
    expect(
      out,
      "status reported no pairing right after one succeeded",
    ).toContain(origin);
    expect(out).not.toContain("(none — run");
  });

  it("is on disk, not just in the process that wrote it", async () => {
    /* The control that makes the case above mean something. `status` runs in
       the same process here, so an in-memory pairing would satisfy it; the
       file is what `byollm run` reads under launchd, and the file is what was
       empty. */
    await run("connect", origin);
    const saved = JSON.parse(await readFile(paths.pairings, "utf8")) as {
      pairings: { origin: string }[];
    };
    expect(saved.pairings.map((p) => p.origin)).toEqual([origin]);
  });
});
