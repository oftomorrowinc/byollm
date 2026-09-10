import { describe, expect, it } from "vitest";
import {
  BOTH_KINDS,
  DEFAULT_SHARE_CAP_CENTS,
  dollarsToCents,
  manageServices,
  parseToggle,
  serviceBlockFor,
  serviceNameFor,
  summarise,
  type Detected,
  type Detector,
  type ManageIo,
  type Probe,
} from "./services-manage.js";
import { DaemonConfig, resolveConfig } from "./config.js";
import { startability } from "./local-server.js";
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
