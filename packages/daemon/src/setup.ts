import { createInterface } from "node:readline";
import type { LoginCommand } from "./login.js";
import {
  detectInstalled,
  manageServices,
  readExistingConfig,
  summarise,
  writeManaged,
  type Detected,
  type Detector,
  type ManageIo,
  type Probe,
  type Verifier,
} from "./services-manage.js";
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

/**
 * How the wizard talks — one definition, and it lives with the screen.
 *
 * `ManageIo` is the same interface under the name of the module that now owns
 * the conversation. Aliased rather than re-declared so `terminalIo` below, the
 * CLI, and every test keep the word they already use while there is exactly
 * one shape.
 */
export type SetupIo = ManageIo;

export type { Detector, Probe, Detected };
export { detectInstalled };

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
 * The defaults live where the work does — one place, not two.
 *
 * These were `= detectInstalled`, `= detect`, `= runLogin(...)` here AND in
 * the screen this now calls. Two defaults for one question is the divergence
 * instruction 9 names, so setup forwards what it was given and
 * `manageServices` decides what `undefined` means. A caller that passes
 * nothing gets the real machine either way; a test that passes a stub is the
 * only thing that changes anything.
 */
export async function runSetup(
  paths: DaemonPaths,
  io: SetupIo,
  detector?: Detector,
  probe?: Probe,
  /**
   * Asks whether a found CLI can actually answer — "found" is not "works".
   *
   * Fifth, so that adding it did not renumber the parameters every existing
   * caller passes positionally. Which it did, briefly, and the compiler said
   * so in four places before anything ran.
   */
  verifier?: Verifier,
  /**
   * Running a vendor CLI's sign-in, with this terminal — 2026-09-02.
   *
   * Injected for the same reason `verifier` is, and more urgently: the real
   * one hands the TTY to another program. A test that reached the default
   * would sit waiting for somebody to complete an OAuth flow.
   */
  login?: (command: LoginCommand) => Promise<boolean>,
  /**
   * The wizard's own hands: `connect` and `install`, run as this process.
   *
   * Injected rather than imported so a test can watch what setup decided to
   * do without pairing against a real hub or writing a launch agent. The
   * default is supplied by the CLI, which owns those verbs — passing them in
   * keeps this module from importing the command table that imports it.
   */
  run: (argv: readonly string[]) => Promise<number> = () => Promise.resolve(0),
  /**
   * Which machine this is — last, for the same reason `verifier` was last.
   *
   * Injected rather than read from `process` at the point of use so the
   * Windows path is testable on the machines we actually have. The bug it
   * exists for was found on a box none of us own.
   */
  platform?: NodeJS.Platform,
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
  const existing = await readExistingConfig(paths.config);
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
          "Run `byollm services` to see what it does, or\n" +
          "`byollm services manage` to change it.\n",
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

  // ── 2. what this machine may run ─────────────────────────────────────
  //
  // **One implementation, and this is the caller** — Todd, 09-10: *"We should
  // remove the old setup and replace with this one. I shouldn't have even
  // suggested having two."* What stood here was a subscription loop, a local-
  // server picker and a defaults question, all of which `services manage`
  // now does — and doing them twice would have been instruction 9 written
  // into the plan on purpose rather than discovered by accident later.
  //
  // `existing` is empty by construction: a config with any services returned
  // a few lines up, so the only file that reaches here has none. Passing
  // `{}` is therefore a statement of that fact rather than a shortcut, and
  // `services manage` is where somebody re-runs against a config that has
  // something in it.
  const outcome = await manageServices({
    io,
    existing: {},
    ...(detector === undefined ? {} : { detector }),
    ...(verifier === undefined ? {} : { verifier }),
    ...(probe === undefined ? {} : { probe }),
    ...(login === undefined ? {} : { login }),
    ...(platform === undefined ? {} : { platform }),
  });
  if (!outcome.decided) return { wrote: false, services: [] };
  const enabled = [...outcome.enabled];

  if (!(await writeManaged(paths.config, io, existing?.rest ?? {}, outcome))) {
    return { wrote: false, services: [] };
  }

  io.out(`\nWrote ${paths.config}\n${summarise(outcome).join("\n")}\n`);

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

  /* Names what it does rather than where it goes — byollm_020. "Run in
     background" left "and after I reboot?" unanswered, which is the whole
     question the command exists to settle. */
  const doInstall = yes(
    await io.ask(
      "\n  Start byollm now and keep it running across restarts? [Y/n] ",
    ),
    true,
  );
  if (!doInstall) {
    io.out(
      `\n  Paired, and not running. Start it when you want it:\n` +
        `    byollm start       keep it running, across restarts\n` +
        `    byollm run         run in this terminal and watch it\n`,
    );
    return { wrote: true, services: enabled, connected: true, running: false };
  }

  const running = await run(["start"]);
  if (running !== 0) {
    io.out(
      `\n  Paired, and could not start the background service. Either:\n` +
        `    byollm start       try again — it says why when it cannot\n` +
        `    byollm run         run in this terminal instead\n`,
    );
    return { wrote: true, services: enabled, connected: true, running: false };
  }

  /**
   * One printer — ruled 2026-09-03.
   *
   * `TEST YOUR DEVICE` appeared twice in a single setup: `install` printed it
   * on its own success, and this line printed it again. Two tellings of one
   * fact, three lines apart.
   *
   * `install` keeps it, and that is not a coin toss. Since the same ruling,
   * install is the step that *probes* — it waits for the daemon to be running
   * before it claims anything — so it is the only place that knows the
   * sentence is true. This line knows only that install returned zero, which
   * is precisely the weaker fact that caused the original bug.
   */
  io.out(
    `\n  Done. This device is set up, paired, and running in the background.\n`,
  );
  return { wrote: true, services: enabled, connected: true, running: true };
}

/** A name a person would recognise, without leaking their username. */
function defaultDeviceName(): string {
  const override = process.env["BYOLLM_LABEL"];
  if (override !== undefined && override !== "") return override.slice(0, 120);
  return "my-computer";
}

/**
 * Input that has ended, said as a fact rather than as a hang — B114.
 *
 * Its own error class because two commands catch it and neither should be
 * matching on a message. It is not a failure of the thing being asked: it
 * means the answers ran out, which for a person is Ctrl-D and for a script is
 * the end of the file.
 */
export class InputEnded extends Error {
  constructor() {
    super("no more input");
    this.name = "InputEnded";
  }
}

/**
 * The real terminal, wired to readline — one interface, with a line queue.
 *
 * ## What was wrong, and how far it went
 *
 * `ask` opened a NEW `readline` interface per question and closed it after.
 * A person typing one line at a time never noticed. **A script did:** every
 * answer arrives before the first prompt opens, the first interface consumes
 * the lot, and closing it throws them away — so question two waits forever for
 * input that was delivered and dropped. Found building B100a, where the screen
 * asks eight questions in a row instead of three.
 *
 * **A single long-lived interface is not the fix on its own, and running it is
 * what showed that.** `readline` emits `line` as input arrives whether or not
 * anybody is asking, so lines that land between questions are still lost —
 * and `rl.question()` never settles at end of input, so one interface turns a
 * visible abort into a silent hang. Both verified by running them rather than
 * reasoned about.
 *
 * ## So: one interface, a queue, and an end that is an answer
 *
 * Every line is caught and either handed to a waiting question or parked. A
 * question takes a parked line if there is one and waits otherwise. Order
 * stops mattering, which is the only property that makes this safe for a
 * caller that is a program.
 *
 * End of input rejects with {@link InputEnded} — the waiting question and
 * every later one. **It is a third state, not an empty answer**: returning
 * `""` would look like somebody pressing Enter, and the screens read Enter as
 * "keep the default", so a finished stdin would silently accept every
 * default including the one that pairs this device.
 *
 * ## `close()` is the caller's, and it is not optional
 *
 * An open interface holds `process.stdin`, so a command that does not close it
 * does not exit. Both callers close in a `finally`.
 */
export interface TerminalIo extends SetupIo {
  /** Release stdin. A command that forgets this does not exit. */
  close(): void;
}

export function terminalIo(
  out: (text: string) => void,
  err: (text: string) => void,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): TerminalIo {
  /** Lines that arrived before anybody asked for them. */
  const parked: string[] = [];
  /** Questions that arrived before their line did. */
  const waiting: {
    resolve: (line: string) => void;
    reject: (why: Error) => void;
  }[] = [];
  let ended = false;
  let rl: ReturnType<typeof createInterface> | undefined;

  const open = (): void => {
    if (rl !== undefined) return;
    rl = createInterface({ input, output });
    rl.on("line", (line: string) => {
      const next = waiting.shift();
      if (next === undefined) parked.push(line);
      else next.resolve(line);
    });
    rl.on("close", () => {
      ended = true;
      for (const next of waiting.splice(0)) next.reject(new InputEnded());
    });
  };

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
    ask(question: string): Promise<string> {
      open();
      /* The prompt is written whatever happens next, because a transcript
         that shows an answer with no question is a transcript nobody can
         read back. */
      output.write(question);
      const already = parked.shift();
      if (already !== undefined) return Promise.resolve(already);
      if (ended) return Promise.reject(new InputEnded());
      return new Promise<string>((resolve, reject) => {
        waiting.push({ resolve, reject });
      });
    },
    close(): void {
      rl?.close();
      rl = undefined;
    },
  };
}
