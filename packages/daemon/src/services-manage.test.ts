import { describe, expect, it } from "vitest";
import {
  BOTH_KINDS,
  DEFAULT_SHARE_CAP_CENTS,
  dollarsToCents,
  manageServices,
  parseToggle,
  serviceBlockFor,
  misTypedReport,
  misTypedServices,
  serviceNameFor,
  SUBSCRIPTION_CLIS,
  summarise,
  type Detected,
  type Detector,
  type ManageIo,
  type Probe,
} from "./services-manage.js";
import { DaemonConfig, resolveConfig } from "./config.js";
import { startability } from "./local-server.js";
import { knownModelsFor } from "./known-models.js";
import type { BackendId } from "@byollm/protocol";

/**
 * The one screen — B100a, byollm_023 §the flow.
 *
 * Everything here ends at one of two places: the `services` map the screen
 * hands back, parsed by the schema the daemon actually loads, or the words on
 * the transcript. Those are the screen's two outputs and it has no others —
 * it writes no file and reaches no network, which is what lets a test describe
 * the machine it is testing instead of testing this laptop.
 *
 * The bulk of it is the cases that must NOT happen: a metered service shared
 * without a ceiling, a typo ending the screen, a hand-written entry deleted by
 * a tool that did not understand it. A picker suite that only shows picking
 * working is a suite that stays green if the picker stops reading its input.
 */

/** A scripted terminal: answers in order, transcript captured. */
function scripted(answers: readonly string[]): ManageIo & {
  transcript: () => string;
  asked: () => string[];
} {
  const said: string[] = [];
  const questions: string[] = [];
  let at = 0;
  return {
    interactive: true,
    out: (text) => said.push(text),
    err: (text) => said.push(text),
    ask: (question) => {
      said.push(question);
      questions.push(question);
      return Promise.resolve(answers[at++] ?? "");
    },
    transcript: () => said.join(""),
    asked: () => questions,
  };
}

const machineWith =
  (ids: readonly string[]): Detector =>
  (id) =>
    Promise.resolve(ids.includes(id));

const noCli = machineWith([]);
const noServers: Probe = () => Promise.resolve([]);

const serving =
  (...servers: Awaited<ReturnType<Probe>>): Probe =>
  () =>
    Promise.resolve(servers);

const answersFine = (): Promise<Detected> =>
  Promise.resolve({ installed: true, answers: true });

const signedOut = (): Promise<Detected> =>
  Promise.resolve({
    installed: true,
    answers: false,
    detail: "run `claude auth login`",
  });

const ollama = {
  label: "Ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  models: ["qwen3:8b", "smollm2:135m"],
};

/** The screen, with every injectable pinned so nothing reaches this laptop. */
const run = (
  answers: readonly string[],
  extra: Partial<Parameters<typeof manageServices>[0]> = {},
) => {
  const io = scripted(answers);
  return manageServices({
    io,
    existing: {},
    detector: noCli,
    verifier: answersFine,
    probe: noServers,
    login: () => Promise.resolve(true),
    platform: "darwin",
    ...extra,
  }).then((outcome) => ({ outcome, io }));
};

describe("what a typed line means", () => {
  it("reads numbers, `a`, and blank — and nothing else", () => {
    expect(parseToggle("", 3)).toEqual({ kind: "done" });
    expect(parseToggle("   ", 3)).toEqual({ kind: "done" });
    expect(parseToggle("a", 3)).toEqual({ kind: "all" });
    expect(parseToggle("ALL", 3)).toEqual({ kind: "all" });
    expect(parseToggle("2", 3)).toMatchObject({ kind: "pick", at: [1] });
    expect(parseToggle("1,3", 3)).toMatchObject({ kind: "pick", at: [0, 2] });
    expect(parseToggle("1 3", 3)).toMatchObject({ kind: "pick", at: [0, 2] });
    expect(parseToggle("3, 1", 3)).toMatchObject({ kind: "pick", at: [2, 0] });
  });

  it("does not treat a word it cannot read as `done`", () => {
    /**
     * The load-bearing one. A picker that falls through to "finished" on an
     * unrecognised line ends the screen when somebody answers a question it
     * did not ask — `y`, `yes`, `ollama`, a stray Enter after a paste — and
     * the person's actual selection is whatever it had before they typed.
     */
    for (const line of ["y", "yes", "n", "ollama", "-1", "1.5", "0", "9"]) {
      expect(parseToggle(line, 3).kind, line).toBe("unknown");
    }
  });

  it("keeps the numbers it understood and NAMES the ones it did not", () => {
    /**
     * Forgiving where forgiving is free: refusing "1 99" outright would cost
     * somebody their real pick over a typo in the same line.
     *
     * **The silence was not free.** Found by running it — `3,6` on a
     * five-row machine toggled row three and dropped the six without a word,
     * and the only evidence was a redraw somebody would have to diff against
     * the one above it.
     */
    expect(parseToggle("1 99", 3)).toEqual({
      kind: "pick",
      at: [0],
      ignored: ["99"],
    });
  });

  it("says on the screen what it ignored", async () => {
    const { outcome, io } = await run(["1 99", ""], {
      probe: serving({ ...ollama, models: ["qwen3:8b"] }),
    });
    expect(Object.keys(outcome.services)).toEqual(["qwen3-8b"]);
    expect(io.transcript()).toContain("ignored 99");
    expect(io.transcript()).toContain("this list stops at 1");
  });

  it("names what it could not read, so the reply is not just `no`", () => {
    const verdict = parseToggle("nope", 3);
    expect(verdict.kind).toBe("unknown");
    if (verdict.kind === "unknown") expect(verdict.words).toContain("nope");
  });
});

describe("dollars in, cents stored", () => {
  it("takes the shapes a person types", () => {
    expect(dollarsToCents("10")).toBe(1000);
    expect(dollarsToCents("2.50")).toBe(250);
    expect(dollarsToCents("$25")).toBe(2500);
    expect(dollarsToCents(" 0 ")).toBe(0);
    expect(dollarsToCents("0.05")).toBe(5);
  });

  it("refuses anything that is not an amount, rather than guessing one", () => {
    /**
     * `undefined` is the whole point: a cap is consent to spend somebody's
     * money, and an answer nobody could read is not a small number. Every one
     * of these would become a real ceiling under `parseFloat`.
     */
    for (const text of ["", "ten", "1e3", "-5", "1.234", "10 dollars", "NaN"]) {
      expect(dollarsToCents(text), text).toBeUndefined();
    }
  });
});

describe("the name a model gets", () => {
  it("keeps the tag and turns the colon into a hyphen", () => {
    /* Settled by Todd 09-10. The version that dropped the tag read better and
       collided: `smollm2:135m` and `smollm2:360m` were one name, and the
       picker would have written one service where somebody chose two. */
    expect(serviceNameFor("smollm2:135m")).toBe("smollm2-135m");
    expect(serviceNameFor("smollm2:360m")).toBe("smollm2-360m");
    expect(serviceNameFor("smollm2:135m")).not.toBe(
      serviceNameFor("smollm2:360m"),
    );
  });

  it("drops `:latest`, which is the tag that means no tag", () => {
    /* Found by running it on Todd's laptop: `gemma4-agent:latest` came out as
       `gemma4-agent-latest`, and every default-pulled Ollama model would
       have. Keeping a tag that distinguishes nothing is not what the tag rule
       is for. */
    expect(serviceNameFor("gemma4-agent:latest")).toBe("gemma4-agent");
    /* And the collision it cannot cause: `uniqueName` settles a server that
       holds both spellings, which it would have had to do anyway. */
    expect(serviceNameFor("gemma4-agent")).toBe("gemma4-agent");
  });

  it("drops a publisher namespace, which is not part of the name", () => {
    expect(serviceNameFor("mlx-community/Qwen2.5-14B-Instruct-4bit")).toBe(
      "Qwen2.5-14B-Instruct-4bit",
    );
  });

  it("always produces something legal to type", () => {
    expect(serviceNameFor("///")).toBe("my-model");
    expect(serviceNameFor("a b:c")).toBe("a-b-c");
  });
});

describe("the block the picker writes and the block the note pastes", () => {
  it("names the provider the server named — B112", async () => {
    /**
     * The block used to say `type: "openai-http"` for a server the probe had
     * just identified, which is the one config shape that **cannot be started
     * on demand** — so what we handed people was exactly what B098 then has
     * to explain and offer to fix. One field, thrown away one line from where
     * it was learned.
     */
    expect(
      serviceBlockFor({
        model: "qwen3:8b",
        baseUrl: "http://x/v1",
        type: "ollama",
      }).type,
    ).toBe("ollama");

    const { outcome } = await run(["1", ""], {
      probe: serving({ ...ollama, models: ["qwen3:8b"], backendId: "ollama" }),
    });
    expect(outcome.services["qwen3-8b"]).toMatchObject({ type: "ollama" });
  });

  it("writes what the picker wrote, and it is startable", async () => {
    /**
     * The whole point, asserted where it lands rather than on the field.
     * `startability` is what B098's surface asks, and it answers
     * `no-start-command` for `openai-http` at the same address — so this is
     * the difference the type buys, in the function that consumes it.
     */
    const { outcome } = await run(["1", ""], {
      probe: serving({ ...ollama, models: ["qwen3:8b"], backendId: "ollama" }),
    });
    const block = outcome.services["qwen3-8b"] as { type: BackendId };
    expect(
      await startability({
        id: block.type,
        baseUrl: ollama.baseUrl,
        onPath: () => Promise.resolve(true),
      }),
    ).toEqual({ startable: true });
    /* The control: the same address under the generic transport is not, which
       is the config B098 exists to rescue. */
    expect(
      await startability({
        id: "openai-http",
        baseUrl: ollama.baseUrl,
        onPath: () => Promise.resolve(true),
      }),
    ).toEqual({ startable: false, why: "no-start-command" });
  });

  it("falls back to the generic transport when nobody identified the server", () => {
    /* `undefined` is "we did not verify a provider". The service still runs —
       every HTTP backend speaks the same transport — and what is lost is the
       start command, honestly rather than by a guess. */
    expect(serviceBlockFor({ model: "m", baseUrl: "http://x/v1" }).type).toBe(
      "openai-http",
    );
  });

  it("is one function, so they cannot drift", () => {
    /* B100b's paste and B100a's write are the same JSON. `unused-models.ts`
       asks this rather than restating the shape — instruction 9, and this
       file carried the second spelling until B100a. */
    expect(
      serviceBlockFor({ model: "qwen3:8b", baseUrl: "http://x/v1" }),
    ).toEqual({
      type: "openai-http",
      baseUrl: "http://x/v1",
      model: "qwen3:8b",
      kinds: ["llm.generate", "llm.chat"],
      offer: "private",
    });
  });
});

describe("an empty machine", () => {
  it("says what to install rather than showing an empty list", async () => {
    const { outcome, io } = await run([]);
    expect(outcome.decided).toBe(false);
    expect(outcome.services).toEqual({});
    expect(io.transcript()).toContain("Nothing to configure yet");
    expect(io.transcript()).toContain("claude:");
  });

  it("refuses outright when it cannot ask", async () => {
    const io = scripted([]);
    const outcome = await manageServices({
      io: { ...io, interactive: false },
      existing: {},
      detector: machineWith(["claude-cli"]),
      verifier: answersFine,
      probe: noServers,
    });
    expect(outcome.decided).toBe(false);
    /* And it never probed: the refusal is the first thing it does, so a
       non-terminal caller does not spend two canary tokens learning it. */
    expect(io.transcript()).not.toContain("Looking for local model servers");
  });
});

describe("choosing what runs", () => {
  it("turns a row on by number and writes it when the line is blank", async () => {
    const { outcome } = await run(["1", ""], {
      probe: serving(ollama),
    });
    expect(outcome.decided).toBe(true);
    expect(Object.keys(outcome.services)).toEqual(["qwen3-8b"]);
    expect(outcome.services["qwen3-8b"]).toEqual({
      type: "openai-http",
      baseUrl: ollama.baseUrl,
      model: "qwen3:8b",
      kinds: [...BOTH_KINDS],
      offer: "private",
    });
  });

  it("turns a row back off when the same number is typed twice", async () => {
    const { outcome } = await run(["1", "1", ""], { probe: serving(ollama) });
    expect(outcome.decided).toBe(false);
    expect(outcome.services).toEqual({});
  });

  it("`a` takes everything, and `a` again clears it", async () => {
    const all = await run(["a", ""], { probe: serving(ollama) });
    expect(Object.keys(all.outcome.services).sort()).toEqual([
      "qwen3-8b",
      "smollm2-135m",
    ]);

    const none = await run(["a", "a", ""], { probe: serving(ollama) });
    expect(none.outcome.decided).toBe(false);
  });

  it("keeps asking after a line it could not read", async () => {
    /* The screen must not end on `y`. If it did, this run would return with
       nothing selected instead of the row that follows. */
    const { outcome, io } = await run(["y", "1", ""], {
      probe: serving(ollama),
    });
    expect(Object.keys(outcome.services)).toEqual(["qwen3-8b"]);
    expect(io.transcript()).toContain("is not a number on this list");
  });

  it("groups models that cost money apart from models that do not", async () => {
    /**
     * Todd's ruling, and it is not cosmetic. A single list headed "on this
     * machine" already nearly shipped a metered paste once — Ollama proxies
     * hosted models through the same loopback port, so the address says local
     * and the bill does not.
     */
    const { io } = await run([""], {
      probe: serving({ ...ollama, models: ["qwen3:8b", "kimi-k3:cloud"] }),
    });
    const out = io.transcript();
    expect(out).toContain("models on this machine");
    expect(out).toContain("billed to your account");
    expect(out.indexOf("qwen3-8b")).toBeLessThan(out.indexOf("kimi-k3-cloud"));
    expect(out).toContain("metered — runs on your provider's account");
  });

  it("numbers the rows the way it reads them, whatever order they arrived in", async () => {
    /**
     * The screen groups and the toggle indexes, and for one commit those were
     * two numbering schemes that agreed only while the array happened to be
     * sorted. A probe answering metered-first would then have moved every
     * mark one row. So: metered first out of the probe, and `1` must still be
     * the row printed as `1`.
     */
    const { outcome, io } = await run(["1", ""], {
      probe: serving({ ...ollama, models: ["kimi-k3:cloud", "qwen3:8b"] }),
    });
    const screen = io.transcript();
    expect(screen).toMatch(/ 1\. \[ \] qwen3-8b/);
    expect(Object.keys(outcome.services)).toEqual(["qwen3-8b"]);
  });

  it("prints each group heading once", async () => {
    const { io } = await run([""], {
      probe: serving({
        ...ollama,
        models: ["kimi-k3:cloud", "qwen3:8b", "glm-5.2:cloud"],
      }),
    });
    const screen = io.transcript();
    expect(screen.split("models on this machine").length - 1).toBe(1);
    expect(screen.split("billed to your account").length - 1).toBe(1);
  });

  it("gives two servers serving the same model two names", async () => {
    const { outcome } = await run(["a", ""], {
      probe: serving(
        {
          label: "Ollama",
          baseUrl: "http://127.0.0.1:11434/v1",
          models: ["q"],
        },
        {
          label: "LM Studio",
          baseUrl: "http://127.0.0.1:1234/v1",
          models: ["q"],
        },
      ),
    });
    expect(Object.keys(outcome.services).sort()).toEqual(["q", "q-2"]);
  });
});

describe("a subscription CLI", () => {
  it("is offered, and says the self-lock before anything is shared", async () => {
    const { outcome, io } = await run(["1", ""], {
      detector: machineWith(["claude-cli"]),
    });
    expect(Object.keys(outcome.services)).toEqual(["claude"]);
    expect(io.transcript()).toContain("YOUR");
    expect(io.transcript()).toContain("never shared with a team");
  });

  it("is never offered to the team, so the money question never reaches it", async () => {
    /* `SUBSCRIPTION_SELF_LOCK`. It appears as unshareable rather than as an
       option that is refused later, which is the ruled shape. */
    const { outcome, io } = await run(["1", "", "y"], {
      detector: machineWith(["claude-cli"]),
    });
    expect(outcome.services["claude"]).toMatchObject({ offer: "private" });
    /* And no team question at all: nothing selected can be shared. */
    expect(io.transcript()).not.toContain("plan to create, a team");
  });

  it("is left out when it is installed and still cannot answer", async () => {
    /**
     * Setup used to stop the whole wizard here and the reasoning was right —
     * a logged-out CLI reaching somebody as a *note* left two machines in "we
     * thought it wasn't working" for days. What changed is where the loudness
     * lives: stopping a screen that is also the re-run path would throw away
     * every other choice over one expired token, so the refusal moved onto the
     * row.
     */
    const { outcome, io } = await run(["1", "", "n", "n", "n"], {
      detector: machineWith(["claude-cli"]),
      verifier: signedOut,
    });
    expect(outcome.services["claude"]).toBeUndefined();
    expect(io.transcript()).toContain("signed out");
    expect(io.transcript()).toContain("Leaving `claude` out");
  });

  it("keeps the other choices when one CLI cannot be signed in", async () => {
    /* The control for the case above. The old behaviour wrote nothing at all,
       which in a re-run screen means losing work somebody just did. */
    const { outcome } = await run(["1 2", "", "n", "n", "n", ""], {
      detector: machineWith(["claude-cli"]),
      verifier: signedOut,
      probe: serving({ ...ollama, models: ["qwen3:8b"] }),
    });
    expect(Object.keys(outcome.services)).toEqual(["qwen3-8b"]);
  });
});

describe("sharing, and the money that comes with it", () => {
  const metered = serving({
    ...ollama,
    models: ["qwen3:8b", "kimi-k3:cloud"],
  });

  it("asks about the team first, and skips the whole branch on no", async () => {
    const { outcome, io } = await run(["a", "", "n"], { probe: metered });
    expect(io.transcript()).toContain("plan to create, a team");
    expect(io.transcript()).not.toContain("You authorized the team");
    for (const block of Object.values(outcome.services)) {
      expect(block).toMatchObject({ offer: "private" });
    }
  });

  it("collects the ceiling with the sharing, not after it", async () => {
    /**
     * `resolveConfig` refuses a widened metered service that has an
     * acknowledgement without a cap, so a screen that collected them
     * separately writes a config the daemon rejects — and the person learns
     * from an error rather than from a question.
     */
    const { outcome } = await run(["a", "", "y", "a", "", "25"], {
      probe: metered,
    });
    expect(outcome.services["kimi-k3-cloud"]).toMatchObject({
      offer: "team",
      spend: { acknowledged: true, dailyCapCents: 2500 },
    });
    /* And the free row is shared with no money question at all. */
    expect(outcome.services["qwen3-8b"]).toMatchObject({ offer: "team" });
    expect(outcome.services["qwen3-8b"]).not.toHaveProperty("spend");
  });

  it("offers $10 when nobody has set one before", async () => {
    const { outcome, io } = await run(["a", "", "y", "a", "", ""], {
      probe: metered,
    });
    expect(io.transcript()).toContain("[10.00]");
    expect(outcome.services["kimi-k3-cloud"]).toMatchObject({
      spend: { dailyCapCents: DEFAULT_SHARE_CAP_CENTS },
    });
  });

  it("treats 0 as `keep it private`, never as a cap of nothing", async () => {
    /* The schema agrees: `dailyCapCents` is `positive()`, so zero is not a
       legal ceiling and a shared service carrying one could never run for
       anybody — a trap dressed as a setting. */
    const { outcome, io } = await run(["a", "", "y", "a", "", "0"], {
      probe: metered,
    });
    expect(outcome.services["kimi-k3-cloud"]).toMatchObject({
      offer: "private",
    });
    expect(io.transcript()).toContain("kimi-k3-cloud stays private");
  });

  it("fails closed on three answers it cannot read", async () => {
    /* The offered default is an offer. An offer nobody accepted is not
       consent to spend their money. */
    const { outcome, io } = await run(
      ["a", "", "y", "a", "", "lots", "heaps", "loads"],
      { probe: metered },
    );
    expect(outcome.services["kimi-k3-cloud"]).toMatchObject({
      offer: "private",
    });
    expect(io.transcript()).toContain("is not an amount");
  });

  it("shares only the rows that were marked in the sharing pass", async () => {
    const { outcome } = await run(["a", "", "y", "1", ""], { probe: metered });
    expect(outcome.services["qwen3-8b"]).toMatchObject({ offer: "team" });
    expect(outcome.services["kimi-k3-cloud"]).toMatchObject({
      offer: "private",
    });
  });
});

describe("the one default question", () => {
  it("is not asked when there is only one service to be default", async () => {
    const { io } = await run(["1", ""], { probe: serving(ollama) });
    expect(io.transcript()).not.toContain("default service");
  });

  it("writes one answer to both kinds", async () => {
    /**
     * Legal precisely because every service answers both, which is why one
     * question is enough — and necessary because `resolveConfig` withholds a
     * kind entirely when two services claim it and no default is named. A
     * picker that stopped at "I selected two models" would turn that into "my
     * device advertises nothing".
     */
    const { outcome } = await run(["a", "", "n", "2"], {
      probe: serving(ollama),
    });
    expect(outcome.defaults).toEqual({
      "llm.generate": "smollm2-135m",
      "llm.chat": "smollm2-135m",
    });
  });

  it("offers claude when claude was selected", async () => {
    const { outcome, io } = await run(["a", "", "n", ""], {
      detector: machineWith(["claude-cli"]),
      probe: serving({ ...ollama, models: ["qwen3:8b"] }),
    });
    /* Deliberate, and Todd's reasoning is on the record: a teammate reaching
       for a shared machine names the service they were given, so a
       subscription default is correct rather than a trap. */
    expect(io.transcript()).toContain("[1]");
    expect(outcome.defaults["llm.chat"]).toBe("claude");
  });

  it("says which choices cannot serve the people it was just shared with", async () => {
    const { io } = await run(["a", "", "y", "a", "", ""], {
      detector: machineWith(["claude-cli"]),
      probe: serving({ ...ollama, models: ["qwen3:8b"] }),
    });
    expect(io.transcript()).toContain("cannot serve teammates");
  });

  it("stays quiet about teammates when nothing was shared", async () => {
    const { io } = await run(["a", "", "n", ""], {
      detector: machineWith(["claude-cli"]),
      probe: serving({ ...ollama, models: ["qwen3:8b"] }),
    });
    expect(io.transcript()).not.toContain("cannot serve teammates");
  });

  it("falls back to the offered row when the answer is nonsense", async () => {
    /* Forgiving here and not at the cap question, on purpose: nothing is
       spent by this answer, and the prompt already promised the `[1]`. */
    const { outcome } = await run(["a", "", "n", "banana"], {
      probe: serving(ollama),
    });
    expect(outcome.defaults["llm.generate"]).toBe("qwen3-8b");
  });
});

describe("re-running it over a config that already exists", () => {
  const existing = {
    qwen: {
      type: "openai-http",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen3:8b",
      kinds: ["llm.generate"],
      offer: "team",
    },
  };

  it("pre-marks what is there, so blank changes nothing", async () => {
    const { outcome } = await run([""], {
      existing,
      probe: serving(ollama),
    });
    expect(outcome.services["qwen"]).toEqual(existing.qwen);
    /* Its own name, not the one the picker would have suggested — the owner's
       word for a service is theirs. */
    expect(outcome.services["qwen3-8b"]).toBeUndefined();
  });

  it("carries a share and its cap into the pre-marked screen", async () => {
    const shared = {
      cloudy: {
        type: "openai-http",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "kimi-k3:cloud",
        kinds: [...BOTH_KINDS],
        offer: "team",
        spend: { acknowledged: true, dailyCapCents: 2500 },
      },
    };
    const { outcome, io } = await run(["", "y", "", ""], {
      existing: shared,
      probe: noServers,
    });
    /* The cap it already has is what is offered back, not the $10 default. */
    expect(io.transcript()).toContain("[25.00]");
    expect(outcome.services["cloudy"]).toMatchObject({
      offer: "team",
      spend: { dailyCapCents: 2500 },
    });
  });

  it("removes a service by turning its row off", async () => {
    const { outcome } = await run(["1", ""], {
      existing,
      probe: noServers,
    });
    expect(outcome.decided).toBe(false);
    expect(outcome.services).toEqual({});
  });

  it("keeps every field it did not ask about", async () => {
    /**
     * The screen asks about two things — whether a service exists and who may
     * use it — so those are the only two it may change. A tool that cannot
     * enumerate the settings it is not editing must not assume there are none.
     */
    const rich = {
      remote: {
        type: "openai-http",
        baseUrl: "https://api.example.com/v1",
        model: "big",
        kinds: ["llm.chat"],
        offer: "private",
        apiKeyEnv: "EXAMPLE_KEY",
        spend: { acknowledged: false, centsPerMillionTokens: 42 },
      },
    };
    const { outcome } = await run([""], { existing: rich, probe: noServers });
    expect(outcome.services["remote"]).toMatchObject({
      apiKeyEnv: "EXAMPLE_KEY",
      kinds: ["llm.chat"],
      spend: { centsPerMillionTokens: 42 },
    });
  });

  it("leaves alone an entry it cannot understand, rather than deleting it", async () => {
    /* This screen rewrites `services` wholesale, so an entry it cannot parse
       is an entry it would silently drop. It is put back verbatim and named. */
    const odd = { weird: { type: "not-a-backend", model: 7 } };
    const { outcome, io } = await run(["1", ""], {
      existing: odd as unknown as Record<string, Record<string, unknown>>,
      probe: serving({ ...ollama, models: ["qwen3:8b"] }),
    });
    expect(outcome.services["weird"]).toEqual(odd.weird);
    expect(io.transcript()).toContain("does not\n  understand");
  });

  it("does not offer the same server twice when the config already names it", async () => {
    const { outcome } = await run(["a", "", "n", ""], {
      existing,
      probe: serving(ollama),
    });
    /* `qwen3:8b` at that address is already `qwen`; only `smollm2` is new. */
    expect(Object.keys(outcome.services).sort()).toEqual([
      "qwen",
      "smollm2-135m",
    ]);
  });
});

describe("what comes out is a config the daemon runs", () => {
  it("parses, resolves, and withholds nothing", async () => {
    const { outcome } = await run(["a", "", "y", "a", "", "5"], {
      detector: machineWith(["claude-cli"]),
      probe: serving({ ...ollama, models: ["qwen3:8b", "kimi-k3:cloud"] }),
    });
    const parsed = DaemonConfig.safeParse({
      services: outcome.services,
      defaults: outcome.defaults,
    });
    expect(
      parsed.success ? [] : parsed.error.issues.map((i) => i.message),
    ).toEqual([]);
    if (!parsed.success) return;

    const loaded = resolveConfig(parsed.data);
    expect(loaded.problems).toEqual([]);
    /* The whole reason the default question exists: with three services
       claiming both kinds and no default, `resolveConfig` advertises nothing. */
    expect(loaded.withheld).toEqual([]);
    expect(loaded.routes.some((route) => route.kind === "llm.chat")).toBe(true);
  });

  it("says what it wrote in the words that describe THIS config", async () => {
    const { outcome } = await run(["a", "", "y", "a", "", "5"], {
      probe: serving({ ...ollama, models: ["qwen3:8b", "kimi-k3:cloud"] }),
    });
    const lines = summarise(outcome).join("\n");
    expect(lines).toContain("qwen3-8b — your team may use it");
    expect(lines).toContain("up to $5.00 a day");
  });

  it("says `your own jobs only` when that is what it wrote", async () => {
    const { outcome } = await run(["1", ""], { probe: serving(ollama) });
    expect(summarise(outcome).join("\n")).toContain("your own jobs only");
  });
});

describe("a CLI that is there but cannot answer", () => {
  /**
   * Never reached, and that is the point of injecting it.
   *
   * The default `login` spawns the vendor CLI's real sign-in with the TTY
   * inherited. A test that fell through to it would open a browser on
   * somebody's machine and wait — which is exactly what two of these did for
   * five seconds each before it was added, and why the suite stopped exiting.
   */
  const neverSignsIn = () => Promise.resolve(false);

  it("says so in the CLI's own words, which are the ones that name the fix", async () => {
    const { io } = await run(["1", "", "n", "n"], {
      detector: machineWith(["claude-cli"]),
      verifier: signedOut,
      login: neverSignsIn,
    });
    const said = io.transcript();
    expect(said).toContain("cannot answer yet");
    expect(said).toContain("run `claude auth login`");
  });

  /**
   * Windows, where the offer could never be kept — B049 item 1.
   *
   * Kevin's transcript, three times: "Sign in to claude now? [Y/n] y" ->
   * "Opening Claude's sign-in now" -> "Still cannot answer". Nothing opened.
   * An npm-installed `claude` on Windows is `claude.cmd`, which Node will not
   * spawn without a shell, and `runLogin` is built to swallow that — so the
   * screen promised to open something, failed silently, and asked again.
   *
   * Todd ruled: on Windows, print the command instead. The assertion that
   * matters is the negative one — the promise is not made — because making it
   * and failing is the whole defect.
   */
  it("on Windows hands over the command instead of promising to open it", async () => {
    let spawned = 0;
    const { io } = await run(["1", "", "n", "n", "n"], {
      detector: machineWith(["claude-cli"]),
      verifier: signedOut,
      platform: "win32",
      login: () => {
        spawned += 1;
        return Promise.resolve(false);
      },
    });
    const said = io.transcript();
    expect(spawned, "nothing may be spawned on Windows").toBe(0);
    expect(said).not.toContain("Opening Claude's sign-in now");
    expect(said).toContain("claude auth login");
    expect(said).toContain("Windows cannot open it for you");
  });

  /* The control, and the reason the test above is not vacuous: everywhere
     else the offer still stands and is still taken. */
  it("still offers to open it everywhere else", async () => {
    let spawned = 0;
    const { io } = await run(["1", "", "y", "n", "n", "n"], {
      detector: machineWith(["claude-cli"]),
      verifier: signedOut,
      platform: "darwin",
      login: () => {
        spawned += 1;
        return Promise.resolve(false);
      },
    });
    expect(spawned).toBeGreaterThan(0);
    expect(io.transcript()).toContain("Opening Claude's sign-in now");
  });

  it("re-probes rather than believing a login that exited cleanly", async () => {
    /* `claude auth login` exiting 0 means the command finished, not that this
       machine can now answer a prompt — the same distinction as "installed"
       versus "answers", one level up. */
    let probes = 0;
    const { outcome } = await run(["1", "", "y", ""], {
      detector: machineWith(["claude-cli"]),
      verifier: () => {
        probes += 1;
        return probes === 1
          ? signedOut()
          : Promise.resolve({ installed: true, answers: true });
      },
      login: () => Promise.resolve(true),
    });
    expect(probes).toBeGreaterThan(1);
    expect(Object.keys(outcome.services)).toEqual(["claude"]);
  });

  /* And a backend with no canary is not reported as broken. `undefined` is
     "not asked", which is a third thing, and rendering it as `false` would
     tell everybody with a local model server that it cannot answer. */
  it("says nothing when there was no way to ask", async () => {
    const { io, outcome } = await run(["1", ""], {
      detector: machineWith(["claude-cli"]),
      verifier: () => Promise.resolve({ installed: true, answers: undefined }),
    });
    expect(io.transcript()).not.toContain("cannot answer yet");
    expect(Object.keys(outcome.services)).toEqual(["claude"]);
  });
});

/**
 * Identity is a machine, an address, and a model — B116.
 *
 * Found in Todd's live run. He called it "probably not a bug"; the mechanism
 * says otherwise, and the mechanism is that `identityOf` keyed on the TYPE
 * STRING, so the words a config happens to use decided what a service is.
 */
describe("the same service, however it is spelled", () => {
  const ollamaCloud = {
    label: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    models: ["glm-5.2:cloud"],
    backendId: "ollama" as const,
  };

  it("does not offer a configured service again under the probe's word", async () => {
    /**
     * Todd's file, exactly. His config says `openai-http` at
     * `127.0.0.1:11434` for `glm-5.2:cloud`; B112 taught the probe to say
     * `ollama` for the same address and the same model. **B112 caused this
     * half** — the probe became honest while the config kept the older word.
     */
    const { outcome } = await run([""], {
      existing: {
        "glm-5.2": {
          type: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "glm-5.2:cloud",
          kinds: [...BOTH_KINDS],
          offer: "team",
          spend: { acknowledged: true, dailyCapCents: 2500 },
        },
      },
      probe: serving(ollamaCloud),
    });
    expect(Object.keys(outcome.services)).toEqual(["glm-5.2"]);
  });

  it("upgrades the stored type to the one the server answered with", async () => {
    /**
     * The half that is not tidiness. `startCommandFor` switches on `type`, so
     * `openai-http` is the one shape that cannot be started on demand —
     * preserving the config's older word would silently un-start a server we
     * proved we can start, in the field, on `.88`.
     */
    const { outcome } = await run([""], {
      existing: {
        "glm-5.2": {
          type: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "glm-5.2:cloud",
          kinds: [...BOTH_KINDS],
          offer: "team",
          spend: { acknowledged: true, dailyCapCents: 2500 },
        },
      },
      probe: serving(ollamaCloud),
    });
    expect(outcome.services["glm-5.2"]).toMatchObject({ type: "ollama" });
    /* And everything the OWNER decided is untouched: their name, their
       offer, their cap. Only the field the probe knows better changes. */
    expect(outcome.services["glm-5.2"]).toMatchObject({
      offer: "team",
      spend: { acknowledged: true, dailyCapCents: 2500 },
    });
  });

  it("keeps a `:cloud` model metered after the type is upgraded", async () => {
    /* Metered is a COST fact and not a transport fact. B097 reads the tag
       before the declared cost, so typing an Ollama-served hosted model
       `ollama` cannot make it look free — which is the objection that would
       otherwise sink the upgrade. */
    const { io } = await run([""], { probe: serving(ollamaCloud) });
    expect(io.transcript()).toContain("billed to your account");
    expect(io.transcript()).toContain("metered — runs on your provider's");
  });

  it("does not let a probe that identified nothing overwrite a real type", async () => {
    /* `undefined` from the probe is "we did not verify a provider". Treating
       it as `openai-http` would turn silence into a downgrade — the exact
       direction B116 exists to forbid. */
    const { outcome } = await run([""], {
      existing: {
        mine: {
          type: "ollama",
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "qwen3:8b",
          kinds: [...BOTH_KINDS],
          offer: "private",
        },
      },
      probe: serving({ ...ollama, models: ["qwen3:8b"] }),
    });
    expect(outcome.services["mine"]).toMatchObject({ type: "ollama" });
  });

  it("reads two spellings of loopback as one machine", async () => {
    /* A config using `localhost` beside a probe using `127.0.0.1` is a third
       way to get a duplicate, and the set of spellings is `isLoopback`'s
       rather than a list restated here. */
    const { outcome, io } = await run([""], {
      existing: {
        mine: {
          type: "ollama",
          baseUrl: "http://localhost:11434/v1",
          model: "qwen3:8b",
          kinds: [...BOTH_KINDS],
          offer: "private",
        },
      },
      probe: serving({ ...ollama, models: ["qwen3:8b"], backendId: "ollama" }),
    });
    expect(Object.keys(outcome.services)).toEqual(["mine"]);
    /**
     * And the SCREEN is what proves it, not the written config.
     *
     * A blank line leaves the probe's row unmarked, so a duplicate would sit
     * there unselected and never reach `services` — the config assertion
     * passes either way, which is how a mutation removing this normalisation
     * survived once. The second row would be named for its model, so its
     * absence from the transcript is the fact.
     */
    expect(io.transcript()).not.toContain("qwen3-8b ");
  });

  it("keeps two models on one server as two services", async () => {
    /* Wanted, not tolerated: they cost differently and answer differently,
       and choosing between them is what a picker is for. */
    const { outcome } = await run(["a", "", "n", ""], {
      probe: serving({
        ...ollama,
        models: ["qwen3:8b", "smollm2:135m"],
        backendId: "ollama",
      }),
    });
    expect(Object.keys(outcome.services).sort()).toEqual([
      "qwen3-8b",
      "smollm2-135m",
    ]);
  });
});

describe("a CLI whose model we do not know", () => {
  it("annotates the owner's service instead of offering a second one", async () => {
    /**
     * `claude-2` was his `claude` again: `SUBSCRIPTION_CLIS` declared the
     * model as `"sonnet"` and his config says `claude-opus-5`, so the models
     * differed and the detected CLI arrived as a new row — **one that would
     * have written a service pinned to `sonnet` on a machine whose Claude
     * runs opus-5.** A machine has one `claude`.
     */
    const { outcome } = await run([""], {
      existing: {
        claude: {
          type: "claude-cli",
          model: "claude-opus-5",
          kinds: [...BOTH_KINDS],
          offer: "private",
        },
      },
      detector: machineWith(["claude-cli"]),
    });
    expect(Object.keys(outcome.services)).toEqual(["claude"]);
    expect(outcome.services["claude"]).toMatchObject({
      model: "claude-opus-5",
    });
  });

  it("asks the CLI about the model the machine actually runs", async () => {
    /* The canary used to be spent on our guess, so a machine running opus-5
       was asked whether `sonnet` answers — a true answer to a question about
       a different service. */
    const asked: string[] = [];
    await run([""], {
      existing: {
        claude: {
          type: "claude-cli",
          model: "claude-opus-5",
          kinds: [...BOTH_KINDS],
          offer: "private",
        },
      },
      detector: machineWith(["claude-cli"]),
      verifier: (_id, model) => {
        asked.push(model);
        return answersFine();
      },
    });
    expect(asked).toEqual(["claude-opus-5"]);
  });

  it("does not offer a row whose model string we invented", async () => {
    /**
     * `codex` declares no model, and absent is the honest value rather than a
     * placeholder. Checked by running the CLIs: `claude --help` has no models
     * command, `claude config get model` is not a command and runs as a
     * PROMPT, and this daemon's argv is frozen at `--output-format text`, so
     * the response carries no model field. Three ways, no answer.
     */
    const { outcome, io } = await run([""], {
      detector: machineWith(["codex-cli"]),
    });
    expect(outcome.services["codex"]).toBeUndefined();
    /* And said, not skipped in silence: the binary IS on this machine, and a
       screen that omits it without a word looks broken to whoever installed
       it. */
    expect(io.transcript()).toContain("`codex` is installed");
    expect(io.transcript()).toContain("does not know which model it serves");
  });

  it("still offers a CLI whose model this build can stand behind", async () => {
    /* The control, and the reason the case above is not "CLIs stopped
       working". `sonnet` is in `knownModelsFor("claude-cli")` and documented
       in `claude --help` as an alias for the latest sonnet — the CLI's word
       rather than ours. */
    const { outcome } = await run(["1", ""], {
      detector: machineWith(["claude-cli"]),
    });
    expect(outcome.services["claude"]).toMatchObject({ model: "sonnet" });
  });

  it("offers only models this build already knows that CLI accepts", () => {
    /**
     * The invariant, so the next constant cannot be somebody's machine
     * frozen for everybody — which is where `gpt-5.6-terra` came from: it is
     * Todd's configured model, and it appears in no help output and in no
     * list this build maintains.
     */
    for (const cli of SUBSCRIPTION_CLIS) {
      if (cli.model === undefined) continue;
      expect(
        knownModelsFor(cli.id),
        `${cli.binary} offers ${cli.model}, which this build does not list`,
      ).toContain(cli.model);
    }
  });
});

describe("a config that says one thing while the server says another", () => {
  const ollamaAt11434 = {
    label: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    models: ["glm-5.2:cloud"],
    backendId: "ollama" as const,
  };
  const servers = [ollamaAt11434];
  const unnamed = {
    label: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    models: ["glm-5.2:cloud"],
  };

  it("names the service, and fails on the file Todd has today", () => {
    const found = misTypedServices({
      services: {
        "glm-5.2": {
          type: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "glm-5.2:cloud",
          kinds: ["llm.generate"],
        },
      },
      servers,
    });
    expect(found).toEqual([
      {
        service: "glm-5.2",
        stored: "openai-http",
        probed: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
      },
    ]);
    expect(misTypedReport(found).join("\n")).toContain("will not be started");
  });

  it("says nothing about a service the probe agrees with", () => {
    expect(
      misTypedServices({
        services: {
          "smollm2-135m": {
            type: "ollama",
            baseUrl: "http://127.0.0.1:11434/v1",
            model: "smollm2:135m",
            kinds: ["llm.generate"],
          },
        },
        servers,
      }),
    ).toEqual([]);
  });

  it("says nothing about a port no probe visits", () => {
    /* Todd's MLX on 6999. `openai-http` is right for a server nobody
       identified, and that is what the generic transport is FOR — not a
       default to fall back to when the specific id is inconvenient. */
    expect(
      misTypedServices({
        services: {
          "qwen-2.5-14b": {
            type: "openai-http",
            baseUrl: "http://127.0.0.1:6999/v1",
            model: "mlx-community/Qwen2.5-14B-Instruct-4bit",
            kinds: ["llm.generate"],
          },
        },
        servers,
      }),
    ).toEqual([]);
  });

  it("says nothing when the probe identified nothing", () => {
    expect(
      misTypedServices({
        services: {
          mine: {
            type: "openai-http",
            baseUrl: "http://127.0.0.1:11434/v1",
            model: "m",
            kinds: ["llm.generate"],
          },
        },
        servers: [unnamed],
      }),
    ).toEqual([]);
  });

  it("is what the picker can never write — the assertion over the output", async () => {
    /**
     * The writer's own guard, asserted where it lands. Anything the picker
     * produces for a probed address carries the probed type, so running the
     * screen over a config that had it wrong ENDS the condition rather than
     * carrying it forward.
     */
    const { outcome } = await run([""], {
      existing: {
        "glm-5.2": {
          type: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "glm-5.2:cloud",
          kinds: [...BOTH_KINDS],
          offer: "private",
        },
      },
      probe: serving(ollamaAt11434),
    });
    expect(misTypedServices({ services: outcome.services, servers })).toEqual(
      [],
    );
  });
});
