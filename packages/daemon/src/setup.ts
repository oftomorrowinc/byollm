import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import type { BackendId, JobKind } from "@byollm/protocol";
import { createBackend } from "./backends/index.js";
import { probeLocalServers, type LocalServer } from "./probe-local.js";
import { loginCommandFor, runLogin, type LoginCommand } from "./login.js";
import { DaemonConfig } from "./config.js";
import { TEST_YOUR_DEVICE } from "./test-your-device.js";
import type { DaemonPaths } from "./paths.js";

/**
 * `byollm setup` — byollm_015 Phase 1.
 *
 * The product's answer to "edit this JSON file". Everything else built this
 * month assumes somebody can hand-author `~/.byollm/config.json`, and normal
 * users cannot; this is the conversation that writes it for them.
 *
 * **Config is the only output.** No wizard-only state, no second config
 * surface, nothing a hand could not have written. Somebody who never runs this
 * loses convenience and nothing else, which is what keeps the file the single
 * source of truth rather than a cache of the wizard's opinions.
 */

export interface SetupIo {
  out(text: string): void;
  err(text: string): void;
  /** Asks, and returns the raw answer. Injected so tests are not a TTY. */
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
 * What answered on the local ports — injected for the same reason detection is.
 *
 * A wizard test that reaches the network tests the network. Worse, it tests
 * whatever the developer happens to be running: the empty-machine case failed
 * once already because this laptop has `claude` installed.
 */
export type Probe = () => Promise<LocalServer[]>;

/** Subscription CLIs the wizard offers, in the order it offers them. */
const SUBSCRIPTION_CLIS: readonly {
  readonly id: BackendId;
  readonly binary: string;
  readonly plan: string;
  readonly model: string;
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
    model: "gpt-5.6-terra",
    install: "npm i -g @openai/codex",
  },
]);

/** Both kinds: a subscription CLI answers chat and generate alike. */
const BOTH_KINDS: readonly JobKind[] = Object.freeze([
  "llm.generate",
  "llm.chat",
]);

/**
 * Detection means running the thing — byollm_013, and this is the wizard's
 * half of it.
 *
 * There is a real tension in the spec here and it is worth naming rather than
 * resolving silently. Detection "must mean the probe exercised the argv we
 * will actually send — never `which` alone", and the probe "must not cost a
 * token". Those pull opposite ways: the argv we actually send ends in a model
 * call, and a model call spends somebody's quota to answer a question about
 * installation.
 *
 * `health()` is where they meet. It spawns the real binary through the real
 * launch resolution — the same `resolveCliLaunch` an actual job uses, Windows
 * shim and all — and asks it for its version. That exercises precisely the
 * thing that broke for Kevin: not "is there a file named `claude` on PATH",
 * but "can this daemon, on this platform, actually start this program". What
 * it does not exercise is the flag list, which costs a token to reach and is
 * covered instead by the adversarial corpus on every run of the suite.
 *
 * So the checkmark means *startable*, and the wizard says "found" rather than
 * "working" — a smaller claim, and a true one.
 */
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
 * binary, `answers` is the credentials. The canary is the cheapest true call
 * the backend has — for a CLI, one token — and it is the same one the daemon
 * already runs at start.
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

const yes = (answer: string, fallback: boolean): boolean => {
  const text = answer.trim().toLowerCase();
  if (text === "") return fallback;
  return /^y(es)?$/.test(text);
};

export interface SetupResult {
  readonly wrote: boolean;
  readonly services: readonly string[];
  /** Whether pairing ran and succeeded. Absent when setup stopped earlier. */
  readonly connected?: boolean;
  /** Whether the background service was installed. */
  readonly running?: boolean;
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
 * up, and believing the exit code would put the wizard's whole point back
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
  io: SetupIo;
  verifier: (id: BackendId, model: string) => Promise<Detected>;
  login: (command: LoginCommand) => Promise<boolean>;
  ask: (question: string) => Promise<string>;
}): Promise<Detected> {
  const { cli, io, verifier, login, ask } = input;
  const command = loginCommandFor(cli.id);
  let proof: Detected = { installed: true, answers: false };

  for (let round = 0; round < 3; round += 1) {
    if (command !== undefined) {
      const go = await ask(`  Sign in to ${cli.binary} now? [Y/n] `);
      if (yes(go, true)) {
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
    const again = await ask(
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

export async function runSetup(
  paths: DaemonPaths,
  io: SetupIo,
  detector: Detector = detectInstalled,
  probe: Probe = () => probeLocalServers(),
  /**
   * Asks whether a found CLI can actually answer — "found" is not "works".
   *
   * Last, so that adding it did not renumber the parameters every existing
   * caller passes positionally. Which it did, briefly, and the compiler said
   * so in four places before anything ran.
   */
  verifier: (id: BackendId, model: string) => Promise<Detected> = detect,
  /**
   * Running a vendor CLI's sign-in, with this terminal — 2026-09-02.
   *
   * Injected for the same reason `verifier` is, and more urgently: the real
   * one hands the TTY to another program. A test that reached the default
   * would sit waiting for somebody to complete an OAuth flow.
   */
  login: (command: LoginCommand) => Promise<boolean> = runLogin,
  /**
   * The wizard's own hands: `connect` and `install`, run as this process.
   *
   * Injected rather than imported so a test can watch what setup decided to
   * do without pairing against a real hub or writing a launch agent. The
   * default is supplied by the CLI, which owns those verbs — passing them in
   * keeps this module from importing the command table that imports it.
   */
  run: (argv: readonly string[]) => Promise<number> = () => Promise.resolve(0),
): Promise<SetupResult> {
  if (!io.interactive) {
    io.err(
      "byollm setup needs a terminal it can ask questions in.\n" +
        "Write ~/.byollm/config.json by hand instead: " +
        "https://docs.byollm.cloud/guides/models\n",
    );
    return { wrote: false, services: [] };
  }

  // An existing config is the owner's work and is never edited from under
  // them. Offering to start over is a different thing from doing it.
  const existing = await readExisting(paths.config);
  if (existing !== undefined) {
    const count = Object.keys(existing.services).length;
    /**
     * A config with nothing in it is not work to protect — it is a dead end.
     *
     * The rule above is right: an existing config is the owner's and is never
     * edited from under them. But a file with zero services was written by a
     * version that wrote one before it knew how to find anything, and it made
     * this command unusable — "It has 0 service(s). Setup will not change it"
     * and then nothing, on a machine where setup is exactly what was needed.
     * Kevin's Windows box, and anybody who installed before alpha.44.
     *
     * So the rule keeps its teeth and gains a door: nothing is overwritten
     * without a yes, and the yes is one line rather than a wizard somebody has
     * to abandon and rerun with a flag they have to find out about.
     */
    if (count > 0) {
      io.out(
        `You already have a config at ${paths.config}.\n` +
          `It has ${String(count)} service(s). Setup will not change it.\n` +
          "Run `byollm services` to see what it does, or edit that file.\n",
      );
      return { wrote: false, services: [] };
    }
    io.out(
      `\nYour config at ${paths.config} has no services in it, so nothing\n` +
        "can run yet. That is how versions before alpha.44 left it.\n",
    );
    const go = await io.ask("  Set it up now? [Y/n] ");
    if (!yes(go, true)) {
      io.out("  Left alone. Nothing was changed.\n");
      return { wrote: false, services: [] };
    }
  }

  io.out(`\nSetting up byollm. Change any of it later in ${paths.config}.\n\n`);

  // ── 1. what this device is called ────────────────────────────────────
  const suggested = defaultDeviceName();
  const nameAnswer = await io.ask(
    `What should this device be called? [${suggested}] `,
  );
  const deviceName = nameAnswer.trim() === "" ? suggested : nameAnswer.trim();

  // ── 2. subscriptions this machine already has ────────────────────────
  const services: Record<string, unknown> = {};
  const enabled: string[] = [];

  for (const cli of SUBSCRIPTION_CLIS) {
    const found = await detector(cli.id);
    if (!found) continue;

    io.out(`\nFound the \`${cli.binary}\` CLI.\n`);
    /**
     * And whether it can answer, which is a different question.
     *
     * "Found" was the last thing setup said about a CLI, and `--version`
     * needs no credentials — so a machine whose subscription token expired
     * last week finished this wizard being told everything was fine, and
     * learned otherwise when somebody's job came back with status 1.
     *
     * Asked here rather than left to the first job, because this is the
     * moment somebody is sitting in front of a terminal ready to fix it.
     */
    let proof = await verifier(cli.id, cli.model);
    if (proof.answers === false) {
      /**
       * Stopped, not annotated — 2026-09-02.
       *
       * This printed four lines and carried on. The config it then wrote was
       * correct and the ruling underneath still stands: nothing routes until
       * the backend answers. But two machines sat in "we thought it wasn't
       * working" for days, because a logged-out CLI reached the person as a
       * *note* in a wizard that kept going and finished by saying it was done.
       *
       * A note is the wrong shape for the one condition that stops every job,
       * discovered at the one moment somebody is in front of a terminal ready
       * to fix it.
       */
      io.out(
        `  It is installed but cannot answer yet — it needs signing in.\n` +
          (proof.detail === undefined ? "" : `  ${proof.detail}\n`),
      );
      // Bound, not passed as a bare method: `io.ask` reads `this` in the
      // terminal implementation, and handing the reference over detaches it.
      proof = await signIn({
        cli,
        io,
        verifier,
        login,
        ask: (question) => io.ask(question),
      });
      if (proof.answers === false) {
        io.err(
          `\nStopped: \`${cli.binary}\` is installed and not signed in, so\n` +
            `nothing would route to it.\n\n` +
            `  Sign in with \`${loginCommandFor(cli.id)?.argv.join(" ") ?? cli.binary}\`, ` +
            `then run \`byollm setup\` again.\n` +
            `  Nothing was written; setup is safe to re-run.\n`,
        );
        return { wrote: false, services: [] };
      }
    }
    // The self-lock is spoken, not buried — byollm_015, and it is consent
    // wording, which is product law here: the moment of enablement is the
    // moment of disclosure. Said before the question, not after the answer.
    io.out(
      `  Uses your ${cli.plan}, for YOUR OWN jobs only — never shared with a\n` +
        "  team, whatever the config says. Someone else's terms are not yours\n" +
        "  to lend.\n",
    );
    const answer = await io.ask(`  Use it for your own jobs? [Y/n] `);
    if (!yes(answer, true)) continue;

    services[cli.binary] = {
      type: cli.id,
      model: cli.model,
      kinds: [...BOTH_KINDS],
    };
    enabled.push(cli.binary);
    /**
     * The default, said out loud — byollm_017 ruling 6.
     *
     * The wizard does not grow a question for this. Three questions stays
     * three, and a fourth ("which model?") would ask somebody to decide
     * something they have no basis for on the day they install. What they
     * need is to know a default was chosen on their behalf and that it is one
     * line to change — which is a sentence, not a prompt.
     */
    io.out(
      `  model: ${cli.model} — change any time with ` +
        `\`byollm model ${cli.binary} <name>\`\n`,
    );
  }

  // ── 3. local model servers, found by asking them ─────────────────────
  //
  // This used to send people to the docs to write five lines by hand, which is
  // the exact thing the wizard exists to stop. A server that is already
  // running knows its own address and its own models; the only reason to make
  // somebody retype that is that nobody asked it.
  io.out("\nLooking for local model servers...\n");
  const servers = await probe();
  if (servers.length > 0) {
    servers.forEach((server, at) => {
      const models = server.models.slice(0, 3).join(", ");
      io.out(
        `  ${String(at + 1)}. ${server.label} at ${server.baseUrl}\n` +
          (models === "" ? "" : `     ${models}\n`),
      );
    });
    const pick = await io.ask(
      `  Use which? [1-${String(servers.length)}, comma-separated, or Enter to skip] `,
    );
    for (const chosen of pickMany(pick, servers.length)) {
      const server = servers[chosen];
      if (server === undefined) continue;
      // The model is the server's own first answer. A wizard that guessed a
      // name would write a config whose route is unhealthy on first use, which
      // is worse than not writing one.
      const model = server.models[0];
      if (model === undefined) {
        io.out(
          `  ${server.label} lists no models — add one there, then rerun.\n`,
        );
        continue;
      }
      const name = nameFor(server.label, services);
      services[name] = {
        type: "openai-http",
        baseUrl: server.baseUrl,
        model,
        kinds: [...BOTH_KINDS],
      };
      enabled.push(name);
    }
  } else {
    io.out(
      "  none answering on the usual ports.\n" +
        "  A server on a port nobody guessed still works — add it by hand:\n" +
        "  https://docs.byollm.cloud/guides/models\n",
    );
  }

  if (enabled.length === 0) {
    io.out(
      "\nNothing to configure yet — no supported CLI found on this machine.\n" +
        "Install one, or add a local model:\n" +
        SUBSCRIPTION_CLIS.map(
          (cli) => `  ${cli.binary}: ${cli.install}\n`,
        ).join("") +
        "  local:  https://docs.byollm.cloud/guides/models\n",
    );
    return { wrote: false, services: [] };
  }

  // Two services answering the same kinds is exactly the ambiguity byollm_016
  // withholds a kind over. The wizard is where that gets settled, so a person
  // who used it never meets the withheld state at all — asked once, here,
  // rather than discovered later as "nothing is advertised and I don't know
  // why".
  const defaults: Record<string, string> = {};
  if (enabled.length > 1) {
    io.out(
      `\nYou enabled ${String(enabled.length)} services and both answer the same\n` +
        "kinds of work. Which should be the default?\n",
    );
    enabled.forEach((name, at) => {
      io.out(`  ${String(at + 1)}. ${name}\n`);
    });
    const pick = await io.ask(`  [1] `);
    const index = Number.parseInt(pick.trim() === "" ? "1" : pick.trim(), 10);
    // Anything unparseable falls to the first, which is what the `[1]` in the
    // prompt already promised. Erroring here would make a typo cost the whole
    // conversation.
    const chosen =
      enabled[Number.isFinite(index) ? index - 1 : 0] ?? enabled[0];
    if (chosen !== undefined) {
      for (const kind of BOTH_KINDS) defaults[kind] = chosen;
    }
  }

  const config = {
    // Whatever the owner had that this wizard does not ask about, first, so
    // the keys it *does* write win. Empty for a first run, which is the
    // common case and costs nothing.
    ...(existing?.rest ?? {}),
    services,
    ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
  };

  // Parsed before it is written, with the same schema the daemon loads. A
  // wizard that can emit a config the daemon refuses is a wizard that has
  // invented a second format.
  const parsed = DaemonConfig.safeParse(config);
  if (!parsed.success) {
    io.err(
      "the wizard built a config this daemon would refuse, which is a bug:\n" +
        parsed.error.issues
          .map((i) => `  ${i.path.join(".")}: ${i.message}`)
          .join("\n") +
        "\n",
    );
    return { wrote: false, services: [] };
  }

  await mkdir(dirname(paths.config), { recursive: true });
  // `config`, not `parsed.data` — the answers, not the answers plus every
  // default the schema filled in.
  //
  // Parsing is validation here and nothing else. `parsed.data` carries
  // `concurrency`, the community and ingress blocks, per-service
  // `offer: "private"` — today's values for settings nobody was asked about,
  // written into a file that outlives them. Tune a budget next year and every
  // wizard-written config sits on the old number, chosen by no one, and the
  // owner has no way to tell which of those lines they meant.
  //
  // A default belongs in one place. Writing it down a second time is the same
  // defect as a fixture that restates a constant: two copies, and only one of
  // them gets updated.
  await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`);

  io.out(
    `\nWrote ${paths.config}\n` +
      `  ${enabled.join(", ")} — your own jobs only\n`,
  );

  /**
   * The wizard finishes the job — ruled 2026-09-01, after two onboardings.
   *
   * It ended with "Next: byollm connect --name …", which is a correct
   * sentence and four verbs short of a working device. Both walks stopped
   * there: one ran `connect` in a window they later closed, one never ran it
   * at all. The gap is not knowledge — the line was on screen — it is that a
   * wizard which stops one step from done reads as done.
   *
   * Two questions, both defaulting yes, both composing verbs that already
   * exist. Nothing new is invented here; what changes is that the person is
   * asked rather than instructed.
   *
   * The ending is still the ruled one: the true sentence, or the single
   * command that finishes whatever was skipped. A `no` is a decision and gets
   * the command, not a warning.
   */
  const doConnect = yes(
    await io.ask("\n  Connect to byollm.cloud? [Y/n] "),
    true,
  );
  if (!doConnect) {
    io.out(
      `\n  Not connected. This device is set up and unreachable — finish with:\n` +
        `    byollm connect --name ${JSON.stringify(deviceName)}\n`,
    );
    return { wrote: true, services: enabled, connected: false, running: false };
  }

  const connected = await run(["connect", "--name", deviceName]);
  if (connected !== 0) {
    // Said plainly and not retried. Pairing can fail for reasons this wizard
    // cannot fix — no network, a hub that is draining, a code that expired
    // while somebody found their phone — and `connect` has already printed
    // which. Re-running it is one line and is safe.
    io.out(
      `\n  Pairing did not finish. Nothing else was changed — try again with:\n` +
        `    byollm connect --name ${JSON.stringify(deviceName)}\n`,
    );
    return { wrote: true, services: enabled, connected: false, running: false };
  }

  const doInstall = yes(await io.ask("\n  Run in background? [Y/n] "), true);
  if (!doInstall) {
    io.out(
      `\n  Paired, and not running. Start it when you want it:\n` +
        `    byollm install     keep it running in the background\n` +
        `    byollm run         run in this terminal\n`,
    );
    return { wrote: true, services: enabled, connected: true, running: false };
  }

  const running = await run(["install"]);
  if (running !== 0) {
    io.out(
      `\n  Paired, and could not install the background service. Either:\n` +
        `    byollm install     try again — it says why when it cannot\n` +
        `    byollm run         run in this terminal instead\n`,
    );
    return { wrote: true, services: enabled, connected: true, running: false };
  }

  io.out(
    `\n  Done. This device is set up, paired, and running in the background.\n` +
      `\n  ${TEST_YOUR_DEVICE}\n`,
  );
  return { wrote: true, services: enabled, connected: true, running: true };
}

/**
 * The existing config, whole — not just the part this wizard writes.
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
 * The whole object comes back so the write can put it back. What this wizard
 * knows about, it replaces; what it does not, it leaves alone. A tool that
 * cannot enumerate every setting it is not editing must not assume there are
 * none.
 */
async function readExisting(
  path: string,
): Promise<
  | { services: Record<string, unknown>; rest: Record<string, unknown> }
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
      // `services` and `defaults` are this wizard's to rewrite.
      if (key === "services" || key === "defaults") continue;
      if (known.has(key)) rest[key] = value;
    }

    const services = row["services"];
    return {
      services:
        typeof services === "object" && services !== null
          ? (services as Record<string, unknown>)
          : {},
      rest,
    };
  } catch {
    return undefined;
  }
}

/** A name a person would recognise, without leaking their username. */
function defaultDeviceName(): string {
  const override = process.env["BYOLLM_LABEL"];
  if (override !== undefined && override !== "") return override.slice(0, 120);
  return "my-computer";
}

/**
 * The real terminal, wired to readline.
 *
 * Streams are parameters so `ask` can be exercised without a terminal. It was
 * the one path here a test could not reach, and an unreachable path in the
 * only function that touches the user's actual stdin is the wrong thing to
 * leave dark — that is where a hang would live.
 */
export function terminalIo(
  out: (text: string) => void,
  err: (text: string) => void,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): SetupIo {
  return {
    out,
    err,
    // `@types/node` declares `isTTY` as `boolean`, and Node sets it to
    // `undefined` when the stream is not a terminal. So this comparison is
    // load-bearing even though the type says it cannot be — the linter is
    // reasoning from a declaration that is wrong about its own runtime, and
    // deleting it puts `undefined` into a field typed `boolean`.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare
    interactive: process.stdin.isTTY === true,
    async ask(question: string): Promise<string> {
      const rl = createInterface({ input, output });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}

/**
 * Which of the offered servers somebody picked.
 *
 * Forgiving on purpose: "1,3", "1 3" and "1, 3" all mean the same thing, and a
 * number nobody offered is dropped rather than fatal. Being strict here would
 * cost the whole conversation over a stray comma.
 */
function pickMany(answer: string, count: number): number[] {
  const out: number[] = [];
  for (const piece of answer.split(/[\s,]+/)) {
    if (piece === "") continue;
    const at = Number.parseInt(piece, 10);
    if (!Number.isFinite(at) || at < 1 || at > count) continue;
    if (!out.includes(at - 1)) out.push(at - 1);
  }
  return out;
}

/**
 * A config key from a server's label, unique within this config.
 *
 * The key is what `defaults` and `byollm offer` refer to, so it has to be
 * typeable — "LM Studio" becomes `lm-studio`. Two servers of the same kind on
 * different ports get `-2`, rather than the second silently replacing the
 * first, which is what a plain assignment would do.
 */
function nameFor(label: string, taken: Record<string, unknown>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .split("-")[0] ?? "local";
  if (!(base in taken)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${String(n)}`;
    if (!(candidate in taken)) return candidate;
  }
}
