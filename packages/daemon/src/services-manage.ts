import type { BackendId, BackendCost, JobKind } from "@byollm/protocol";
import { backendName, classifyCost } from "@byollm/protocol";
import { createBackend } from "./backends/index.js";
import { probeLocalServers, type LocalServer } from "./probe-local.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DaemonConfig, ServiceConfig } from "./config.js";
import { isLoopback } from "./local-server.js";
import { dollars } from "./spend.js";
import {
  loginCommandFor,
  loginPlan,
  runLogin,
  type LoginCommand,
} from "./login.js";

/**
 * The one screen that turns this machine into services — B100a, byollm_023
 * §the flow.
 *
 * Todd, 09-10: *"We already have a `byollm setup` that asks you to set up
 * claude, codex and ollama cloud if they are detected. What if we did similar
 * for adding services... Or even `byollm services manage` that lets you enable
 * and disable."* And an hour later, closing the obvious follow-up before
 * anybody built it: *"We should remove the old setup and replace with this
 * one. I shouldn't have even suggested having two."*
 *
 * So this is the module and `setup` calls it. Two implementations of one
 * question would have been instruction 9 written into the plan on purpose,
 * which is worse than the drift we normally find by accident.
 *
 * ## What it replaced, and why that was three commands
 *
 * The design before this was `services add`, `services remove` and a
 * `services try` verb — each with its own help text, its own confirmation,
 * its own tests, and each teaching the owner one more word. The picker
 * replaces all three with a gesture people already know from every Linux
 * installer, and it answers *"what could I use here"* in the same motion as
 * *"use it"*, which is the question B100 existed for.
 *
 * **Verification stopped being a step.** `try` made checking a thing an owner
 * has to know to run; here the list only contains what a live server named or
 * what a real binary answered, so the check happens by construction. The
 * residue is the memory hazard — B106 — which was never about verification
 * and is not solved by a picker.
 *
 * ## Lines, not keypresses
 *
 * Todd asked whether it is *"press 2 and it toggles a highlight of that row"*.
 * Live keypresses need raw mode. This does not and looks nearly the same:
 * print the numbered list, read a LINE, redraw with the marks moved, repeat
 * until blank. It works with the `ask` that already exists, it is testable by
 * feeding lines, and **it degrades honestly with no TTY** — which is the
 * constraint that made the raw version design rather than wiring.
 *
 * ## Kinds are not on this screen at all
 *
 * Todd: *"98% of users will not know what generate and chat mean, why they
 * exist and are separate, and what to choose."* Every service answers both,
 * so the only thing left to settle is which one wins when a job names none —
 * one question, at the end, and only when more than one service claims them.
 * Without it `resolveConfig` withholds a kind whenever two services answer
 * it, and the device advertises nothing.
 */

/** How this screen talks. Injected so tests are not a TTY. */
export interface ManageIo {
  out(text: string): void;
  err(text: string): void;
  /** Asks, and returns the raw answer. */
  ask(question: string): Promise<string>;
  /** Whether we may ask at all. */
  interactive: boolean;
}

/**
 * Whether a backend is startable on this machine.
 *
 * Injected rather than imported so a test can describe the machine it is
 * testing. The first version of the empty-machine case asserted "writes
 * nothing when no CLI is installed" and failed on a laptop that has `claude`
 * — a test whose answer depends on what the developer happens to have
 * installed says one thing here and another in CI, which is worse than no
 * test because it teaches people to re-run until green.
 */
export type Detector = (id: BackendId) => Promise<boolean>;

/**
 * What answered on the local ports — injected for the same reason detection
 * is.
 *
 * A screen test that reaches the network tests the network. Worse, it tests
 * whatever the developer happens to be running: the empty-machine case failed
 * once already because this laptop has `claude` installed.
 */
export type Probe = () => Promise<LocalServer[]>;

/**
 * What a detected CLI can actually do — found, or found *and* able to answer.
 *
 * `health()` runs `--version`, which needs no credentials. That is the right
 * question for "is it installed" and the wrong one for "will it work", and
 * setup was asking only the first and reporting "Found the `claude` CLI".
 *
 * The gap has a cost measured in evenings. A subscription token that expired
 * last week leaves a CLI that answers `--version` perfectly and every job with
 * status 1, so the machine advertises a service it cannot provide, the
 * dashboard shows it, a site sends work to it, and the first person to learn
 * is whoever was waiting for an answer. A job is not where somebody should
 * discover their token lapsed.
 *
 * So detection asks both, and they are different words: `installed` is the
 * binary, `answers` is the credentials.
 */
export interface Detected {
  /** The binary is there and runs. */
  readonly installed: boolean;
  /**
   * It answered a real prompt. `undefined` when the backend offers no canary,
   * which is not the same as `false` and must not be rendered as one.
   */
  readonly answers: boolean | undefined;
  /** Why it could not answer, in the backend's own words, for the owner. */
  readonly detail?: string | undefined;
}

export type Verifier = (id: BackendId, model: string) => Promise<Detected>;

/**
 * Subscription CLIs the screen offers, in the order it offers them — B116.
 *
 * ## The model is not ours to declare
 *
 * This carried `model: "sonnet"` for claude, and Todd's machine runs
 * `claude-opus-5`. So the picker offered his configured `claude` **and** a
 * second row called `claude-2` pinned to a model he never chose — a surface
 * deciding for itself, which is B085's shape in different clothes.
 *
 * **Checked by running the CLIs, because the obvious fix is to ask them and
 * you cannot.** `claude --help` has no models command; `claude config get
 * model` is not a command at all and runs as a PROMPT (it answered in prose
 * and spent a token); and the argv this daemon sends is frozen at
 * `--output-format text` on purpose, so the response carries no model field.
 * Three ways, no answer.
 *
 * ## So the sources are, in order
 *
 * 1. **The owner's configured service for this binary.** A machine has one
 *    `claude`, so if they have configured it, that is what it serves — and
 *    the canary then runs against the model the machine actually uses rather
 *    than against our guess.
 * 2. **A model in this build's own {@link knownModelsFor} list for that
 *    backend**, which byollm_017 already maintains as what the CLI is known
 *    to accept, and which is already announced with the capability. `sonnet`
 *    is there and is documented in `claude --help` as an alias for the latest
 *    sonnet — the CLI's word rather than ours.
 * 3. **Nothing.** Then the row is not offered, because enabling it would
 *    write a service pinned to a model nobody chose.
 *
 * `codex` is at (3) today: `gpt-5.6-terra` appears in no help output and in no
 * list this build maintains. It is Todd's configured model, which is where it
 * came from — one machine's setting, frozen into a constant for everybody.
 * The invariant test below is what stops that happening again.
 */
export const SUBSCRIPTION_CLIS: readonly {
  readonly id: BackendId;
  readonly binary: string;
  readonly plan: string;
  /**
   * What to offer on a machine that has not configured this CLI yet.
   *
   * **Optional, and absent is the honest value** — not a placeholder waiting
   * to be filled in. Every value here must appear in `knownModelsFor` for its
   * backend, which is asserted rather than promised.
   */
  readonly model?: string;
  readonly install: string;
}[] = Object.freeze([
  {
    id: "claude-cli",
    binary: "claude",
    plan: "Claude subscription",
    model: "sonnet",
    install: "https://claude.com/claude-code",
  },
  {
    id: "codex-cli",
    binary: "codex",
    plan: "ChatGPT plan",
    install: "npm i -g @openai/codex",
  },
]);

/**
 * Both kinds, on every service, always — Todd 09-10.
 *
 * *"I've never understood why we wouldn't offer one or the other since the end
 * user can just choose which to use."* Right, and it is what makes one
 * default question enough for two kinds: the same answer is legal for both
 * precisely because every service answers both. Multi-modal is a separate
 * problem and does not arrive through this constant.
 */
export const BOTH_KINDS: readonly JobKind[] = Object.freeze([
  "llm.generate",
  "llm.chat",
]);

/** The share budget offered to somebody who has never set one. */
export const DEFAULT_SHARE_CAP_CENTS = 1_000;

/**
 * A service block as it is written to `~/.byollm/config.json`.
 *
 * **Deliberately untyped, and it is the same decision `runSetup` made.** The
 * schema is `config.ts`'s and it is the thing that validates this — a second
 * TypeScript shape here would be a second definition of the config format,
 * kept in sync by hand, which is the divergence this row spent its time
 * removing elsewhere. What guards the write is `DaemonConfig.safeParse`, on
 * the real schema, before the file is touched.
 *
 * It is also the honest type for a block this screen PRESERVES. An owner's
 * `apiKeyEnv`, their `spend.centsPerMillionTokens`, a field added to the
 * schema next month: the picker does not know what is in there and must put
 * back exactly what it found.
 */
export type ServiceBlock = Record<string, unknown>;

/** A block this screen is creating, where it does know every field. */
export interface NewService {
  readonly type: BackendId;
  readonly baseUrl?: string;
  readonly model: string;
  readonly kinds: readonly JobKind[];
  readonly offer: "private" | "team";
}

/**
 * One row on the screen.
 *
 * `selected`, `shared` and `capCents` are the mutable state of the screen and
 * nothing else is: everything a row *is* comes from a probe, a canary, or the
 * owner's existing config, so a row can never describe a service that does
 * not exist.
 */
interface Candidate {
  name: string;
  /**
   * What the server is, and it can be upgraded — B116.
   *
   * Not `readonly`, unlike the address and the model, and the asymmetry is
   * the point: those two are what this row IS, and this is what we currently
   * know about it. A probe's answer replaces a config's memory.
   */
  type: BackendId;
  readonly baseUrl: string | undefined;
  readonly model: string;
  /** Recomputed when {@link Candidate.type} is, from the one classifier. */
  cost: BackendCost;
  /** True when a server answered, rather than a config remembering. */
  identified: boolean;
  /** Where it lives, in the words a person would use. */
  where: string;
  /**
   * A subscription CLI's binary, when this row is one.
   *
   * Mutable, and B117 is why: a row read from the config does not know it is
   * a CLI until detection says so, and it is the field the sign-in path keys
   * on. Set only where a binary was actually found on this machine.
   */
  binary?: string;
  /**
   * The block this row was read from, when it came from the config.
   *
   * Kept whole rather than picked apart, because the fields this screen does
   * not ask about are exactly the ones it must not lose.
   */
  readonly original?: ServiceBlock;
  /** Set when the row is a CLI that is installed and cannot answer. */
  signedOut: boolean;
  /**
   * Why, in the backend's own words.
   *
   * *"Invalid API key · Please run /login"* is the sentence that names the
   * fix, and it comes from the CLI rather than from us. Carried on the row
   * because the row is where the refusal is now said — dropping it would
   * leave "cannot answer yet" as the whole explanation, which is the
   * true-but-useless shape this project keeps having to fix.
   */
  detail?: string | undefined;
  selected: boolean;
  shared: boolean;
  capCents: number | undefined;
}

export interface ManageResult {
  /** The complete `services` map to write. Empty when nothing was decided. */
  readonly services: Record<string, ServiceBlock>;
  /** `defaults`, empty when one service makes it unnecessary. */
  readonly defaults: Partial<Record<JobKind, string>>;
  /** The names in `services`, in screen order. */
  readonly enabled: readonly string[];
  /** False when the screen could not run or the person changed nothing. */
  readonly decided: boolean;
}

/**
 * A service name from a model id — settled by Todd on 09-10.
 *
 * `smollm2:135m` becomes **`smollm2-135m`**: keep what follows the colon and
 * turn the colon into a hyphen. The earlier version dropped the tag, which
 * read better and collided — `smollm2:135m` and `smollm2:360m` were one name,
 * and a picker that wrote both would have silently kept one.
 *
 * **The namespace before a `/` still goes.** CW's ruling, Todd's to veto:
 * `mlx-community/Qwen2.5-14B-Instruct-4bit` keeps only the last segment,
 * because what precedes it is a publisher rather than a name, and
 * `mlx-community-Qwen2.5-14B-Instruct-4bit` is not a service name anybody
 * wants to type into `enqueue({ service })`.
 *
 * It is a suggestion rather than a rule: the owner's word for a service is
 * theirs, this only has to produce something legal and recognisable in a file
 * they can edit.
 */
export function serviceNameFor(model: string): string {
  /**
   * `:latest` is the tag that means "no tag", and it goes.
   *
   * The rule above keeps the tag because tags distinguish — `smollm2:135m`
   * and `smollm2:360m` are two models and must be two names. `:latest` is
   * what Ollama writes when nobody chose a tag at all, so keeping it
   * distinguishes nothing and names every default-pulled model
   * `something-latest`. Found by running this on Todd's laptop, where
   * `gemma4-agent:latest` came out as `gemma4-agent-latest`.
   *
   * It cannot cost a collision: a server holding both `x` and `x:latest`
   * still gets two names, because {@link uniqueName} is what settles that and
   * it is asked either way.
   */
  const untagged = model.replace(/:latest$/, "");
  const base = untagged.split("/").pop() ?? untagged;
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "my-model";
}

/**
 * That name, made unique in this config.
 *
 * The tag collisions are gone with the rule above, and one class remains that
 * no naming rule can remove: **the same model id behind two servers**.
 * `qwen3:8b` on Ollama and on LM Studio are two services and one name, and a
 * plain assignment would keep whichever was written second.
 */
function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${String(n)}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * The config block for one model on one server — one definition, two readers.
 *
 * `byollm services` prints this as a pasteable block when the picker has not
 * been run (B100b's sanctioned fallback), and the picker writes it. Two
 * spellings of the same block would be two answers to *"what does a service
 * for this model look like"*, which is exactly the divergence instruction 9
 * is about.
 *
 * `offer` is written out rather than left to the schema default, because a
 * service created without a visible scope is a consent decision made by a
 * tool.
 */
export function serviceBlockFor(input: {
  readonly model: string;
  readonly baseUrl: string;
  /** What the server said it is, when it said — B112. */
  readonly type?: BackendId | undefined;
}): NewService {
  return {
    /**
     * The provider the server named, or the generic transport — B112.
     *
     * This was `"openai-http"` unconditionally while the probe already knew
     * it was talking to Ollama, so the block we handed people was the one
     * config shape that **cannot be started on demand** — which B098 then has
     * to explain and offer to fix. One field, thrown away one line from where
     * it was learned.
     *
     * `openai-http` remains right for a server nobody identified. It is the
     * transport every HTTP backend speaks, so the service runs either way;
     * what the specific id buys is `startCommandFor` and a declared cost
     * class. B097 keeps the cost honest under both spellings — a `:cloud`
     * model at a loopback address is metered whichever type names it.
     */
    type: input.type ?? "openai-http",
    baseUrl: input.baseUrl,
    model: input.model,
    kinds: [...BOTH_KINDS],
    offer: "private",
  };
}

/**
 * What a line typed at the picker means.
 *
 * Forgiving about separators and unforgiving about nonsense, and the second
 * half is the load-bearing one: an unrecognised word must NOT fall through to
 * "finish". Blank means done, and a picker that treats `y` as blank ends the
 * screen on somebody answering a question it did not ask.
 */
export type Toggle =
  | { readonly kind: "done" }
  | { readonly kind: "all" }
  | {
      readonly kind: "pick";
      readonly at: readonly number[];
      /** Pieces of the line that were not rows, named rather than dropped. */
      readonly ignored: readonly string[];
    }
  | { readonly kind: "unknown"; readonly words: readonly string[] };

export function parseToggle(line: string, count: number): Toggle {
  const text = line.trim();
  if (text === "") return { kind: "done" };
  if (/^a(ll)?$/i.test(text)) return { kind: "all" };

  const at: number[] = [];
  const bad: string[] = [];
  for (const piece of text.split(/[\s,]+/)) {
    if (piece === "") continue;
    const n = Number.parseInt(piece, 10);
    if (!/^\d+$/.test(piece) || !Number.isFinite(n) || n < 1 || n > count) {
      bad.push(piece);
      continue;
    }
    if (!at.includes(n - 1)) at.push(n - 1);
  }
  /**
   * A line that was partly understood still counts as understood — and says
   * what it dropped.
   *
   * Refusing the whole line over one stray number would cost somebody their
   * other picks, which is why the forgiving half is right. **The silent half
   * was not.** Found by running it: `3,6` on a machine with five rows toggled
   * row three and dropped the six without a word, and the only clue was a
   * redraw somebody would have to diff against the last one.
   */
  if (at.length === 0) return { kind: "unknown", words: bad };
  return { kind: "pick", at, ignored: bad };
}

/**
 * Dollars typed by a person, as whole cents — Todd's wording, the daemon's
 * field.
 *
 * `spend.dailyCapCents` is the only spelling the daemon reads and the screen
 * asks in dollars, so this is the one conversion and it lives next to the
 * question that needs it.
 *
 * **Undefined for anything that is not a number**, and the caller asks again
 * rather than guessing. A cap is consent to spend somebody's money; an
 * unparseable answer to it is not a small number, it is not an answer.
 */
export function dollarsToCents(text: string): number | undefined {
  const cleaned = text.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  const dollars = Number.parseFloat(cleaned);
  if (!Number.isFinite(dollars) || dollars < 0) return undefined;
  return Math.round(dollars * 100);
}

const yesNo = (answer: string, fallback: boolean): boolean => {
  const text = answer.trim().toLowerCase();
  if (text === "") return fallback;
  return /^y(es)?$/.test(text);
};

/**
 * Detection means running the thing — byollm_013, and this is the screen's
 * half of it.
 *
 * There is a real tension in the spec and it is worth naming rather than
 * resolving silently. Detection "must mean the probe exercised the argv we
 * will actually send — never `which` alone", and the probe "must not cost a
 * token". Those pull opposite ways: the argv we actually send ends in a model
 * call, and a model call spends somebody's quota to answer a question about
 * installation.
 *
 * `health()` is where they meet — it spawns the real binary through the real
 * launch resolution, the same `resolveCliLaunch` an actual job uses, Windows
 * shim and all. The canary is the second question and the cheapest true call
 * the backend has: one token, to learn whether the credentials are live.
 */
async function detect(id: BackendId, model: string): Promise<Detected> {
  try {
    const backend = createBackend(id, {});
    const health = await backend.health();
    if (!health.healthy) {
      return {
        installed: false,
        answers: undefined,
        ...(health.detail === undefined ? {} : { detail: health.detail }),
      };
    }
    if (backend.canary === undefined) {
      return { installed: true, answers: undefined };
    }
    const proof = await backend.canary(model);
    return {
      installed: true,
      answers: proof.healthy,
      ...(proof.detail === undefined ? {} : { detail: proof.detail }),
    };
  } catch {
    return { installed: false, answers: undefined };
  }
}

export async function detectInstalled(id: BackendId): Promise<boolean> {
  try {
    const backend = createBackend(id, {});
    const health = await backend.health();
    return health.healthy;
  } catch {
    // A backend that throws while being asked whether it exists is a backend
    // that does not exist, as far as somebody setting up a laptop is
    // concerned. The detail is in `byollm services`.
    return false;
  }
}

/**
 * The sign-in loop: offer to open it, run it, ask again.
 *
 * Two mechanisms, and the ruling names both. Spawning the vendor's own login
 * is the good one — it works in a single terminal, which is the only kind a
 * hosted console or an SSH session has, and it ends by itself when the login
 * finishes. Enter-to-recheck is the fallback for where spawning interactive
 * is unreliable, and it is also what somebody gets who would rather do it
 * their own way in another window.
 *
 * The loop re-probes rather than trusting the exit code. `claude auth login`
 * exiting 0 means the command finished, not that this machine can now answer
 * a prompt — the same distinction as "installed" versus "answers", one level
 * up, and believing the exit code would put the screen's whole point back
 * where it started.
 *
 * Bounded, because a person can be stuck: three rounds, then the caller's
 * refusal. An unbounded prompt in a wizard is a wizard somebody Ctrl-Cs.
 */
async function signIn(input: {
  cli: {
    readonly id: BackendId;
    readonly binary: string;
    readonly model: string;
  };
  io: ManageIo;
  verifier: Verifier;
  login: (command: LoginCommand) => Promise<boolean>;
  platform: NodeJS.Platform;
}): Promise<Detected> {
  const { cli, io, verifier, login, platform } = input;
  const command = loginCommandFor(cli.id);
  /* Windows cannot spawn an npm `.cmd` — see login.ts. The offer to open it
     is withdrawn there rather than made and silently failed. */
  const plan = command === undefined ? undefined : loginPlan(command, platform);
  let proof: Detected = { installed: true, answers: false };

  for (let round = 0; round < 3; round += 1) {
    if (command !== undefined && plan?.kind === "print") {
      /* Told once, not offered three times: the command is the answer here,
         and asking [Y/n] again would be asking whether to do the thing this
         platform has already said it cannot do. */
      if (round === 0) io.out(`\n${plan.say}\n`);
    } else if (command !== undefined) {
      const go = await io.ask(`  Sign in to ${cli.binary} now? [Y/n] `);
      if (yesNo(go, true)) {
        io.out(`  ${command.says}\n\n`);
        // The terminal belongs to the child until it exits. Nothing is
        // captured — capturing is exactly what breaks a browser handoff or a
        // device code.
        await login(command);
        proof = await verifier(cli.id, cli.model);
        if (proof.answers !== false) return proof;
        io.out(
          `\n  Still cannot answer.` +
            (proof.detail === undefined ? "" : ` ${proof.detail}`) +
            "\n",
        );
        continue;
      }
    }

    // The fallback, and the door for somebody who wants to do it their way.
    const again = await io.ask(
      `  Sign in with \`${command?.argv.join(" ") ?? cli.binary}\` elsewhere, ` +
        `then press Enter to re-check (n to skip): `,
    );
    if (/^n(o)?$/i.test(again.trim())) return proof;
    proof = await verifier(cli.id, cli.model);
    if (proof.answers !== false) return proof;
    io.out(
      `  Still cannot answer.` +
        (proof.detail === undefined ? "" : ` ${proof.detail}`) +
        "\n",
    );
  }
  return proof;
}

/**
 * What makes two rows the same service — B116, and it is a machine, an
 * address, and a model.
 *
 * **`type` used to be in this key, and that is the whole bug.** Todd's config
 * says `openai-http` at `127.0.0.1:11434` for `glm-5.2:cloud`; B112 taught the
 * probe to say `ollama` for the same address and the same model. Two keys, two
 * rows, one model — and enabling both writes two services where only one
 * carries his spend cap. The words a config happens to use are not what a
 * service IS.
 *
 * **Different models stay different services, and that is wanted rather than
 * tolerated.** `claude-sonnet-5` and `claude-opus-5` cost differently and
 * answer differently, and choosing between them is what a picker is for.
 *
 * **Loopback spellings collapse to one token.** `localhost:11434` and
 * `127.0.0.1:11434` are one machine and one port, and a config using one
 * spelling beside a probe using the other is a third way to get a duplicate.
 * The set of spellings is `isLoopback`'s, asked rather than restated.
 *
 * A process-class backend has no address, so its binary is its address: a
 * machine has one `claude`.
 */
function identityOf(input: {
  readonly type: BackendId;
  readonly baseUrl: string | undefined;
  readonly model: string;
}): string {
  return `${addressOf(input.type, input.baseUrl)} ${input.model}`;
}

function addressOf(type: BackendId, baseUrl: string | undefined): string {
  if (baseUrl === undefined) return `cli:${type}`;
  try {
    const url = new URL(baseUrl);
    return isLoopback(baseUrl)
      ? `local:${url.port}`
      : `${url.protocol}//${url.host}`;
  } catch {
    return baseUrl.trim();
  }
}

/** The three blocks, in the order they are shown. */
const GROUPS: readonly {
  readonly cost: BackendCost;
  readonly heading: string;
}[] = Object.freeze([
  {
    cost: "subscription",
    heading: "subscriptions this machine is signed in to",
  },
  { cost: "free", heading: "models on this machine" },
  {
    cost: "metered",
    heading: "models this machine can reach, billed to your account",
  },
]);

/**
 * The screen, as lines — grouped, numbered, and marked.
 *
 * Local and `:cloud` in separate blocks is Todd's ruling and it is not
 * cosmetic: they are separate decisions with separate consequences, and a
 * single list headed "on this machine" already nearly shipped a metered paste
 * once (B100b, caught by running it on Todd's laptop).
 *
 * **Every row shows its cost class**, because consenting to spend money on
 * something that is not labelled as costing money is not consent.
 */
function renderChoices(rows: readonly Candidate[]): string[] {
  const lines: string[] = [];
  let heading: string | undefined;
  rows.forEach((row, at) => {
    /**
     * Numbered from the array, and the heading follows the rows.
     *
     * The first version walked the groups and numbered inside each one, which
     * made the number on screen a function of the grouping and the number the
     * toggle reads a function of the array — two numbering schemes that agree
     * only while the array happens to be sorted. **A mutation that deleted
     * the sort changed nothing that any test could see, and would have moved
     * every mark to the wrong row on a machine whose probe answered in a
     * different order.** So the number is the index, always, and the group is
     * a heading printed when it changes.
     */
    const group = GROUPS.find((entry) => entry.cost === row.cost);
    if (group?.heading !== heading) {
      if (heading !== undefined) lines.push("");
      heading = group?.heading;
      lines.push(`  ${heading ?? "other"}`);
    }
    const mark = row.selected ? "x" : " ";
    const note = row.signedOut
      ? "signed out"
      : row.cost === "subscription"
        ? "your subscription — your own jobs only"
        : row.cost === "metered"
          ? "metered — runs on your provider's account"
          : "free — your electricity";
    lines.push(
      `   ${String(at + 1).padStart(2)}. [${mark}] ${row.name.padEnd(24)} ${row.where}`,
    );
    lines.push(`${" ".repeat(31)}${note}`);
  });
  lines.push("");
  return lines;
}

/**
 * Everything this machine could run, from three sources that must agree.
 *
 * The third source is the one it is easy to leave out and the one that makes
 * this safe to re-run: **services already in the config that no probe found**.
 * A hand-written `anthropic` entry, or a server on a port nobody guesses,
 * appears here pre-marked — because a screen that rewrites `services` while
 * only knowing about two thirds of it is a screen that deletes somebody's
 * work. Deselecting is how a service is removed, and it has to be a choice.
 */
async function candidates(input: {
  readonly existing: Record<string, ServiceBlock>;
  readonly detector: Detector;
  readonly verifier: Verifier;
  readonly probe: Probe;
  readonly io: ManageIo;
}): Promise<{
  readonly rows: Candidate[];
  /** Entries the schema refused, put back untouched. */
  readonly unreadable: Record<string, ServiceBlock>;
}> {
  const rows: Candidate[] = [];
  const unreadable: Record<string, ServiceBlock> = {};
  const seen = new Map<string, Candidate>();
  const names = new Set<string>();

  /**
   * Add a row, or merge it into the one that is already this service — B116.
   *
   * **The merged row takes each field from whoever actually knows it.** The
   * owner's decisions win, always: the name they gave it, the offer, the cap,
   * the `apiKeyEnv`, anything they typed. **The probe wins `type`**, and only
   * `type`, because the probe asked the server what it is and the config only
   * remembers what somebody typed once.
   *
   * That direction is not a preference. `startCommandFor` switches on `type`,
   * so `openai-http` is the one shape that **cannot be started on demand** —
   * letting a stored guess beat an observation would silently un-start a
   * server we proved we can start, in the field, on `.88`. So a stored
   * `openai-http` at an address the probe now names `ollama` is UPGRADED here
   * and written that way, not preserved.
   */
  const add = (row: Candidate): void => {
    const key = identityOf(row);
    const already = seen.get(key);
    if (already !== undefined) {
      if (row.identified && !already.identified) {
        already.type = row.type;
        already.identified = true;
        /* The label too: it came from the same answer, and a row saying
           "Ollama" beside a type of `openai-http` is the disagreement this
           row exists to end. */
        already.where = row.where;
        /* Cost is re-asked rather than carried, because the type it was
           computed from just changed. One classifier, asked again — not a
           second opinion. */
        already.cost = classifyCost(
          already.type,
          already.baseUrl,
          already.model,
        ).cost;
      }
      return;
    }
    row.name = uniqueName(row.name, names);
    names.add(row.name);
    seen.set(key, row);
    rows.push(row);
  };

  /* The config first, so its names, shares and caps win over a probe's
     suggestions for the same service. Re-running shows what is already there,
     which is what makes this one screen rather than two. */
  for (const [name, block] of Object.entries(input.existing)) {
    /**
     * Read through the real schema, and a block it refuses is left alone.
     *
     * This screen rewrites `services` wholesale, so an entry it cannot
     * understand is an entry it would delete. `ServiceConfig` is the same
     * parser the daemon loads with, which means "understood here" and
     * "understood there" cannot drift — and the alternative, reaching into
     * `block["type"]` by hand, is a second reader of the config format.
     */
    const parsed = ServiceConfig.safeParse(block);
    if (!parsed.success) {
      input.io.out(
        `\n  ${name} is in your config in a shape this screen does not\n` +
          `  understand, so it is left exactly as it is.\n`,
      );
      unreadable[name] = block;
      continue;
    }
    const service = parsed.data;
    add({
      name,
      type: service.type,
      baseUrl: service.baseUrl,
      model: service.model,
      cost: classifyCost(service.type, service.baseUrl, service.model).cost,
      where:
        service.baseUrl === undefined
          ? backendName(service.type)
          : `${backendName(service.type)} at ${service.baseUrl}`,
      original: block,
      identified: false,
      signedOut: false,
      selected: true,
      shared: service.offer === "team",
      capCents: service.spend?.dailyCapCents,
    });
  }

  for (const cli of SUBSCRIPTION_CLIS) {
    if (!(await input.detector(cli.id))) continue;

    /**
     * A machine has one `claude` — B116 — and it can serve several models.
     *
     * If the owner already configured services for this binary, those rows
     * ARE this CLI and detection annotates them rather than adding another.
     * Keying on the model would not do it: their `claude-opus-5` and our
     * `sonnet` are genuinely different models, and the fix is to stop having
     * an opinion about which one their machine runs.
     *
     * **`filter`, not `find` — B117, a regression B116 created.** "A machine
     * has one `claude`" is true of the BINARY; answerability is per (binary,
     * model), which is why `verifier` takes both. B116 made
     * one-binary-many-models reachable and left this loop assuming one row
     * per binary, so with `claude-opus-5` and `claude-sonnet-5` both
     * configured the canary ran once, for the first, and the second row was
     * pre-selected showing nothing wrong. Our own ruling landing in half the
     * code.
     *
     * One real call per configured model is the honest cost of that: the
     * question "can this machine answer" has a different answer for each of
     * them, and a machine cannot be asked once about two.
     */
    const configured = rows.filter((row) => row.type === cli.id);
    if (configured.length > 0) {
      for (const row of configured) {
        const proof = await input.verifier(cli.id, row.model);
        row.signedOut = proof.answers === false;
        row.detail = proof.detail;
        /**
         * The binary, carried onto the row it belongs to — B117's second half,
         * and it bit the ONE-service case too.
         *
         * `binary` was set only on rows this branch ADDS, and the sign-in
         * path skips a row without one. So a configured CLI that could not
         * answer was marked `signed out` on screen, never offered the sign-in,
         * never deselected, and written into the config anyway — the exact
         * "a note in a wizard that finished by saying it was done" failure
         * that path exists to prevent, reintroduced by the row that stopped
         * duplicating it.
         */
        row.binary = cli.binary;
      }
      continue;
    }

    const model = cli.model;
    if (model === undefined) {
      /* Detected, and not offered: we have no model we can stand behind, and
         a row enabled here would write one nobody chose. Said rather than
         skipped in silence — the binary IS on this machine, and a screen that
         omits it without a word looks broken to whoever installed it. */
      input.io.out(
        `\n  \`${cli.binary}\` is installed, and byollm does not know which ` +
          `model it serves.\n  Add it by hand and it will appear here next ` +
          `time: https://docs.byollm.cloud/guides/models\n`,
      );
      continue;
    }

    const proof = await input.verifier(cli.id, model);
    add({
      name: uniqueName(cli.binary, names),
      type: cli.id,
      baseUrl: undefined,
      model,
      cost: "subscription",
      where: `your ${cli.plan}`,
      binary: cli.binary,
      /* A process backend was detected by RUNNING it, so its id is an
         observation rather than a stored word — and nothing else can name a
         binary, so there is no probe to disagree with. */
      identified: true,
      signedOut: proof.answers === false,
      ...(proof.detail === undefined ? {} : { detail: proof.detail }),
      selected: false,
      shared: false,
      capCents: undefined,
    });
  }

  input.io.out("\nLooking for local model servers...\n");
  for (const server of await input.probe()) {
    for (const model of server.models) {
      const block = serviceBlockFor({
        model,
        baseUrl: server.baseUrl,
        type: server.backendId,
      });
      add({
        name: serviceNameFor(model),
        type: block.type,
        baseUrl: block.baseUrl,
        model,
        // Asked of the one classifier rather than decided here. A `:cloud`
        // model on a loopback port is metered, and a surface that classified
        // for itself is the defect B085 arrived as.
        cost: classifyCost(block.type, block.baseUrl, model).cost,
        where: `${server.label} at ${server.baseUrl}`,
        /* Only when a server actually named itself. `undefined` from the
           probe is "we did not verify a provider" — it must not beat a
           config's `ollama` with a generic `openai-http`. */
        identified: server.backendId !== undefined,
        signedOut: false,
        selected: false,
        shared: false,
        capCents: undefined,
      });
    }
  }

  /* Screen order, not discovery order: the groups are the screen, and a row
     that renders in block three must be numbered in block three. */
  const rank = new Map(GROUPS.map((group, at) => [group.cost, at]));
  rows.sort((a, b) => (rank.get(a.cost) ?? 9) - (rank.get(b.cost) ?? 9));
  return { rows, unreadable };
}

/**
 * The whole screen. Returns the `services` map and `defaults` to write.
 *
 * Nothing is written here: `setup` and `byollm services manage` own the file,
 * and this owns the conversation. Same reason `runSetup` parses before it
 * writes — a screen that can emit a config the daemon refuses has invented a
 * second format.
 */
export async function manageServices(input: {
  readonly io: ManageIo;
  readonly existing: Record<string, ServiceBlock>;
  readonly detector?: Detector;
  readonly verifier?: Verifier;
  readonly probe?: Probe;
  readonly login?: (command: LoginCommand) => Promise<boolean>;
  readonly platform?: NodeJS.Platform;
}): Promise<ManageResult> {
  const io = input.io;
  const empty: ManageResult = {
    services: {},
    defaults: {},
    enabled: [],
    decided: false,
  };
  if (!io.interactive) {
    io.err(
      "byollm services manage needs a terminal it can ask questions in.\n" +
        "Edit ~/.byollm/config.json instead: " +
        "https://docs.byollm.cloud/guides/models\n",
    );
    return empty;
  }

  const detector = input.detector ?? detectInstalled;
  const verifier = input.verifier ?? detect;
  const probe = input.probe ?? (() => probeLocalServers());
  const platform = input.platform ?? process.platform;
  const login =
    input.login ??
    ((command: LoginCommand) =>
      runLogin(command, (text) => {
        io.err(text);
      }));

  const { rows, unreadable } = await candidates({
    existing: input.existing,
    detector,
    verifier,
    probe,
    io,
  });

  if (rows.length === 0) {
    io.out(
      "\nNothing to configure yet — no supported CLI, and no model server\n" +
        "answering on this machine. Install one, or add a model by hand:\n" +
        SUBSCRIPTION_CLIS.map(
          (cli) => `  ${cli.binary}: ${cli.install}\n`,
        ).join("") +
        "  local:  https://docs.byollm.cloud/guides/models\n",
    );
    return empty;
  }

  // ── 1. what this machine may run ──────────────────────────────────────
  io.out(
    "\nWhat should byollm be able to run on this machine?\n" +
      "  Type a number to turn one on or off, `a` for all, Enter when done.\n\n",
  );
  await pick(io, rows, () => renderChoices(rows));

  const chosen = rows.filter((row) => row.selected);
  if (chosen.length === 0) {
    io.out("\nNothing selected.\n");
    return empty;
  }

  // ── 2. a CLI that cannot answer is not written down ────────────────────
  //
  // Setup used to stop the whole wizard here, and the reasoning was right:
  // a logged-out CLI reached the person as a *note* in a wizard that kept
  // going and finished by saying it was done, and two machines sat in "we
  // thought it wasn't working" for days.
  //
  // **What changed is only where the loudness lives.** Stopping a screen that
  // is also the re-run path would throw away every other choice somebody just
  // made, over one expired token. So the refusal moved onto the row: the sign-
  // in is offered here, and a CLI that still cannot answer is DESELECTED and
  // said out loud rather than written into a config that would claim it works.
  for (const row of chosen) {
    if (!row.signedOut || row.binary === undefined) continue;
    io.out(
      `\n\`${row.binary}\` is installed and cannot answer yet — it needs signing in.\n` +
        (row.detail === undefined ? "" : `  ${row.detail}\n`),
    );
    const proof = await signIn({
      cli: { id: row.type, binary: row.binary, model: row.model },
      io,
      verifier,
      login,
      platform,
    });
    if (proof.answers === false) {
      row.selected = false;
      io.out(
        `\n  Leaving \`${row.binary}\` out: it is installed and not signed in, so\n` +
          `  nothing would route to it. Sign in with ` +
          `\`${loginCommandFor(row.type)?.argv.join(" ") ?? row.binary}\`, then\n` +
          `  run \`byollm services manage\` again.\n`,
      );
      continue;
    }
    row.signedOut = false;
  }

  const enabled = rows.filter((row) => row.selected);
  if (enabled.length === 0) {
    io.out("\nNothing left to write.\n");
    return empty;
  }

  /* Said before the sharing question, not after it: the self-lock is consent
     wording, and the moment of enablement is the moment of disclosure. */
  const locked = enabled.filter((row) => row.cost === "subscription");
  if (locked.length > 0) {
    io.out(
      `\n${locked.map((row) => row.name).join(", ")} ` +
        `${locked.length === 1 ? "uses" : "use"} your own subscription, for YOUR\n` +
        "OWN jobs only — never shared with a team, whatever the config says.\n" +
        "Someone else's terms are not yours to lend.\n",
    );
  }

  // ── 3. the team, asked before anything is priced ───────────────────────
  //
  // Todd: ask about the team FIRST and skip the whole branch on no. Most
  // people are one person on one machine, and a wizard that asks them to
  // price something for nobody is a wizard that teaches them their answers do
  // not matter.
  const shareable = enabled.filter((row) => row.cost !== "subscription");
  let anyShared = false;
  if (shareable.length > 0) {
    const hasTeam = yesNo(
      await io.ask(
        "\nDo you have, or plan to create, a team to share these services\n" +
          "with on this computer? [y/N] ",
      ),
      false,
    );
    if (hasTeam) {
      io.out(
        "\nWhich of these may your team use?\n" +
          "  Same list: a number turns one on or off, `a` for all, Enter when done.\n\n",
      );
      if (locked.length > 0) {
        io.out(
          `  not shareable: ${locked.map((row) => row.name).join(", ")} — ` +
            "runs on your own subscription\n\n",
        );
      }
      await pick(
        io,
        shareable,
        () => renderShares(shareable),
        (row) => {
          row.shared = !row.shared;
        },
        (row) => row.shared,
      );

      // ── 4. the money, only where somebody else spends it ───────────────
      //
      // Free rows never reach this: there is nothing to cap. No owner-side
      // metering either — ruled and closed — and the code agrees, `spend.ts`
      // is explicit that only community metered work consults the cap.
      for (const row of shareable.filter(
        (candidate) => candidate.shared && candidate.cost === "metered",
      )) {
        const cents = await askCap(io, row);
        if (cents === 0) {
          row.shared = false;
          row.capCents = undefined;
          io.out(`  ${row.name} stays private.\n`);
          continue;
        }
        row.capCents = cents;
      }
      anyShared = shareable.some((row) => row.shared);
    }
  }

  // ── 5. one question, two kinds ─────────────────────────────────────────
  const defaults: Partial<Record<JobKind, string>> = {};
  if (enabled.length > 1) {
    io.out("\nWhat would you like your default service to be?\n");
    /* Claude if it was selected, which is deliberate. A subscription default
       means a teammate's job that names no service is refused as
       `default-unusable` — and Todd ruled that is correct rather than a
       defect: *"they are probably using my share for a specific model I make
       available, which is likely not my personal default"*. A teammate
       reaching for a shared machine names the service they were given. */
    const preferred = enabled.findIndex((row) => row.type === "claude-cli");
    const fallback = preferred === -1 ? 0 : preferred;
    enabled.forEach((row, at) => {
      /* Suggested by Todd as a one-line addition rather than a different
         ruling: when anything was shared, say which choices cannot serve the
         people it was shared with. */
      const note =
        anyShared && row.cost === "subscription"
          ? "  (cannot serve teammates)"
          : "";
      io.out(`  ${String(at + 1)}. ${row.name}${note}\n`);
    });
    const answer = await io.ask(`  [${String(fallback + 1)}] `);
    const typed = Number.parseInt(answer.trim(), 10);
    /* Anything unparseable falls to the offered row, which the prompt already
       promised. Erroring here would make a typo cost the whole conversation.
       Nothing is spent by this answer, which is why it may be forgiving where
       the cap question is not. */
    const winner =
      enabled[Number.isFinite(typed) ? typed - 1 : fallback] ??
      enabled[fallback];
    if (winner !== undefined) {
      for (const kind of BOTH_KINDS) defaults[kind] = winner.name;
    }
  }

  /* Blocks the schema refused first, so a name collision cannot let the
     screen overwrite one it has already promised to leave alone. */
  const services: Record<string, ServiceBlock> = { ...unreadable };
  for (const row of enabled) services[row.name] = draftOf(row);

  return {
    services,
    defaults,
    enabled: enabled.map((row) => row.name),
    decided: true,
  };
}

/**
 * One row, as the config block it becomes.
 *
 * **A row that came from the config is edited, not rebuilt.** This screen asks
 * about two things — whether a service exists and who may use it — so those
 * are the only two fields it may change. An owner's `apiKeyEnv`, their
 * `spend.centsPerMillionTokens`, a `kinds` list naming one kind on purpose:
 * all of it is put back exactly as it was found.
 *
 * **Which means an existing service keeps its declared kinds.** "Both kinds on
 * every service" is the rule for services this screen CREATES; applying it to
 * a hand-written single-kind entry would be the picker widening what a machine
 * answers without ever asking about it, in a screen whose whole premise is
 * that kinds are hidden from the person. Recorded rather than assumed, per
 * instruction 11: what would change it is a reason to believe a single-kind
 * service is always a mistake.
 */
function draftOf(row: Candidate): ServiceBlock {
  const shared = row.shared && row.cost !== "subscription";
  const base: ServiceBlock =
    row.original ??
    ({
      type: row.type,
      ...(row.baseUrl === undefined ? {} : { baseUrl: row.baseUrl }),
      model: row.model,
      kinds: [...BOTH_KINDS],
    } satisfies ServiceBlock);

  /* The acknowledgement and the ceiling arrive together or not at all.
     `resolveConfig` refuses a widened metered service that has one without the
     other, so a screen that collected them separately could write a config the
     daemon then rejects — the person finding out later from an error rather
     than sooner from a question. */
  const previous = base["spend"];
  const spend =
    shared && row.cost === "metered" && row.capCents !== undefined
      ? {
          ...(typeof previous === "object" && previous !== null
            ? previous
            : {}),
          acknowledged: true,
          dailyCapCents: row.capCents,
        }
      : /* Kept, not cleared, when sharing is turned off. Somebody answering
           "0 disables sharing" said what to do with the offer, not what to
           forget about their ceiling — and the number is theirs. */
        previous;

  return {
    ...base,
    /**
     * The type this row actually is, over whatever the file remembered —
     * B116, and it is the one owner-typed field this screen overwrites.
     *
     * Instruction 10 makes this a migration rather than a compatibility
     * problem: nothing is backwards compatible until we are live, and the
     * consumers of this file are four machines we can name. A stored
     * `openai-http` at an address the probe calls `ollama` is a service that
     * cannot be started on demand, and the whole point of B116 is that we
     * know better at the moment we write.
     *
     * It is not a licence to rewrite anything else. `identified` is false for
     * every row that only a config knows about, so a hand-written service at
     * a port nobody probes keeps its type untouched.
     */
    type: row.type,
    offer: shared ? "team" : "private",
    ...(spend === undefined ? {} : { spend }),
  };
}

/** The sharing pass, rendered from the same rows with a different mark. */
function renderShares(rows: readonly Candidate[]): string[] {
  return rows.map((row, at) => {
    const mark = row.shared ? "x" : " ";
    const cost =
      row.cost === "metered"
        ? "metered — your account pays for their jobs"
        : "free — your electricity";
    return `   ${String(at + 1).padStart(2)}. [${mark}] ${row.name.padEnd(24)} ${cost}`;
  });
}

/**
 * The toggle loop itself: draw, read a line, move the marks, draw again.
 *
 * Bounded at a hundred rounds. Not a real limit for a person — it is the
 * guard against a caller whose `ask` returns the same non-empty string
 * forever, which is what a piped stdin does at end of input, and an
 * unbounded loop there is a CLI that hangs instead of finishing.
 */
async function pick(
  io: ManageIo,
  rows: Candidate[],
  render: () => string[],
  toggle: (row: Candidate) => void = (row) => {
    row.selected = !row.selected;
  },
  isOn: (row: Candidate) => boolean = (row) => row.selected,
): Promise<void> {
  for (let round = 0; round < 100; round += 1) {
    for (const line of render()) io.out(`${line}\n`);
    const answer = await io.ask("  > ");
    const verdict = parseToggle(answer, rows.length);
    if (verdict.kind === "done") return;
    if (verdict.kind === "unknown") {
      io.out(
        `\n  "${verdict.words.join(" ")}" is not a number on this list. ` +
          `Type 1-${String(rows.length)}, \`a\`, or Enter to finish.\n\n`,
      );
      continue;
    }
    if (verdict.kind === "all") {
      /* Toggle, not set: `a` turns everything on, and turns everything off
         when it is already on. Both gestures out of one key, and the second
         is the only way to clear a list somebody filled by accident. */
      const turningOn = !rows.every((row) => isOn(row));
      for (const row of rows) if (isOn(row) !== turningOn) toggle(row);
    } else {
      for (const at of verdict.at) {
        const row = rows[at];
        if (row !== undefined) toggle(row);
      }
      if (verdict.ignored.length > 0) {
        io.out(
          `\n  ignored ${verdict.ignored.join(", ")} — ` +
            `this list stops at ${String(rows.length)}.\n`,
        );
      }
    }
    io.out("\n");
  }
}

/**
 * The cap, in Todd's words and the daemon's units.
 *
 * *"You authorized the team to spend up to this amount on model &lt;name&gt;
 * each day in dollars (0 disables sharing)"* — the sentence is the
 * acknowledgement, which is why `spend.acknowledged` is set from answering it
 * rather than from a second question.
 *
 * **Fails closed.** Three unparseable answers leave the service private
 * rather than falling back to the offered default: the default is an offer,
 * and an offer nobody accepted is not consent to spend their money.
 */
async function askCap(io: ManageIo, row: Candidate): Promise<number> {
  const offered = row.capCents ?? DEFAULT_SHARE_CAP_CENTS;
  for (let round = 0; round < 3; round += 1) {
    const answer = await io.ask(
      `\n  You authorized the team to spend up to this amount on model ` +
        `${row.name}\n  each day, in dollars (0 disables sharing): ` +
        `[${dollars(offered).replace("$", "")}] `,
    );
    if (answer.trim() === "") return offered;
    const cents = dollarsToCents(answer);
    if (cents !== undefined) return cents;
    io.out(
      `  "${answer.trim()}" is not an amount. Type a number of dollars, ` +
        `like 10 or 2.50.\n`,
    );
  }
  io.out(`  No amount given, so ${row.name} stays private.\n`);
  return 0;
}

/**
 * The existing config, whole — not just the part this screen writes.
 *
 * It used to return `{ services }` and nothing else, and the wizard then wrote
 * `{ services, defaults }` over the top. Every other key the owner had was
 * silently dropped: `concurrency`, the community and ingress blocks, a
 * per-service `offer`. Settings somebody chose deliberately, deleted by a
 * command that never said it would touch them.
 *
 * It only bites on a config with **zero** services, because a config with any
 * is refused a few lines up — which is exactly why it survived. The path that
 * loses the owner's work is the path taken by people whose config a previous
 * version left empty, i.e. the people already having a bad time.
 *
 * The whole object comes back so the write can put it back. What this screen
 * knows about, it replaces; what it does not, it leaves alone. A tool that
 * cannot enumerate every setting it is not editing must not assume there are
 * none.
 */
export async function readExistingConfig(
  path: string,
): Promise<
  | { services: Record<string, ServiceBlock>; rest: Record<string, unknown> }
  | undefined
> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null)
      return { services: {}, rest: {} };
    const row = parsed as Record<string, unknown>;

    /**
     * Carried across only if the daemon would still accept it.
     *
     * The first version of this kept every key it did not recognise, and the
     * existing suite refused it within the minute: a pre-alpha.44 config
     * carries `device`, `DaemonConfig` is `.strict()`, and the wizard's own
     * "would the daemon load this?" check then failed. Preserving a key the
     * schema has since dropped does not save somebody's work — it writes a
     * file that will not load, which is worse than the deletion it was
     * fixing.
     *
     * So the set is the schema's own top-level keys, read from the schema
     * rather than typed out here. A setting added to `DaemonConfig` next month
     * survives a re-run without anybody remembering this function.
     */
    const known = new Set(Object.keys(DaemonConfig.shape));
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      // `services` and `defaults` are this screen's to rewrite.
      if (key === "services" || key === "defaults") continue;
      if (known.has(key)) rest[key] = value;
    }

    const services = row["services"];
    /**
     * Typed as blocks, and every reader re-parses.
     *
     * Nothing here has been validated — this is `JSON.parse` output from a
     * file a hand may have written — so the type is a claim about shape and
     * not about contents. It is safe because {@link candidates} puts every
     * entry through `ServiceConfig` before it becomes a row, and an entry that
     * fails is carried back out untouched rather than interpreted.
     */
    return {
      services:
        typeof services === "object" && services !== null
          ? (services as Record<string, ServiceBlock>)
          : {},
      rest,
    };
  } catch {
    return undefined;
  }
}

/**
 * Write the screen's answers, through the schema the daemon actually loads.
 *
 * **One writer, because there are two callers now.** `setup` wrote this block
 * and `services manage` would have written the same one — including the
 * subtle half, which is that `config` is written and never `parsed.data`.
 *
 * Parsing is validation here and nothing else. `parsed.data` carries
 * `concurrency`, the community and ingress blocks, per-service
 * `offer: "private"` — today's values for settings nobody was asked about,
 * written into a file that outlives them. Tune a budget next year and every
 * screen-written config sits on the old number, chosen by no one, and the
 * owner has no way to tell which of those lines they meant. A default belongs
 * in one place; writing it down a second time is the same defect as a fixture
 * that restates a constant.
 */
export async function writeManaged(
  path: string,
  io: ManageIo,
  rest: Record<string, unknown>,
  outcome: ManageResult,
): Promise<boolean> {
  const config = {
    // Whatever the owner had that this screen does not ask about, first, so
    // the keys it *does* write win.
    ...rest,
    services: outcome.services,
    ...(Object.keys(outcome.defaults).length > 0
      ? { defaults: outcome.defaults }
      : {}),
  };

  // A screen that can emit a config the daemon refuses is a screen that has
  // invented a second format.
  const parsed = DaemonConfig.safeParse(config);
  if (!parsed.success) {
    io.err(
      "byollm built a config this daemon would refuse, which is a bug:\n" +
        parsed.error.issues
          .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
          .join("\n") +
        "\n",
    );
    return false;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  return true;
}

/**
 * What was written, per service, in the words that describe THIS config.
 *
 * The line it replaces said *"claude, qwen — your own jobs only"* for every
 * config the wizard could write, which was true right up until this screen
 * could share one. A summary that cannot be wrong about the thing it
 * summarises is a summary nobody has to check.
 */
export function summarise(outcome: ManageResult): string[] {
  return outcome.enabled.map((name) => {
    const block = outcome.services[name] as
      { offer?: unknown; spend?: { dailyCapCents?: number } } | undefined;
    if (block?.offer !== "team") return `  ${name} — your own jobs only`;
    const cap = block.spend?.dailyCapCents;
    return (
      `  ${name} — your team may use it` +
      (cap === undefined ? "" : `, up to ${dollars(cap)} a day`)
    );
  });
}

/**
 * A configured service whose type contradicts what the server says it is —
 * B116, and it is the check that keeps this closed.
 *
 * **The rule: nothing a probe identified may carry a different type.** Todd's
 * file today has `glm-5.2` as `openai-http` at `127.0.0.1:11434`, and that
 * address answers Ollama's own API. `openai-http` is the one shape
 * `startCommandFor` has no command for, so that service is the one thing on
 * his machine that cannot be started on demand — which is exactly the
 * capability we proved works in the field an hour ago.
 *
 * **`:cloud` is the sharp case and it lands the same way.** An `ollama:cloud`
 * model is served by an Ollama daemon on loopback: it is `type: "ollama"` and
 * it is startable. Metered is a COST fact, not a transport fact — B097 reads
 * the tag before the declared cost, so typing it `ollama` cannot make it look
 * free. **Nothing Ollama serves may be typed `openai-http`.**
 *
 * `openai-http` stays right for a server nobody identified, and that is all it
 * is for: the generic transport, not somewhere to fall back to when the
 * specific id is inconvenient to carry. A service at a port no probe visits —
 * Todd's MLX on 6999 — is untouched by this, which is the control.
 */
export interface MisTyped {
  readonly service: string;
  readonly stored: BackendId;
  readonly probed: BackendId;
  readonly baseUrl: string;
}

export function misTypedServices(input: {
  readonly services: Record<string, ServiceBlock>;
  readonly servers: readonly LocalServer[];
}): MisTyped[] {
  /* Only servers that NAMED themselves. A probe that identified nothing has
     no opinion to enforce, and treating its silence as `openai-http` would
     turn "we did not ask" into a finding. */
  const identified = new Map<string, BackendId>();
  for (const server of input.servers) {
    if (server.backendId === undefined) continue;
    identified.set(
      addressOf(server.backendId, server.baseUrl),
      server.backendId,
    );
  }

  const found: MisTyped[] = [];
  for (const [name, block] of Object.entries(input.services)) {
    const parsed = ServiceConfig.safeParse(block);
    if (!parsed.success) continue;
    const service = parsed.data;
    if (service.baseUrl === undefined) continue;
    const probed = identified.get(addressOf(service.type, service.baseUrl));
    if (probed === undefined || probed === service.type) continue;
    found.push({
      service: name,
      stored: service.type,
      probed,
      baseUrl: service.baseUrl,
    });
  }
  return found;
}

/** The lines `byollm services` prints about them, or nothing. */
export function misTypedReport(found: readonly MisTyped[]): string[] {
  if (found.length === 0) return [];
  return found.flatMap((row) => [
    `  ! ${row.service}: your config says "${row.stored}", and ${row.baseUrl} ` +
      `answers as ${backendName(row.probed)}.`,
    `      byollm only starts a server whose service names it, so this one ` +
      `will not be started`,
    `      when a job needs it. \`byollm services manage\` fixes it, or set ` +
      `"type": "${row.probed}".`,
  ]);
}
