import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { BACKENDS, type BackendId, type JobKind } from "@byollm/protocol";
import { createBackend } from "./backends/index.js";
import { DaemonConfig } from "./config.js";
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
}

export async function runSetup(
  paths: DaemonPaths,
  io: SetupIo,
  detector: Detector = detectInstalled,
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
    io.out(
      `You already have a config at ${paths.config}.\n` +
        `It has ${String(Object.keys(existing.services).length)} service(s). ` +
        "Setup will not change it.\n" +
        "Run `byollm services` to see what it does, or edit that file.\n",
    );
    return { wrote: false, services: [] };
  }

  io.out(
    "\nSetting up byollm. Three questions, and you can change any of it\n" +
      `later by editing ${paths.config}.\n\n`,
  );

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
    // The self-lock is spoken, not buried — byollm_015, and it is consent
    // wording, which is product law here: the moment of enablement is the
    // moment of disclosure. Said before the question, not after the answer.
    io.out(
      `  This runs on your ${cli.plan}, and byollm will only ever use it for\n` +
        "  YOUR OWN jobs. Someone else's terms are not yours to lend, so this\n" +
        "  service can never be shared with a team — the protocol enforces that,\n" +
        "  whatever the config says.\n",
    );
    if (BACKENDS[cli.id].class === "process" && cli.id === "codex-cli") {
      // The residual this backend carries, stated where the decision is made.
      // Codex's tools are disabled and verified disabled, and it can still
      // reach the network on your behalf; a site you trust is still a site you
      // are trusting.
      io.out(
        "  Note: Codex is an agent. byollm turns its shell, browser and\n" +
          "  computer tools off and tests that they stay off — but only use it\n" +
          "  with sites you trust.\n",
      );
    }
    const answer = await io.ask(`  Use it for your own jobs? [Y/n] `);
    if (!yes(answer, true)) continue;

    services[cli.binary] = {
      type: cli.id,
      model: cli.model,
      kinds: [...BOTH_KINDS],
    };
    enabled.push(cli.binary);
  }

  // ── 3. a local or custom model ───────────────────────────────────────
  io.out("\n");
  const local = await io.ask("Add a local or custom model now? [y/N] ");
  if (yes(local, false)) {
    io.out(
      "\nThat one needs a couple of details this wizard would only guess at —\n" +
        "which server, which port, which model name. It is a five-line block:\n" +
        "  https://docs.byollm.cloud/guides/models\n" +
        `Add it to ${paths.config} and run \`byollm services\` to check it.\n`,
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
  await writeFile(paths.config, `${JSON.stringify(parsed.data, null, 2)}\n`);

  io.out(
    `\nWrote ${paths.config}\n` +
      `  ${enabled.join(", ")} — your own jobs only\n\n` +
      `Next: byollm connect --name ${JSON.stringify(deviceName)}\n`,
  );
  return { wrote: true, services: enabled };
}

async function readExisting(
  path: string,
): Promise<{ services: Record<string, unknown> } | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "services" in parsed) {
      return parsed as { services: Record<string, unknown> };
    }
    return { services: {} };
  } catch {
    return undefined;
  }
}

/** A name a person would recognise, without leaking their username. */
function defaultDeviceName(): string {
  const override = process.env["BYOLLM_LABEL"];
  if (override !== undefined && override !== "") return override.slice(0, 120);
  return "my computer";
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
