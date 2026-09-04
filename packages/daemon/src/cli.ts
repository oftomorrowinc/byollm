import { access } from "node:fs/promises";
import { emphasise, terminalContext } from "./emphasis.js";
import { backendVerifier, listModels, setModel, showModel } from "./model.js";
import { preflight } from "./preflight.js";
import { runLogin, type LoginCommand } from "./login.js";
import { createBackend } from "./backends/index.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { FAILURES_BEFORE_ALARM, readHealth } from "./health.js";
import { runSetup, terminalIo } from "./setup.js";
import type { BackendId } from "@byollm/protocol";
import { backendDescriptor, backendName, classifyCost } from "@byollm/protocol";
import { fingerprint } from "@byollm/protocol";
import { normalizeOrigin, UnusableOrigin } from "./origins.js";
import { Budgets } from "./budgets.js";
import { ClientError, ProtocolClient } from "./client.js";
import {
  REVOKED_SENTENCE,
  clearRevokedMark,
  revokedMark,
  revokedRemedy,
} from "./revoked.js";
import { TEST_YOUR_DEVICE } from "./test-your-device.js";
import { diagnoseRoute } from "./diagnose.js";
import { DaemonConfig, loadConfig } from "./config.js";
import { connect } from "./connect.js";
import { IngressLog, stripControlChars } from "./ingress.js";
import { DeviceIdentity } from "./identity.js";
import { Pairings, recordSites } from "./pairings.js";
import { SpendLedger } from "./spend.js";
import { SpentGrants } from "./spent-grants.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import { Runner, type RunnerEvent } from "./runner.js";
import {
  installedProgram,
  installService,
  serviceState,
  spawnCommand,
  uninstallService,
  type CommandRunner,
  type ServiceState,
} from "./install.js";
import {
  serviceIsInstalled,
  servicePlan,
  type ServicePlan,
  type ServicePlatform,
  type ServiceTarget,
} from "./service.js";
import { authNote, renderServices } from "./service-line.js";
import { readServiceStates, writeServiceStates } from "./service-states.js";
import { DAEMON_VERSION, formatVersion } from "./index.js";

const USAGE = `byollm — run an app's LLM jobs on your own models.

  byollm setup                answer three questions instead of editing JSON
  byollm connect [<url>]      pair with an app and start running its jobs
  byollm forget <url>         drop a pairing
  byollm name [<name>]        what this device calls itself when it pairs
  byollm start                run in the background, across restarts
  byollm stop                 stop running in the background
  byollm run                  run here in the foreground, and watch the log
  byollm status               what is connected, what is running, what it cost
  byollm log [--full] [-n N]  every prompt that has run on this device
  byollm services             each service: health, who it is offered to, model
  byollm model <svc> <name>   check a model answers, then use it
  byollm offer <service> <scope>  who a service is offered to (private|team)
  byollm sites                which sites this device serves

Config lives in ~/.byollm/config.json. Everything this daemon has ever run is
in ~/.byollm/ingress.log — it is yours to read and yours to delete.
`;

/**
 * Commands that moved, and what they moved to — byollm_020.
 *
 * Kept working for a window rather than deleted, because Kevin, Casul and
 * Rob have these in their shells and their notes today. A rename that
 * answers "unknown command" is a rename that costs somebody their afternoon
 * for no reason: the old word still does the right thing, and says once what
 * to type next time.
 *
 * `pause`/`resume` are not in here, because they were not renamed. They were
 * removed — {@link REMOVED} — and the difference is the point of the map:
 * this one promises the old word still does the old thing.
 */
const RENAMED: Readonly<Record<string, string>> = {
  install: "start",
  uninstall: "stop",
  models: "services",
};

/**
 * Verbs that are gone, and say so — B043, ruled by Todd 2026-09-04.
 *
 * `pause` did not do what its own status screen claimed. It wrote a flag,
 * and the running daemon never read it: the flag reached exactly two places,
 * a probe heartbeat sent during `connect` and the `status` headline, which
 * printed `PAUSED` in the top line while the daemon underneath went on
 * claiming work and spending money. Somebody who paused a machine and
 * checked on it was told the thing they wanted to hear by a screen that had
 * not asked the daemon anything.
 *
 * So this is not a feature being retired for tidiness. Removing it is how
 * the lie stops, and it is why these do not become aliases for `stop`: an
 * alias must do the same thing under a new name, and `stop` unregisters
 * supervision — more destructive than what the person typed, arriving
 * through the fix for it.
 *
 * Idling without giving up startup is now `byollm stop` and `byollm start`,
 * which costs one command each since B036 made re-registration free.
 */
const REMOVED = {
  pause: "stop",
  resume: "start",
} as const;

/**
 * One line, on stderr, saying what to type next time.
 *
 * On stderr rather than stdout: somebody piping `byollm services` into a
 * script should get the list and nothing else, and a deprecation notice that
 * lands in a pipeline is a rename that breaks the thing it was trying not to
 * break.
 */
function renamedNotice(was: string): string {
  return (
    `note: \`byollm ${was}\` is now \`byollm ${RENAMED[was] ?? was}\` — ` +
    `the old name still works for now.\n`
  );
}

/**
 * What a removed verb says. Deliberately not the shape of a rename notice:
 * that one ends "still works for now", and this one has to end the opposite
 * way or it reads as a nudge somebody can ignore.
 */
function removedNotice(was: keyof typeof REMOVED): string {
  return (
    `\`byollm ${was}\` has been removed — use \`byollm ${REMOVED[was]}\`.\n\n` +
    `  byollm stop    stops the daemon and unregisters it from startup\n` +
    `  byollm start   brings it back\n\n` +
    `It did not do what it said: the flag it wrote was never read by the ` +
    `running\ndaemon, so a machine you had "paused" went on claiming work.\n`
  );
}

/** "one app" / "3 apps", so the line reads as a sentence either way. */
function describeOrigins(origins: readonly string[]): string {
  return origins.length === 1
    ? `paired with ${origins[0] ?? "one app"}`
    : `paired with ${String(origins.length)} apps`;
}

/** Exit codes: 0 fine, 1 a real failure, 2 the user asked for something wrong. */
export type ExitCode = 0 | 1 | 2;

/**
 * Everything the CLI touches outside itself.
 *
 * byollm_002 calls the meter the product's soul, which means it has to be
 * testable rather than merely observable by a human at a terminal. Injecting
 * the streams, the state directory and the confirmation prompt lets the tests
 * drive the real commands against a temporary `BYOLLM_HOME`.
 */
export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** Answers the scarier-confirmation prompt when widening access. */
  readonly confirm: (question: string) => Promise<boolean>;
}

const defaultIo: CliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  confirm: confirmInteractively,
};

/** Run one command. Exported so the tests drive the same code a user does. */
/**
 * One service's backend, built the way the daemon builds it.
 *
 * `baseUrl` is not optional decoration for an HTTP-class transport — the
 * constructor throws without it. Building backends from the id alone crashed
 * `byollm run` for every Ollama user, and the test that caught it was one
 * about revocation, which is the kind of luck not to rely on twice.
 */
function backendFor(config: {
  readonly type: BackendId;
  readonly baseUrl?: string | undefined;
}) {
  return createBackend(
    config.type,
    config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl },
  );
}

/**
 * The preflight's dependencies, defaulted to the real ones — B047.
 *
 * Built here rather than inside each command so that `start` and `run` ask
 * the same question the same way. Two implementations of one rule is the
 * defect this whole audit keeps finding.
 */
async function preflightFor(
  paths: DaemonPaths,
  io: CliIo,
  interactive: boolean,
  options: {
    platform?: NodeJS.Platform;
    verify?: (config: {
      readonly type: BackendId;
      readonly model: string;
      readonly baseUrl?: string | undefined;
    }) => Promise<{
      readonly answers: boolean | undefined;
      readonly detail?: string | undefined;
    }>;
    login?: (command: LoginCommand) => Promise<boolean>;
    ask?: (question: string) => Promise<string>;
  },
): Promise<void> {
  const loaded = await loadConfig(paths.config);
  await preflight({
    loaded,
    device: await labelFor(paths, undefined),
    io,
    interactive,
    ask:
      options.ask ??
      (async (question) => {
        const rl = createInterface({
          input: process.stdin,
          output: process.stderr,
        });
        try {
          return await rl.question(question);
        } finally {
          rl.close();
        }
      }),
    platform: options.platform ?? process.platform,
    verify:
      options.verify ??
      ((config) =>
        backendVerifier(() => backendFor(config))(config.type, config.model)),
    login:
      options.login ??
      ((command) =>
        runLogin(command, (text) => {
          io.err(text);
        })),
    signInFor: (config) => backendFor(config).signIn,
  });
}

export async function runCli(
  argv: readonly string[],
  options: {
    paths?: DaemonPaths;
    io?: Partial<CliIo>;
    /**
     * Stops the polling loop. The executable wires this to SIGINT/SIGTERM;
     * anything embedding the CLI (including its tests) can stop it the same
     * way rather than by killing the process.
     */
    signal?: AbortSignal;
    /**
     * The machine's service supervisor. Injected by the tests so that neither
     * `install` nor `status` ever spawns a real `launchctl` — a unit test that
     * shells out to the host's init system is a unit test that installs
     * something on whoever runs it.
     */
    service?: ServiceIo;
    /**
     * How long a parked daemon waits between asking whether it has been
     * re-paired. Injected by the tests for the same reason `service` is: the
     * real interval is tuned for a person watching a machine, and a test that
     * waited it out would spend that time doing nothing.
     */
    parkPollMs?: number;
    /**
     * Is something restarting us if we exit? Defaults to "no TTY, so yes".
     * Injected because the parked-daemon behaviour only exists under a
     * supervisor, and a test runner attached to a terminal looks like a
     * person at a prompt — which is the other branch entirely.
     */
    supervised?: boolean;
    /**
     * Which machine this is, and how a backend is checked and signed in —
     * B047's seams.
     *
     * The preflight spends a real canary and can hand the terminal to a
     * vendor CLI. Both are injected so a test can drive the whole shape
     * without spending money or opening a browser, and so the Windows branch
     * is reachable from the machines we own.
     */
    platform?: NodeJS.Platform;
    /**
     * Is a person here to answer? Defaults to "is stdout a terminal".
     *
     * Separate from `supervised`, which asks whether something restarts us.
     * They usually agree and they are not the same question, and the
     * preflight turns on this one: a canary costs money and a login prompt
     * needs somebody to type.
     */
    interactive?: boolean;
    verify?: (config: {
      readonly type: BackendId;
      readonly model: string;
      readonly baseUrl?: string | undefined;
    }) => Promise<{
      readonly answers: boolean | undefined;
      readonly detail?: string | undefined;
    }>;
    login?: (command: LoginCommand) => Promise<boolean>;
    /** How the preflight asks. Injected so tests are not a TTY. */
    ask?: (question: string) => Promise<string>;
  } = {},
): Promise<ExitCode> {
  const [command, ...rest] = argv;
  const paths = options.paths ?? daemonPaths();
  const io: CliIo = { ...defaultIo, ...options.io };
  const signal = options.signal;
  // Resolved once: three call sites each falling back separately is three
  // chances to pass the wrong one, and the object is a description of this
  // process, not a connection to anything.
  const service = options.service ?? defaultServiceIo();

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      io.out(USAGE);
      return 0;
    case "--version":
    case "version":
      // The full tuple, not a bare version. byollm_010 §5: an issue that
      // arrives without a platform costs a round trip to learn one.
      io.out(formatVersion());
      return 0;
    case "setup":
      return commandSetup(paths, io, signal);
    case "connect":
      return commandConnect(paths, rest, io, signal);
    case "name":
      return commandName(paths, rest, io);
    case "run":
      return commandRun(
        paths,
        rest,
        io,
        signal,
        options.parkPollMs,
        options.supervised,
        options.interactive,
        {
          ...(options.platform === undefined
            ? {}
            : { platform: options.platform }),
          ...(options.verify === undefined ? {} : { verify: options.verify }),
          ...(options.login === undefined ? {} : { login: options.login }),
          ...(options.ask === undefined ? {} : { ask: options.ask }),
        },
      );
    case "status":
      return commandStatus(paths, io, service);
    case "log":
      return commandLog(paths, rest, io);
    case "start":
      return commandInstall(paths, io, service, options.interactive, {
        ...(options.platform === undefined
          ? {}
          : { platform: options.platform }),
        ...(options.verify === undefined ? {} : { verify: options.verify }),
        ...(options.login === undefined ? {} : { login: options.login }),
        ...(options.ask === undefined ? {} : { ask: options.ask }),
      });
    case "stop":
      return commandUninstall(paths, io, service);
    case "allow":
      return commandRetiredAdmission("allow", io);
    case "disallow":
      return commandRetiredAdmission("disallow", io);
    case "offer":
      return commandOffer(paths, rest, io);
    case "sites":
      return commandSites(paths, io);
    case "approve":
      return commandRetiredApprove(io);
    case "forget":
      return commandForget(paths, rest, io);
    case "services":
      return commandServices(paths, io, service);
    case "models":
      /**
       * Extra is not absent — ruled 2026-09-03.
       *
       * `byollm models claude fake` listed every service's model and exited
       * zero, exactly as if it had been called bare. The arguments were
       * dropped on the floor, so a command that was asked to *set* a model
       * answered by *listing* them, and reported success for work it never
       * did.
       *
       * This is the swallowed-argument cousin of the family this project
       * keeps meeting: `undefined` is not `false`, an unreadable answer is
       * not a negative one, and a request nobody understood is not a request
       * nobody made. A verb handed arguments it has no use for must say so
       * and point at the verb that does — never quietly behave like a
       * different command.
       */
      if (rest.length > 0) {
        io.err(
          `byollm models takes no arguments, and got ` +
            `${rest.map((arg) => JSON.stringify(arg)).join(" ")}.\n\n` +
            `  byollm services                every service, and the model it runs\n` +
            `  byollm model ${rest[0] ?? "<service>"}${
              rest[1] === undefined ? "" : ` ${rest[1]}`
            }   ` +
            `${rest[1] === undefined ? "one service, and what it accepts" : "check that model, then use it"}\n`,
        );
        return 2;
      }
      /**
       * Still lists exactly what it listed — byollm_020.
       *
       * `models` leaves the documented surface because the model is already
       * a column of `services`, and two lists of one table is what this
       * audit removes. But **a deprecation alias should do the same thing
       * under a new name**: routing it at `services` would change what
       * somebody sees, and on a fresh machine would swap a "run `byollm
       * setup`" for a bare failure. That is a behaviour change wearing an
       * alias's clothes — the same trap `pause` presents, and refused there
       * for the same reason.
       */
      io.err(renamedNotice("models"));
      return listModels(paths.config, io).then((r) => r.code);
    case "model":
      return commandModel(paths, rest, io);
    /* The renamed verbs, still working and saying so once — byollm_020. */
    case "install":
      io.err(renamedNotice(command));
      return commandInstall(
        paths,
        io,
        service,
        options.supervised === true ? false : undefined,
        {
          ...(options.platform === undefined
            ? {}
            : { platform: options.platform }),
          ...(options.verify === undefined ? {} : { verify: options.verify }),
          ...(options.login === undefined ? {} : { login: options.login }),
        },
      );
    case "uninstall":
      io.err(renamedNotice(command));
      return commandUninstall(paths, io, service);
    /* Gone, and saying so rather than doing something adjacent — see
       {@link REMOVED} for why these are not aliases. */
    case "pause":
    case "resume":
      io.err(removedNotice(command));
      return 2;
    default:
      io.err(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

// -- install ------------------------------------------------------------------

/**
 * Everything the install commands touch outside themselves.
 *
 * Injected so the tests drive the real code with a fake `launchctl`: the
 * alternative is a command nobody can test on the machine they are writing it
 * on, which for three operating systems means two of them are checked by
 * hoping.
 */
export interface ServiceIo {
  readonly platform: ServicePlatform;
  readonly execPath: string;
  readonly scriptPath: string;
  readonly run: CommandRunner;
  readonly home?: string;
  readonly uid?: number;
  /** Windows only: who the scheduled task belongs to, so it needs no admin. */
  readonly user?: string;
  /**
   * Windows only: where the Startup fallback is written.
   *
   * Here so a test can point it somewhere disposable. See
   * {@link ServiceTarget.appData} — the suite was writing into the real one.
   */
  readonly appData?: string;
  /**
   * How install waits between probes while confirming the daemon came up.
   *
   * Injected for the same reason `run` is: the confirmation is a real poll
   * with real delays, and a suite that spends six seconds proving it is a
   * suite somebody starts skipping.
   */
  readonly wait?: (ms: number) => Promise<void>;
}

/**
 * How this process was started, as something a service file can point at.
 *
 * `process.argv[1]` is the CLI's own entry script. It is the right answer for
 * a global install and the wrong one for `npx`, which is why the plan refuses
 * the second — see `refuseToSupervise`.
 */
export function defaultServiceIo(): ServiceIo {
  return {
    platform:
      process.platform === "win32"
        ? "win32"
        : process.platform === "darwin"
          ? "darwin"
          : "linux",
    execPath: process.execPath,
    scriptPath: process.argv[1] ?? "",
    run: spawnCommand,
    // `getuid` is absent on Windows, where nothing reads it.
    uid: process.getuid?.() ?? 0,
    /* Who the Windows task belongs to — B036. `USERDOMAIN` is absent on a
       machine that is not domain-joined, where the bare name is what
       `schtasks` wants anyway. Only Windows reads this. */
    ...(process.env["USERNAME"] === undefined
      ? {}
      : {
          user: process.env["USERDOMAIN"]
            ? `${process.env["USERDOMAIN"]}\\${process.env["USERNAME"]}`
            : process.env["USERNAME"],
        }),
  };
}

function serviceTarget(paths: DaemonPaths, service: ServiceIo): ServiceTarget {
  return {
    platform: service.platform,
    execPath: service.execPath,
    scriptPath: service.scriptPath,
    ...(service.home === undefined ? {} : { home: service.home }),
    ...(service.uid === undefined ? {} : { uid: service.uid }),
    ...(service.user === undefined ? {} : { user: service.user }),
    ...(service.appData === undefined ? {} : { appData: service.appData }),
    root: paths.root,
  };
}

/**
 * Run in the background from now on — cloud_002.
 *
 * The command that makes a machine keep its promise. Everything a roster
 * assumes — that this machine is there, that work sent to it runs — depends on
 * a process that outlives the window somebody typed in.
 */
async function commandInstall(
  paths: DaemonPaths,
  io: CliIo,
  service: ServiceIo,
  interactive = process.stdout.isTTY,
  preflightOptions: {
    platform?: NodeJS.Platform;
    verify?: (config: {
      readonly type: BackendId;
      readonly model: string;
      readonly baseUrl?: string | undefined;
    }) => Promise<{
      readonly answers: boolean | undefined;
      readonly detail?: string | undefined;
    }>;
    login?: (command: LoginCommand) => Promise<boolean>;
    ask?: (question: string) => Promise<string>;
  } = {},
): Promise<ExitCode> {
  const result = await installService(
    serviceTarget(paths, service),
    service.run,
    service.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    (await revokedMark(paths.health)) !== undefined,
  );
  for (const line of result.lines) (result.ok ? io.out : io.err)(`${line}\n`);
  /**
   * The same moment, reached the other way.
   *
   * `byollm setup` ends here for most people, but somebody who paired earlier
   * and ran `byollm install` on its own has arrived at exactly the point where
   * the device is running and the promise becomes true — and had nothing
   * telling them so. One sentence, one definition, both callers.
   */
  if (result.ok) {
    /**
     * A service that cannot sign in is named here, where somebody is looking
     * — B036.
     *
     * Kevin's daemon started cleanly and served nothing, because `claude` was
     * signed out. Everything was working: the task registered, the process
     * ran, `status` was honest, and the one screen he was actually watching
     * said the install had succeeded. He found out by noticing that no work
     * arrived.
     *
     * That line read services.json — what the daemon's last probe recorded —
     * and Kevin then signed out and ran `start` and got nothing. B047: the
     * install waits for the daemon to be ALIVE, not for its first probe to
     * have landed, so the file is from before the sign-out on a used machine
     * and absent on a new one, and "absent is not signed-out" correctly says
     * nothing about either.
     *
     * So it asks now, and REPLACES the read-back rather than joining it. Two
     * answers to one question on one screen is how they come to disagree.
     */
    await preflightFor(paths, io, interactive, preflightOptions);
    io.out(`\n${TEST_YOUR_DEVICE}\n`);
  }
  return result.ok ? 0 : 1;
}

async function commandUninstall(
  paths: DaemonPaths,
  io: CliIo,
  service: ServiceIo,
): Promise<ExitCode> {
  const result = await uninstallService(
    serviceTarget(paths, service),
    service.run,
  );
  for (const line of result.lines) io.out(`${line}\n`);
  return 0;
}

/**
 * One line about supervision, for `status`.
 *
 * "It says it is paired" and "it is actually running" are different facts, and
 * the second is the one that matters at 2 a.m. The line is deliberately
 * blunt about the third state — installed but stopped — because that is the
 * one that looks fine from the dashboard and serves nothing.
 */
async function supervisionLine(
  plan: ServicePlan,
  state: ServiceState,
  revoked: boolean,
): Promise<string> {
  switch (state.state) {
    case "running":
      return `service: running under ${plan.supervisor}\n`;
    case "installed": {
      /**
       * And say *why*, when the file on disk can say it.
       *
       * "(last exit 2)" is a number somebody has to interpret, and the walk
       * showed what that costs: a device on rosters, serving nothing, and a
       * log full of routine lines because the failure was never in the log —
       * launchd could not start the program at all.
       *
       * The unit records absolute paths to the node that installed it. Under
       * a version manager those belong to one node version, so an ordinary
       * node upgrade leaves a service pointing at a binary that is gone. That
       * is invisible from every surface here, and it is one `stat` away from
       * being the first thing this line says.
       */
      /**
       * A revoked device is not a broken install — ruled 2026-09-03.
       *
       * "on rosters and serving nothing. See <log>" is the right sentence for
       * a daemon that will not start, and the wrong one for a daemon that has
       * been told to stop: it sends somebody to read a log that says exactly
       * what the line above already said, and it implies something on this
       * machine needs fixing. Nothing here does. The headline has named the
       * cause and the remedy, so this line stops competing with it.
       */
      if (revoked) {
        return `service: installed, not serving — ${REVOKED_SENTENCE}.\n`;
      }
      const program = await installedProgram(plan);
      const gone =
        program === null || program.exists
          ? ""
          : `\n  the program it runs is missing: ${program.path}\n` +
            `  (the node it was installed with was removed or upgraded — ` +
            `\`byollm install\` records the current one)\n`;
      return (
        `service: installed but NOT running (${state.detail}) — ` +
        `this device is on rosters and serving nothing. See ${plan.logPath}\n` +
        gone
      );
    }
    case "absent": {
      /**
       * "Not installed" is wrong on a machine that autostarts — 2026-09-02.
       *
       * `serviceState` asks the supervisor. On Windows the supervisor is
       * Task Scheduler, and every install had fallen to the Startup folder
       * instead — so `schtasks` truthfully reported nothing, and this line
       * told somebody whose daemon starts at every logon that jobs only run
       * while a terminal is open.
       *
       * The file is the evidence the supervisor cannot give. It says less
       * than a running check — a Startup entry means it will start, not that
       * it is up — and saying less accurately beats saying more wrongly.
       */
      const fallback = plan.fallback;
      if (fallback !== undefined && (await exists(fallback.unitPath))) {
        return (
          `service: starting from ${fallback.supervisor} at logon, not ` +
          `under ${plan.supervisor}\n` +
          `  ${fallback.caveat}\n` +
          `  startup: ${fallback.unitPath}\n`
        );
      }
      return `service: not installed — jobs only run while \`byollm run\` is open (\`byollm install\` fixes that)\n`;
    }
  }
}

// -- name ---------------------------------------------------------------------

/**
 * Read or set what this machine calls itself.
 *
 * The name is shown on the approval screen — the one moment somebody is
 * deciding whether to trust this machine, and the one moment "which of my
 * three laptops is this" is a question with consequences. A hostname answers
 * it badly and a person answers it well.
 *
 * It changes nothing already paired. A name is what a machine *offered* when
 * it asked, and rewriting an app's record of that afterwards would be this
 * daemon editing somebody else's memory of a decision they made.
 */
async function commandName(
  paths: DaemonPaths,
  args: readonly string[],
  io: CliIo,
): Promise<ExitCode> {
  const next = args[0];
  if (next === undefined) {
    io.out(`${await labelFor(paths, undefined)}\n`);
    return 0;
  }

  await mkdir(dirname(paths.label), { recursive: true });
  await writeFile(paths.label, `${next.slice(0, 120)}\n`, { mode: 0o600 });
  io.out(
    `This device will pair as ${next.slice(0, 120)}.\n` +
      "Anything already paired keeps the name it introduced itself with.\n",
  );
  return 0;
}

// -- connect -----------------------------------------------------------------

/**
 * Where `byollm connect` goes when nobody says — cloud_010's overnight brief.
 *
 * The reference hub, named once. A daemon that made somebody paste a URL
 * before it would do anything is a daemon whose first minute is a
 * copy-and-paste from a page they have not opened yet — and every one of them
 * would paste the same string.
 *
 * It is a default and not a lock: `byollm connect <url>` still goes wherever
 * it is pointed, which is what keeps the protocol something other people can
 * host. Stated here rather than fetched, because a default that arrives over
 * the network is a default somebody else can move.
 */
export const DEFAULT_ORIGIN = "https://hub.byollm.cloud";

/**
 * Which upstream `connect` was pointed at — the argument, or the default.
 *
 * Its own function so it can be checked without a network. The test that
 * covered "no argument means the reference hub" did it by *running* connect
 * with no argument, which sent a real pair request to the real hub on every
 * run — tolerable while the hub refused that shape in 400ms, and not
 * tolerable once it started answering: the run hung for a full poll and left
 * a pending code in production behind it.
 *
 * The `--name` guard is the whole of the filter and the reason this is
 * fiddly: without checking `named !== -1`, `named + 1` is `0` when there is no
 * `--name`, so the *URL* gets filtered out and every `connect <url>` quietly
 * goes to the default instead. That shipped once and was caught by the
 * integration test connecting to the hub when it had been told otherwise.
 */
export function connectTarget(args: readonly string[]): string {
  const named = args.indexOf("--name");
  const positional = args.filter(
    (arg, at) =>
      !arg.startsWith("-") &&
      (named === -1 || (at !== named && at !== named + 1)),
  );
  return positional[0] ?? DEFAULT_ORIGIN;
}

/**
 * What this machine calls itself, in the order the answers were given.
 *
 * A flag beats a saved name beats the environment beats the hostname. Every
 * layer is somebody being more specific than the last, and the hostname is
 * what a machine says when nobody has said anything — `todd@Todds-Mac-Studio`
 * is a fine answer and a poor label on an approval screen with three of them.
 */
async function labelFor(
  paths: DaemonPaths,
  flag: string | undefined,
): Promise<string> {
  if (flag !== undefined && flag !== "") return flag.slice(0, 120);
  try {
    const saved = (await readFile(paths.label, "utf8")).trim();
    if (saved !== "") return saved.slice(0, 120);
  } catch {
    // No saved name is the ordinary case, not a problem to report.
  }
  return hostLabel();
}

/**
 * `byollm setup` — byollm_015 Phase 1.
 *
 * Thin on purpose: the conversation lives in `setup.ts` so it can be driven by
 * a test that is not a terminal, and so this file stays a router.
 */
async function commandSetup(
  paths: DaemonPaths,
  io: CliIo,
  signal?: AbortSignal,
): Promise<ExitCode> {
  const result = await runSetup(
    paths,
    terminalIo(
      (text) => {
        io.out(text);
      },
      (text) => {
        io.err(text);
      },
    ),
    undefined,
    undefined,
    undefined,
    undefined,
    /**
     * `connect` and `install`, run in this process — 2026-09-01.
     *
     * Through `runCli` rather than by spawning `byollm` again: a spawn would
     * find whichever binary is on PATH, which on a machine mid-upgrade is not
     * necessarily this one. The wizard finishing the job means *this* build
     * doing it.
     */
    (argv) => runCli([...argv], { paths, io, ...(signal ? { signal } : {}) }),
  );
  return result.wrote || result.services.length > 0 ? 0 : 1;
}

/**
 * `byollm model` — byollm_017 Phase 1.
 *
 * Three shapes, one verb: no service lists nothing useful and says so; a
 * service alone reports what it runs and what its CLI is known to accept; a
 * service and a name probes, then writes.
 */
async function commandModel(
  paths: DaemonPaths,
  args: readonly string[],
  io: CliIo,
): Promise<ExitCode> {
  const [service, model] = args;
  if (service === undefined) {
    io.err(
      "usage:\n" +
        "  byollm services                  every service and the model it runs\n" +
        "  byollm model <service>           one service, and what it accepts\n" +
        "  byollm model <service> <name>    check that model, then use it\n",
    );
    return 2;
  }
  if (model === undefined) {
    const shown = await showModel(paths.config, service, io);
    return shown.code;
  }
  const set = await setModel(
    { configPath: paths.config, service, model },
    io,
    backendVerifier((id) => createBackend(id, {})),
  );
  return set.code;
}

async function commandConnect(
  paths: DaemonPaths,
  args: readonly string[],
  io: CliIo,
  signal?: AbortSignal,
): Promise<ExitCode> {
  // `--name` may appear before or after the URL: somebody typing this for the
  // first time should not have to learn an argument order.
  const named = args.indexOf("--name");
  const name = named === -1 ? undefined : args[named + 1];
  if (named !== -1 && (name === undefined || name.startsWith("-"))) {
    io.err("usage: byollm connect [<url>] [--name <name>]\n");
    return 2;
  }
  // Guarded on `named !== -1`, and the guard is the whole of this comment.
  // Without it `named + 1` is `0` when there is no `--name`, so the *URL* is
  // filtered out and every `connect <url>` quietly goes to the default
  // instead. The integration test — the only one that runs the real binary —
  // is what caught it, by connecting to the hub when it had been told
  // otherwise.
  const origin = normalizeOrigin(connectTarget(args));

  /**
   * The stored credential IS the device — ruled 2026-09-02 (byollm_016).
   *
   * This used to say "already paired with …" and then ask `Pair again?`, and
   * a yes ran the whole ceremony: new code, new approval, new fingerprint
   * compare. Two things were wrong with it.
   *
   * The first is that the ceremony could not succeed. The dashboard inserts a
   * device row keyed on the fingerprint of this machine's identity key, and
   * that key is stable — `DeviceIdentity` mints one only when the file is
   * absent. So re-pairing the same machine hits the unique index, comes back
   * `23505`, and the screen says "that device's keys are already registered
   * on an account". The daemon, meanwhile, polls until the code expires. The
   * flow's happy path was a dead end.
   *
   * The second is worse and is why this is ruled rather than tidied: **a
   * ceremony repeated becomes a habit, and a habit is not a comparison.** The
   * fingerprint check is load-bearing precisely because it is rare. Asking
   * for it on every routine re-run trains the person to approve without
   * looking, which is a security regression wearing a UX complaint.
   *
   * So the credential is presented first. Found is not works, so it is
   * *probed* rather than assumed — one real signed heartbeat, which is the
   * same call this daemon makes every ten seconds anyway. The hub recognising
   * it is a session, not a ceremony.
   */
  const existing = await (async () => {
    const pairings = new Pairings(paths.pairings);
    await pairings.load();
    return pairings.get(origin);
  })();

  const { loaded, ingress, budgets, spend, spentGrants } = await context(paths);

  for (const problem of loaded.problems) {
    io.err(`config: ${problem.where}: ${problem.message}\n`);
  }

  const client = new ProtocolClient({ origin });
  const runner = new Runner({
    client,
    runnerId: "pending",
    owner: "pending",
    daemonVersion: DAEMON_VERSION,
    loaded,
    budgets,
    spend,
    spentGrants,
    ingress,
  });

  // Daemon start: the one place a canary runs. `#tick()` calls this with no
  // options, so the polling loop never spends a call.
  const capabilities = await runner.detectCapabilities({ canary: true });
  // The daemon is the process that probes; `byollm status` is the process that
  // reports. This is the only thing that connects them.
  await writeServiceStates(paths.serviceStates, runner.serviceStates);

  /**
   * Zero healthy backends is a warning, not a refusal — cloud_002, ruled
   * 2026-08-21.
   *
   * This used to return 1. The stated reason was that "pairing while
   * advertising nothing would produce a runner that silently never receives
   * work", and the invariant does not hold: a paired daemon whose model server
   * dies an hour later is already in exactly that state, and the daemon
   * handles it by not advertising. The refusal guarded t=0 only.
   *
   * The real requirement is never to *silently* receive no work, and the
   * answer to silence is loudness. So identity first, capability second: the
   * fingerprint comparison is the moment that matters and the machine
   * appearing on the page is the reward; the model server is the follow-up.
   * The runtime already declines to claim at zero capabilities, so nothing
   * routes here until a route goes healthy — and then it starts on its own,
   * with no second pairing.
   */
  /**
   * What the probe learned, not how many survived it.
   *
   * "0 backends are healthy" is true of a machine with no CLI installed and
   * of a machine whose subscription token expired last week, and those want
   * opposite actions from the person reading it. The canary already knew
   * which — it ran, it failed, the route was dropped — and this sentence
   * threw the answer away, so somebody paired a machine, watched it advertise
   * nothing, and had to go and find out why from a job that failed later.
   */
  {
    const lines = renderServices(
      runner.serviceStates,
      await labelFor(paths, name),
    );
    if (lines.length > 0) io.out(`\nservices\n${lines.join("\n")}\n`);
  }
  // Kept for `byollm status`, which is a different process and must not spend
  // a model call of its own to answer "how are my services".
  await writeServiceStates(paths.serviceStates, runner.serviceStates);

  if (capabilities.length === 0) {
    io.err(
      "\nNothing will route to this device yet.\n" +
        "Pairing anyway — work starts arriving on its own once a service can\n" +
        "answer. `byollm status` says where each one stands.\n",
    );
  }

  /**
   * Present the stored credential, and see whether the hub still knows it.
   *
   * Placed after detection so the heartbeat carries this device's real
   * capabilities: a reconnect that also refreshes what the hub knows is worth
   * more than one that only says hello, and `connect` has already paid for
   * the probe by this point.
   *
   * The three outcomes are deliberately not two.
   *
   * - Accepted: a session. Print what it reconnected as and stop. Nothing on
   *   the dashboard changes, and no fingerprint is compared, because nothing
   *   about this device's identity is new.
   * - Refused by name — revoked, or a runner this hub does not know: the
   *   credential is genuinely spent, and pairing is the right next step. Said
   *   out loud first, because "we are pairing again" needs a reason.
   * - Could not ask: **not a refusal.** An unreachable hub, a timeout, a
   *   clock too far off. Falling through to a ceremony here would ask
   *   somebody to re-approve a machine over a wifi problem, and would mint a
   *   pairing attempt that cannot land anyway. This is the same law as the
   *   control plane's polls and the release gate's exit 4: an unreadable
   *   answer is not a negative answer.
   */
  if (existing !== undefined) {
    const identity = new DeviceIdentity(paths.keys);
    const asStored = client.withIdentity({
      runnerId: existing.runnerId,
      sign: (input) => identity.signRequest(input),
    });
    io.out(`\nChecking this device's existing connection to ${origin}\n`);
    try {
      await asStored.heartbeat({
        runnerId: existing.runnerId,
        daemonVersion: DAEMON_VERSION,
        capabilities,
        activeLeases: [],
        /* Required by HeartbeatRequest, which is `.strict()`, so it is sent
           and not dropped: a daemon that stops sending a required field is
           rejected by every hub that has not been upgraded in lockstep. The
           field itself dies at the 0.1.0 protocol cut with the aliases —
           B044 — where one publish moves both sides at once. */
        paused: false,
      });
      const when = new Date(existing.pairedAt).toISOString().slice(0, 10);
      io.out(
        `\n  Connected as ${await labelFor(paths, name)} (paired ${when}).\n` +
          `  Nothing to approve — this device was already known here.\n`,
      );
      return 0;
    } catch (error) {
      const spent =
        error instanceof ClientError &&
        (error.kind === "revoked" || error.kind === "unauthorized");
      if (!spent) {
        const detail = error instanceof Error ? error.message : String(error);
        io.err(
          `\n  Could not check this device's connection to ${origin}.\n` +
            `  ${detail}\n\n` +
            `${wrap(
              "  This device is still paired and nothing was changed. That is " +
                "not the same as being refused, so it has not been re-paired: " +
                "try again when the connection is back.",
            )}\n`,
        );
        return 1;
      }
      io.out(
        `\n${wrap(
          `  This device's pairing with ${origin} is no longer accepted ` +
            `(${error instanceof ClientError ? error.kind : "refused"}), so ` +
            `it needs approving again.`,
        )}\n`,
      );
    }
  }

  io.out(`\nConnecting to ${origin}\n`);

  /**
   * An unreachable hub is a sentence, not a stack trace.
   *
   * `connect` used to return before this line whenever no backend was healthy,
   * so the unreachable-upstream path was mostly unreached — and it throws a
   * `ClientError` that nothing caught. Now that pairing proceeds at zero
   * capabilities, this is the ordinary failure for somebody offline, on a
   * captive-portal wifi, or pointed at a hub that is down.
   */
  /**
   * This machine's own fingerprint, printed *with* the code.
   *
   * The approval screen says "this must match the fingerprint `byollm connect`
   * printed on that machine" — and it did not print one. Todd found it the
   * only way anybody could: standing at the screen with nothing to compare
   * against.
   *
   * A comparison with one side missing is not a weaker ceremony, it is
   * theatre: the person clicks approve because the flow expects them to, and
   * the check the whole trust model rests on has quietly become a formality.
   * The keys are already in hand here — this is the moment to say so.
   */
  const deviceIdentity = await new DeviceIdentity(paths.keys).publicIdentity(
    Date.now(),
  );

  let result: Awaited<ReturnType<typeof connect>>;
  try {
    result = await connect({
      client,
      daemonVersion: DAEMON_VERSION,
      label: await labelFor(paths, name),
      capabilities,
      device: deviceIdentity,
      onCode: (info) => {
        const minutes = Math.max(
          1,
          Math.round((info.expiresAt - Date.now()) / 60_000),
        );
        /**
         * Numbered steps, because this is the one moment the daemon needs
         * somebody to go and do something.
         *
         * It printed a URL and a code as two labelled values, which reads as
         * status rather than as instruction — Todd, who designed the flow,
         * watched his own code expire waiting for the terminal to do
         * something. If the author sits still, everybody sits still.
         *
         * "Enter" rather than "find the button": where the code goes is the
         * dashboard's problem, and the approval URL carries whatever it needs
         * to open on the right screen. A step here naming a button would be a
         * step that goes stale the first time the page is redesigned.
         *
         * The code itself is highlighted — ux 09-03. Numbering the steps was
         * not enough on its own: step 2 holds the only value somebody has to
         * carry to another window, and it sat in a line that looked exactly
         * like the two around it. The emphasis wraps the code and not the
         * label, and it is absent the moment this is not a terminal, so a
         * piped transcript still holds a code somebody can paste.
         */
        io.out(
          `\n  Your steps:\n` +
            `    1) Open:       ${info.verificationUrl}\n` +
            `    2) Enter code: ${emphasise(info.userCode, terminalContext())}   ` +
            `(expires in ${String(minutes)} minutes)\n` +
            `    3) Check the screen shows this device's fingerprint, ` +
            `then approve:\n\n` +
            `       ${fingerprint(deviceIdentity.identity)}\n\n` +
            `  waiting for approval…`,
        );
      },
      onPoll: () => {
        io.out(".");
      },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    io.err(
      `\n  Could not pair with ${origin}.\n  ${detail}\n\n` +
        `  Check the URL and your connection, then try again. Nothing was ` +
        `changed on this device.\n`,
    );
    return 1;
  }

  if (!result.ok) {
    io.out(`\n\n  ${result.message}\n`);
    return 1;
  }

  const pairings = new Pairings(paths.pairings);
  await pairings.load();
  reportSkipped(pairings, io);
  await pairings.put(result.pairing);

  /**
   * The mark is cleared by the thing that fixes it.
   *
   * A revoked device that re-pairs is not revoked, and a mark that outlived
   * its own remedy would be a machine told it cannot serve while it serves —
   * the same class of lie as a status line that outlives the consent it
   * reports.
   *
   * Written through the health file's own writer so the rest of the record
   * survives: this clears one field, it does not reset what the daemon knows
   * about its upstream.
   */
  await clearRevokedMark(paths.health);

  io.out(` paired as ${result.pairing.ownerLabel ?? result.pairing.owner}\n`);
  // The keys this machine just pinned, printed where somebody can still
  // compare them. The approval happened in a browser, so this is the first
  // moment the two ends of that decision are visible on the same screen —
  // and a pin nobody can see is a pin nobody checks. Sites that arrive
  // *later* get the same treatment through `byollm sites`, where they wait
  // for an answer rather than being pinned (V1-1).
  // One line, not two. A site's id in this file *is* its fingerprint —
  // `keyId` and `fingerprint` are the same function, and `runner.ts` refuses
  // any entry where they disagree — so printing both stuttered the same
  // string twice and read as two facts to check against each other.
  //
  // Derived from the pinned key rather than taken from the map key: the value
  // on screen should be computed from the material it describes, so what
  // somebody compares by eye is the key itself and not a label beside it.
  /**
   * Labelled, and labelled as *not this device* — ruled 2026-09-03.
   *
   * These printed bare, indented, immediately under "paired as <id>". Todd
   * read them as a second fingerprint for this machine and asked what he was
   * meant to compare them against.
   *
   * Nothing, is the answer: they are the keys of the sites this pairing
   * covers. But the question was the right one to ask, on the one screen
   * where a fingerprint comparison is the whole security model. An unlabelled
   * fingerprint there invites a comparison nobody defined, and a person who
   * compares the wrong pair once and finds no match learns that the
   * comparison is noise.
   *
   * `pinned:` is the word `byollm status` already uses for the same list —
   * one vocabulary — and the heading says whose keys these are.
   */
  const pinned = Object.values(result.pairing.sites);
  if (pinned.length > 0) {
    io.out(
      `   sites this pairing covers — site keys, not this device's ` +
        `fingerprint:\n`,
    );
    for (const site of pinned) {
      io.out(`     pinned: ${fingerprint(site.identity)}\n`);
    }
  }
  /* Nothing pinned yet is the normal first install: you pair before you have
     connected anything, because there is nothing to connect a site to
     beforehand. Said out loud so the empty list reads as a step remaining
     rather than as something having gone wrong — and so nobody waits for work
     that has no reason to arrive. */
  if (Object.keys(result.pairing.sites).length === 0) {
    io.out(
      `   no sites yet — connect one in your dashboard and its first job\n` +
        `   will arrive here, with its fingerprint, for you to see.\n`,
    );
  }
  /**
   * Pairing is a ceremony, not a service — ruled 2026-09-01.
   *
   * This ended by calling `runLoop`, so `byollm connect` pinned the keys and
   * then sat in the foreground forever running jobs. Two costs, and the
   * second is the one that mattered on a walk:
   *
   * Somebody who ran it in a terminal they then closed had a device that was
   * paired and not running, with nothing on screen having said the two were
   * different things. And somebody who left it open had a "daemon" that
   * survived exactly as long as that window — no supervisor, no restart, no
   * log — which looks identical to a healthy install until the laptop sleeps.
   *
   * Running is `run`'s job in the foreground and `install`'s as a service.
   * So this ends, and says which of the two to do next.
   */
  io.out(
    `\nPaired. Nothing is running yet — pairing and running are separate:\n` +
      `  byollm install     keep it running in the background (recommended)\n` +
      `  byollm run         run in this terminal, Ctrl-C to stop\n`,
  );

  return 0;
}

// -- run ---------------------------------------------------------------------

async function commandRun(
  paths: DaemonPaths,
  args: readonly string[],
  io: CliIo,
  signal?: AbortSignal,
  pollMs = PARK_POLL_MS,
  supervised = !process.stdout.isTTY,
  interactive = process.stdout.isTTY,
  preflightOptions: {
    platform?: NodeJS.Platform;
    verify?: (config: {
      readonly type: BackendId;
      readonly model: string;
      readonly baseUrl?: string | undefined;
    }) => Promise<{
      readonly answers: boolean | undefined;
      readonly detail?: string | undefined;
    }>;
    login?: (command: LoginCommand) => Promise<boolean>;
    ask?: (question: string) => Promise<string>;
  } = {},
): Promise<ExitCode> {
  /**
   * No url — byollm_020.
   *
   * `run <url>` meant "serve only this one app", which nobody wanted and
   * everybody misread: the url in `connect <url>` is where you pair, and the
   * same shape here read as "point the daemon at this address". Two commands
   * taking a url, one of which does not mean what it looks like, is the
   * confusion this audit is for. Serving every paired app is the whole job.
   */
  if (args.length > 0) {
    io.err(
      `byollm run takes no arguments, and got ` +
        `${args.map((arg) => JSON.stringify(arg)).join(" ")}.\n\n` +
        `  byollm run                 serve every app this device is paired with\n` +
        `  byollm connect ${args[0] ?? "<url>"}   pair with an app\n` +
        `  byollm sites               which sites this device serves\n`,
    );
    return 2;
  }

  /**
   * Asked before anything serves — B047, the half `run` did not have at all.
   *
   * `signedOutLines` had exactly one caller and it was `start`, so somebody
   * running the foreground daemon — which on Windows is the path that
   * reliably works — got no signed-out surface whatsoever. Kevin ran it
   * signed out and watched a serving line for services that could not serve.
   *
   * Outside the loop: the loop re-enters on re-pairing, and asking again
   * there would be asking a question nobody's answer had changed.
   */
  await preflightFor(paths, io, interactive, preflightOptions);

  /*
   * Re-entered, not run once, so that re-pairing can end a park.
   *
   * The pairings are read inside the loop for the same reason: the file is
   * how another process hands this one the news, and a parked daemon that
   * kept its first reading would come back to serve exactly the nothing it
   * parked over.
   */
  for (;;) {
    const pairings = new Pairings(paths.pairings);
    await pairings.load();
    reportSkipped(pairings, io);

    const origins = pairings.list().map((pairing) => pairing.origin);

    const outcome =
      origins.length === 0
        ? // The branch Todd's service log repeated all evening, for a machine
          // that was paired and had been revoked. It is the *first* of two
          // that can find nothing to serve, and it was the one being reached
          // — which is why the decision lives in one function now rather than
          // beside each `return`.
          await nothingToServe(paths, io, signal, supervised, [], pollMs)
        : await runLoop(paths, origins, io, signal, supervised, pollMs);

    if (outcome !== "repaired") return outcome;
    io.err("re-paired — this device is returning to service.\n");
  }
}

/**
 * Say so when a pairing row could not be read — cloud_008 §2.3a.
 *
 * `load` skips what it cannot parse instead of discarding the whole file, and
 * a skip nobody mentions is the same silence in a smaller box: the user would
 * see one connection missing and no reason for it. Named on stderr, by origin
 * and failing field, never by value — a pairing row holds pinned keys.
 */
function reportSkipped(pairings: Pairings, io: CliIo): void {
  for (const row of pairings.skipped) {
    io.err(
      `could not read the pairing for ${row.origin} (${row.problem}) — ` +
        "it was skipped; re-pair with `byollm connect` to restore it\n",
    );
  }
  // Ours to explain, not theirs to fix — so `out`, not `err`.
  for (const notice of pairings.retired) {
    io.out(`note: ${notice}\n`);
  }
}

/**
 * The allowlist file, retired out loud — Amendment I.
 *
 * A file full of names this device used to honour, that it now ignores, is
 * the worst possible state to leave silently: the entries stay on disk
 * reading like grants, and the person who wrote them has no way to learn they
 * stopped meaning anything. Pre-1.0 gives us the liberty to delete the
 * machinery; it does not give us the liberty to delete it quietly.
 *
 * So this reads what is there, says whose access ended and where that
 * decision lives now, and removes the file — once. Reported at `status` and
 * at the start of a run, which are the two places somebody is looking.
 *
 * It names the people. "3 entries were retired" is a count; the point of the
 * notice is that somebody can recognise a name and go re-add them in the one
 * place that can now authorise it.
 */
async function retireAllowlist(paths: DaemonPaths, io: CliIo): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(paths.allowlist, "utf8");
  } catch {
    return;
  }

  const names = new Set<string>();
  try {
    const parsed: unknown = JSON.parse(raw);
    const entries = (parsed as { entries?: unknown }).entries;
    if (Array.isArray(entries)) {
      for (const entry of entries as { owner?: unknown; origin?: unknown }[]) {
        if (
          typeof entry.owner === "string" &&
          typeof entry.origin === "string"
        ) {
          names.add(
            `${stripControlChars(entry.owner)} on ${stripControlChars(entry.origin)}`,
          );
        }
      }
    }
  } catch {
    // Unreadable is still retired. The file goes either way, and saying so
    // without a list is better than saying nothing because a parse failed.
  }

  io.out(
    `\n${wrap(
      "note: this device used to keep its own list of people allowed to use " +
        "it. That list is gone — it could never check the names on it, so it " +
        "only ever agreed with whoever was asking.",
    )}\n`,
  );
  for (const name of [...names].sort()) {
    io.out(`  no longer allowed here: ${name}\n`);
  }
  io.out(
    `${wrap(
      names.size > 0
        ? "Add them again from your team page, where a relay can actually " +
            "verify who they are."
        : "Membership lives with your relay now, and arrives one signed grant " +
            "at a time.",
    )}\n`,
  );
  await rm(paths.allowlist, { force: true });
}

/**
 * What a run ended as: an exit code, or the news that it should start again.
 *
 * `"repaired"` is not an exit. A parked daemon that sees its revocation
 * undone has to go back and build the runners it never built, and the only
 * honest way to say that in a return type is a value that is not a code.
 */
type ServeOutcome = ExitCode | "repaired";

/**
 * There is nothing to serve, and why that is decides everything after it.
 *
 * Two call sites reach this — no pairings at all, and pairings that all
 * skipped — and before tonight each wrote its own sentence. One of them said
 * "No apps are paired yet" to a machine that was paired and revoked. Todd read
 * it on repeat in his service log while launchd restarted the daemon behind
 * it.
 *
 * ## Three decisions, and they are separable
 *
 * **What is true.** Empty-because-revoked and empty-because-never-paired are
 * different facts. Both remedies happen to be `connect`, which is exactly why
 * the wrong sentence survived so long: it sent people somewhere useful by
 * luck, and read as "your setup never finished" to somebody whose setup
 * finished weeks ago.
 *
 * **What to say.** The ruled sentence for the first, the connect instructions
 * for the second.
 *
 * **Whether to exit.** Exiting invites a supervisor to start us again, and
 * launchd obliges every ten seconds: boot, refused, exit, boot — each turn a
 * request the hub answers only to say no again. Revocation is not transient
 * and no backoff makes hammering it correct, so under a supervisor the
 * process stays up, marked, serving nothing. Interactively it exits, because
 * somebody who typed `byollm run` wants their prompt back and a command that
 * hangs after explaining itself is its own small cruelty.
 */
async function nothingToServe(
  paths: DaemonPaths,
  io: CliIo,
  signal?: AbortSignal,
  supervised = !process.stdout.isTTY,
  /** What we were asked to serve; empty means "whatever is paired". */
  origins: readonly string[] = [],
  pollMs = PARK_POLL_MS,
): Promise<ServeOutcome> {
  const mark = await revokedMark(paths.health);
  if (mark === undefined) {
    io.err(
      "No app is paired, so there is nothing to serve — this device will " +
        "appear on rosters and answer nothing.\n" +
        "  byollm connect <url>   pair this device\n" +
        "  byollm status          what this device believes right now\n",
    );
    return 2;
  }

  io.err(
    `${REVOKED_SENTENCE}.\n` +
      `  ${mark.origin} no longer accepts this device's credential, so ` +
      `there is nothing to serve.\n` +
      revokedRemedy(mark.origin, supervised),
  );
  if (!supervised) return 2;
  return (await parkedUntilRepaired(paths, origins, signal, pollMs))
    ? "repaired"
    : 0;
}

/**
 * How often a parked daemon asks whether the remedy has been applied.
 *
 * Slow is about not spinning, and nothing else: this reads two local files
 * and never speaks to the hub, so the reason the rest of this daemon backs
 * off — do not hammer somebody else's server — has no force here. What sets
 * the number is the person: they run `byollm connect`, they are told the
 * service comes back on its own, and this is how long they watch a dark
 * machine before that sentence starts to look like a lie.
 */
const PARK_POLL_MS = 15_000;

/** Resolves `true` if the wait was cut short by the signal. */
function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    // Declared after the timer it clears, and used only from a callback that
    // cannot run before this line — the alternative is a `let` that lint
    // rightly objects to.
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Wait, parked, until the revocation is undone — or until we are stopped.
 *
 * The gap this closes: a revoked daemon under a supervisor stayed up holding
 * nothing but its abort signal. `byollm connect` runs in a *different*
 * process; it clears the mark and writes the pairing, says "paired", and had
 * no way at all to reach the waiter. The machine stayed dark until somebody
 * restarted it by hand, having been given no reason to think they needed to.
 *
 * **A poll may promote, never demote** — the rule the hub's pollers already
 * follow, turned on the daemon's own state. This only ever moves parked to
 * serving. It cannot park a serving daemon, and a read that fails is not an
 * answer: `revokedMark` returning `undefined` on an unreadable health file
 * would be indistinguishable from a cleared mark, so promotion also requires
 * a pairing to be present and readable. Two facts have to agree before this
 * wakes anything up.
 *
 * Returns `true` when the caller should go back and serve.
 */
async function parkedUntilRepaired(
  paths: DaemonPaths,
  origins: readonly string[],
  signal: AbortSignal | undefined,
  pollMs: number,
): Promise<boolean> {
  for (;;) {
    if (await sleepOrAbort(pollMs, signal)) return false;
    if ((await revokedMark(paths.health)) !== undefined) continue;

    const pairings = new Pairings(paths.pairings);
    await pairings.load();
    // An empty `origins` is `byollm run` with no argument — any pairing will
    // do, because any pairing is what it would have served.
    const served = pairings
      .list()
      .some(
        (pairing) => origins.length === 0 || origins.includes(pairing.origin),
      );
    if (served) return true;
  }
}

async function runLoop(
  paths: DaemonPaths,
  origins: readonly string[],
  io: CliIo,
  signal?: AbortSignal,
  /**
   * Is something restarting us if we exit?
   *
   * A TTY, because that is the difference that matters and it needs no
   * configuration to be true on machines installed before this existed:
   * launchd, systemd and Task Scheduler all run us without one, and a person
   * at a prompt always has one. The cost is that `byollm run | tee log`
   * interactively looks supervised — it would wait rather than return, on a
   * revoked machine, which is the same thing the supervisor case wants and a
   * Ctrl-C away from over.
   *
   * Injected so the tests can be either.
   */
  supervised = !process.stdout.isTTY,
  pollMs = PARK_POLL_MS,
): Promise<ServeOutcome> {
  const { loaded, ingress, budgets, spend, spentGrants } = await context(paths);
  const identity = new DeviceIdentity(paths.keys);
  const pairings = new Pairings(paths.pairings);
  await pairings.load();
  reportSkipped(pairings, io);
  await retireAllowlist(paths, io);

  const controller = new AbortController();
  signal?.addEventListener(
    "abort",
    () => {
      controller.abort();
    },
    { once: true },
  );
  /*
   * An abort that already happened fires no listener.
   *
   * Registering was the whole of the wiring, so a signal aborted before this
   * line — a caller that stops us during startup, or the re-entry after a
   * park, where the stop can land between the decision to serve and the
   * setup that serves — started a full polling loop that nothing could ever
   * stop. `AbortSignal` is a latch, not an event: it has to be read as well
   * as subscribed to.
   */
  if (signal?.aborted === true) controller.abort();
  const runners: Runner[] = [];

  for (const origin of origins) {
    const pairing = pairings.get(origin);
    if (!pairing) {
      io.err(`not paired with ${origin}\n`);
      continue;
    }
    const runner = new Runner({
      client: new ProtocolClient({
        origin,
        identity: {
          runnerId: pairing.runnerId,
          sign: (input) => identity.signRequest(input),
        },
      }),
      runnerId: pairing.runnerId,
      owner: pairing.owner,
      // What this pairing pinned, if it pinned one — Amendment G. A pairing
      // made before roster sync existed has none, so it holds no roster and
      // says so; re-pairing is what installs it.
      ...(pairing.controlPlanePublic === undefined
        ? {}
        : { controlPlanePublic: pairing.controlPlanePublic }),
      // Only the long-running daemon records health. The short-lived commands
      // that also build a Runner — `connect`, `services` — would otherwise
      // write a count from one attempt, which says nothing about how the
      // daemon that actually runs is getting on.
      healthPath: paths.health,
      // Written whenever it changes, not only at start — S2. `byollm status`
      // is a different process and this file is the whole of what reaches it.
      onServiceStates: (states) =>
        writeServiceStates(paths.serviceStates, states),
      identity: {
        keys: () => identity.load(Date.now()),
        // What was on disk. The runner replaces it from each heartbeat and
        // the loop below writes changes back — cloud_009 §5.
        sites: new Map(Object.entries(pairing.sites)),
        // And what was ever approved, which is what a re-offered id is
        // compared against — V1-1.
        known: new Map(Object.entries(pairing.known ?? {})),
      },
      daemonVersion: DAEMON_VERSION,
      loaded,
      budgets,
      spend,
      spentGrants,
      ingress,
      onEvent: (event) => {
        report(origin, event, io);
        // The set follows consent, and the file follows the set — cloud_009
        // §5. Not awaited, for the reason the revocation branch below gives:
        // an event handler that throws takes the runner with it, and a file
        // that cannot be written is worth a message rather than a crash.
        if (event.type === "heartbeat") {
          void recordSites(pairings, origin, runner.sites, {
            known: runner.known,
          })
            .then(async () => {
              // Then read the file back, because a re-pair may have happened
              // in another terminal. `byollm connect` cannot call into a
              // running loop, so it arrives the only way one process can hand
              // something to another here — through the file both share.
              //
              // This used to carry approvals through the same door. There are
              // no approvals any more (Amendment K); the door stays for the
              // one thing pairing still produces.
              await pairings.load();
              const fresh = pairings.get(origin);
              if (fresh?.controlPlanePublic !== undefined) {
                runner.adoptControlPlaneKey(fresh.controlPlanePublic);
              }
            })
            .catch((error: unknown) => {
              io.err(
                `could not record the site list for ${origin}: ` +
                  `${error instanceof Error ? error.message : "unknown error"}\n`,
              );
            });
        }

        // Revocation drops the pairing — cloud_008 §2.3, finding 24.
        //
        // The daemon stopped and said so, and left the pinned site key on
        // disk. So `byollm run` came back tomorrow and tried to reconnect to
        // a site that had withdrawn consent: refused, correctly, but the
        // machine still held a key for a relationship that had ended, and the
        // user's own `byollm list` still showed the pairing.
        //
        // Revocation is the site saying the relationship is over. Making that
        // durable on this side is the daemon's half of
        // `REVOCATION_IMMEDIATE`, and re-connecting is a re-pair — which is a
        // consent screen, which is the point.
        //
        // Not awaited: an event handler that throws would take down a runner
        // that has already stopped, and a pairing file that cannot be written
        // is worth a message rather than a crash.
        /**
         * Mark, never destroy — ruled 2026-09-03.
         *
         * This deleted the pairing from disk. That turned a wrong server
         * answer into local data loss, and the bug that produced this ruling
         * is the proof that the answer can be wrong: an owner-scoped guard
         * refused devices that had never been revoked, and each one deleted
         * its own pairing on the way down. A device paired thirty seconds
         * earlier lost its pins and its owner lost the evidence.
         *
         * Deleting bought no safety. Enforcement lives where the authority
         * is: the hub refuses a revoked device whatever this file remembers,
         * so the local copy protects nothing and its absence explains
         * nothing. `byollm forget` still exists for somebody who means it.
         *
         * The runner has already stopped serving by the time this fires —
         * `#revokedBy` sets `#stopped` and cancels everything — so what is
         * left to do is say so.
         */
        if (event.type === "revoked") {
          io.out(
            `${new URL(origin).host} says this device was revoked. ` +
              `It has stopped serving.\n` +
              `  The pairing is kept, not deleted — re-pair to return:\n` +
              `    byollm connect ${origin}\n`,
          );
        }
      },
    });
    runners.push(runner);
  }

  if (runners.length === 0) {
    // Every origin that got here was skipped for a reason already said out
    // loud above; `nothingToServe` supplies the consequence and decides
    // whether exiting would hand the supervisor a loop.
    return nothingToServe(paths, io, signal, supervised, origins, pollMs);
  }

  // Leases are released on the way out, so the app sees work return to the
  // queue at once instead of waiting for a lease to lapse.
  // Only take over the process's signals when nobody handed us one of their
  // own — an embedder (or a test) that passed a signal owns its own lifecycle.
  if (signal === undefined) {
    const stop = (): void => {
      controller.abort();
      // Ctrl-C must end in an exit, whatever the release path does. Without a
      // rejection handler a failing `shutdown` left `process.exit` unreached
      // and killed the daemon on an unhandled rejection instead — the same
      // exit, with a stack trace and a misleading code.
      Promise.all(runners.map((runner) => runner.shutdown("shutdown"))).then(
        () => {
          process.exit(0);
        },
        (error: unknown) => {
          // Leases will lapse on their own; say what happened and leave a
          // non-zero code so a supervisor can tell this apart from a clean
          // stop.
          io.err(`shutdown did not complete cleanly: ${String(error)}\n`);
          process.exit(1);
        },
      );
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }

  /**
   * Say it is working, on the surface where nobody else will — B037.
   *
   * `byollm run` printed nothing at all on start. On Windows especially,
   * where it is the path that reliably works, a person ran it and watched an
   * empty terminal: no way to tell "serving" from "hung" from "silently
   * failed", so the honest reaction was to assume the worst and stop.
   *
   * The supervised daemon has always logged its state; this is the same
   * sentence on the foreground path, which is the one somebody is actually
   * looking at. It names the device because that is the word the dashboard
   * uses, and says where the enabling happens, because the next question
   * after "is it running" is always "then why is nothing arriving".
   */
  io.out(
    `serving as ${await labelFor(paths, undefined)} — ` +
      `${describeOrigins(origins)}.\n` +
      `Which sites may send work is enabled from your dashboard. ` +
      `Ctrl-C to stop.\n`,
  );

  await ingress.applyRetention(Date.now());
  await Promise.all(runners.map((runner) => runner.run(controller.signal)));
  await Promise.all(runners.map((runner) => runner.shutdown("shutdown")));
  return 0;
}

/**
 * One line per event.
 *
 * Every interpolated string that could contain remote text goes through
 * {@link stripControlChars} first: a refusal reason or an error message may
 * quote a payload, and text that can repaint a terminal can forge output
 * (byollm_004 §5's ANSI/log-injection row).
 */
function report(origin: string, event: RunnerEvent, io: CliIo): void {
  const at = new Date().toISOString().slice(11, 19);
  const host = new URL(origin).host;

  switch (event.type) {
    case "claimed":
      io.out(`${at} ${host} claimed ${event.kind} ${event.jobId}\n`);
      break;
    case "finished":
      io.out(
        `${at} ${host} ${event.outcome} ${event.jobId} ` +
          `(${String(event.durationMs)}ms)\n`,
      );
      break;
    case "refused":
      io.out(
        `${at} ${host} refused ${event.jobId}: ` +
          `${stripControlChars(event.reason)}\n`,
      );
      break;
    case "revoked":
      io.out(`${at} ${host} this runner was revoked. Stopping.\n`);
      break;
    // Not a fault and not a revocation: the terms this machine runs under
    // changed, and the person who has to read them is the one at this
    // keyboard. The daemon keeps running and keeps its pairing.
    case "awaiting-consent":
      // Names the sites, because "something changed" sends somebody hunting.
      // A pairing covers a set now (cloud_009 §5), and one site's terms
      // moving leaves every other site running.
      io.out(
        `${at} ${host} paused for ${event.sites.join(", ")} — the terms ` +
          `changed and are waiting for you. Open your connections page to ` +
          `read them; nothing runs for those sites until you do.\n`,
      );
      break;
    case "site-key-changed":
      // Refused, not applied. The map is keyed by identity key id, so this is
      // an encryption key moving under an identity whose fingerprint somebody
      // already compared — which is the substitution pinning exists to stop.
      io.err(
        `${at} ${host} refused a changed key for site ${event.site}. ` +
          `Nothing was re-pinned. If this site rotated its keys on purpose, ` +
          `re-pair with \`byollm connect\`.\n`,
      );
      break;
    case "site-rotated":
      // Loud, and on stdout rather than stderr: this is not a fault. It is a
      // key movement that verified, which is the one thing that must never
      // happen quietly — C.5. Both fingerprints are printed because the whole
      // point is that somebody can compare the new one against what the site
      // now shows, and the old one against what they remember approving.
      io.out(
        `${at} ${host} site ${event.site} rotated its key.\n` +
          `    was: ${event.fromFingerprint}\n` +
          `    now: ${event.fingerprint}\n` +
          `    Accepted because the previous key signed for this one. ` +
          `Nothing was re-approved by hand.\n` +
          (event.path.length > 2
            ? `    Through ${String(event.path.length - 1)} rotations since ` +
              `the key this device approved.\n`
            : ""),
      );
      break;
    case "service-not-signed-in":
      // Says what to do, because a notice about a credential that names no
      // command is a notice somebody has to go and research.
      io.err(
        `${at} ${host} ${event.service} is not signed in — it has stopped ` +
          `taking work.\n` +
          `    ${event.detail}\n` +
          `    Sign in with that tool, then restart: ` +
          `\`byollm run\` re-checks on start.\n`,
      );
      break;
    case "service-signed-in":
      /* The other half of the sign-in notice. Somebody was sent to a
         terminal; this is the daemon saying it noticed they went. Without it
         the only evidence the remedy worked is work quietly starting to
         flow, which is not evidence anybody can see. */
      io.err(
        `${at} ${host} ${event.service} is signed in again — it is taking ` +
          `work.\n`,
      );
      break;
    case "service-out-of-quota":
      /*
       * Names no command, because there is not one — 019 §3.2.
       *
       * Every other notice on this stream ends in something to run. Ending
       * this one that way would be inventing a remedy: the account is fine,
       * the credentials are fine, and the only thing that fixes it is a
       * clock. So it says when, and says the machine handles the rest, which
       * is true — the service is re-advertised on its own.
       */
      io.err(
        `${at} ${host} ${event.service} is out of quota — it has stopped ` +
          `taking work.\n` +
          (event.until === undefined
            ? `    Nothing to fix and nothing to sign in to. It will be ` +
              `offered again once it answers.\n`
            : `    Back around ${new Date(event.until).toLocaleTimeString()}` +
              `. It will be offered again on its own.\n`),
      );
      break;
    case "now-serving":
      /**
       * The mitigation for site policy moving to the account — Amendment K.
       *
       * This line used to ask a question ("run `byollm approve`"); it now
       * reports a fact, and that difference is the trade. A device owner no
       * longer decides which sites this machine serves. What they keep is
       * knowing, at the machine, the first time each one asks for anything —
       * and the levers that bound it, which the message names because a
       * notice with nothing to do about it is just noise.
       */
      io.out(
        `${at} ${host} now serving ${event.site}, enabled from your ` +
          `dashboard.\n    fingerprint: ${event.fingerprint}\n` +
          `    Not expected? \`byollm stop\` stops all work, and ` +
          `\`byollm forget\` drops the pairing.\n`,
      );
      break;
    case "site-refused":
      io.err(
        `${at} ${host} refused site ${event.site}: ` +
          `${stripControlChars(event.reason)}. Nothing was pinned.\n`,
      );
      break;
    case "serving-nothing":
      // Said once, and said as the ordinary thing it is. This used to print
      // "this runner was revoked" and delete the pairing — a sentence that
      // was true only when it happened to be, and destructive when it was
      // not.
      io.out(
        `${at} ${host} nothing is consented for this device right now. ` +
          `The pairing stands; work resumes when a site is connected again.\n`,
      );
      break;
    case "consent-resumed":
      io.out(`${at} ${host} resumed — thank you.\n`);
      break;
    case "error":
      io.err(`${at} ${host} ${stripControlChars(event.message)}\n`);
      break;
    case "heartbeat":
      break;
  }
}

// -- status ------------------------------------------------------------------

async function commandStatus(
  paths: DaemonPaths,
  io: CliIo,
  service: ServiceIo,
): Promise<ExitCode> {
  const { loaded, ingress, budgets, spend, spentGrants } = await context(paths);
  const pairings = new Pairings(paths.pairings);
  await pairings.load();
  reportSkipped(pairings, io);
  await retireAllowlist(paths, io);

  // Whether anything here could admit a stranger at all. A `team` offer on a
  // device paired with nothing serves one person, and both surfaces say so
  // rather than printing the request.
  const hasRelay = pairings
    .list()
    .some((pairing) => pairing.controlPlanePublic !== undefined);

  const now = Date.now();

  io.out(formatVersion());
  // This machine's fingerprint, so an owner can compare it against what a
  // site shows them (byollm_009 §3). A fingerprint nobody can find is a
  // fingerprint nobody compares.
  io.out(
    `identity: ${await new DeviceIdentity(paths.keys).fingerprint(now)}\n`,
  );
  // **A persistent rejection is a state, and it leads.**
  //
  // This line said `running` for hours while every heartbeat the daemon sent
  // was refused. True, and useless: the daemon was running, reporting
  // nothing, invisible to the hub, and the device's page showed frozen data.
  // The only surface that knew was a log line nobody tails.
  //
  // So the headline answers "is this device working" rather than "is the
  // process alive", and those turned out to be different questions.
  const health = await readHealth(paths.health);
  const failing =
    health !== undefined && health.consecutiveFailures >= FAILURES_BEFORE_ALARM;

  /**
   * The supervisor's answer, asked once and used twice — ruled 2026-09-03.
   *
   * `state:` printed `running` two lines above `service: installed but NOT
   * running`. One display holding two truths, and a status that disagrees
   * with itself teaches the reader to trust neither line.
   *
   * The cause was that this headline consulted a local flag and the health
   * file and never the supervisor, so it was answering a narrower question
   * than the word `state` promises. It is meant to answer "is this device
   * working", and a device whose service is dead is not working.
   *
   * `PAUSED` is gone from this list (B043) because it was the worst version
   * of that same bug: it outranked every other state and was set by a flag
   * the daemon did not read, so the one line people check said the machine
   * was idle while it claimed work.
   *
   * `absent` does not demote it: no service registered is the ordinary shape
   * of `byollm run` in a terminal, which is working fine.
   */
  const plan = servicePlan(serviceTarget(paths, service));
  const supervision = await serviceState(plan, service.run);
  const revoked = await revokedMark(paths.health);

  io.out(
    `state: ${
      revoked !== undefined
        ? "REVOKED"
        : supervision.state === "installed"
          ? "NOT RUNNING"
          : failing
            ? "NOT REPORTING"
            : "running"
    }\n`,
  );
  if (revoked !== undefined) {
    /* The ruled sentence, as the headline's own explanation. Everything below
       it on this screen describes a device that is not going to serve
       anything until it is paired again. */
    io.out(
      `  ${REVOKED_SENTENCE}.\n` +
        `  ${revoked.origin} no longer accepts this device's credential.\n` +
        revokedRemedy(revoked.origin, supervision.state !== "absent"),
    );
  }
  if (failing) {
    io.out(
      `  the hub has rejected this device's last ` +
        `${String(health.consecutiveFailures)} messages — it is running and ` +
        `invisible.\n` +
        (health.origin === undefined ? "" : `  upstream: ${health.origin}\n`) +
        (health.lastError === undefined
          ? ""
          : `  it said: ${health.lastError}\n`) +
        `  anything below is what this device believes, not what the hub has ` +
        `been told.\n`,
    );
  }
  io.out(await supervisionLine(plan, supervision, revoked !== undefined));
  io.out("\n");

  io.out("paired apps\n");
  const list = pairings.list();
  if (list.length === 0) {
    io.out("  (none — run `byollm connect <url>`)\n");
  }
  for (const pairing of list) {
    io.out(`  ${pairing.origin}  as ${pairing.ownerLabel ?? pairing.owner}\n`);
    // The pinned key, so an owner can check it against what the app shows.
    // A pin nobody can see is a pin nobody can verify.
    // Every pinned key, so an owner can check each against what the site
    // shows. A pin nobody can see is a pin nobody can verify, and a pairing
    // covering several sites hides several of them behind one line.
    for (const site of Object.values(pairing.sites)) {
      io.out(`    pinned: ${fingerprint(site.identity)}\n`);
    }
  }

  // **Services and defaults. No routes section** — ruled 2026-08-25.
  //
  // `routes` was the old shape's ghost. It listed one line per resolved kind,
  // which in Phase A *was* the service list, and by Phase B it was a third
  // section describing facts the first two already carry: a route is a
  // (service, kind) pair plus which one is the default, and both of those are
  // here. Three displays of two facts is how they drift apart, which is this
  // morning's lesson pointed at our own output.
  //
  // The two facts a service can have about a kind are said apart. Every
  // declared service **answers** the kinds it declares — a mapping may point
  // at any of them — and one of them may additionally be the owner's own
  // **default**, which decides only where a job nothing resolved goes.
  //
  // "selectable for" lived here until Amendment L, meaning "a site may name
  // this one". No site names anything now, so the word described a power
  // nobody has; the kinds a service answers is the fact that survived.
  //
  // There is no separate `defaults` section, and there was one for about an
  // hour. It listed `llm.chat → claude` beside a service line already reading
  // `claude — default for llm.chat`: the same fact twice, which is the
  // criticism that removed `routes` the same afternoon. A display that
  // restates itself is two things to keep in step, and only one of them gets
  // updated.
  const byService = new Map<
    string,
    { answers: string[]; defaults: string[] }
  >();
  for (const route of loaded.routes) {
    const entry = byService.get(route.service) ?? {
      answers: [],
      defaults: [],
    };
    entry.answers.push(route.kind);
    if (route.isDefault) entry.defaults.push(route.kind);
    byService.set(route.service, entry);
  }

  io.out("\nservices\n");
  // What the last probe recorded, if anything has probed. Read rather than
  // re-run — see the comment beside `authLine` below.
  const recorded = await readServiceStates(paths.serviceStates);
  const deviceName = await labelFor(paths, undefined);
  const declared = Object.entries(loaded.config.services);
  if (declared.length === 0) {
    io.out("  (none configured)\n");
  }
  for (const [name, service] of declared) {
    const entry = byService.get(name) ?? { answers: [], defaults: [] };
    const route = loaded.routes.find((r) => r.service === name);
    const shown =
      route === undefined
        ? service.model
        : `${route.model}  (${route.backendId})`;
    // "private (only you)" rather than "offered to private" — the config's
    // word, with the consequence beside it, so nobody has to already know
    // what the word means to read the line.
    //
    // **The effective scope, not the configured one.** This read
    // `service.offer` and so answered from the file rather than from the
    // daemon: a metered service configured `team` but narrowed to `private`
    // pending spend consent printed "team (you and people you allow)" while
    // refusing every one of them. The config is a request; `route.offerScope`
    // is what happened to it.
    const summary = offerSummary({
      effective: route?.offerScope ?? service.offer,
      configured: service.offer,
      hasRelay,
    });
    const scope =
      `${summary.scope} (${summary.audience})` +
      (summary.narrowedBy === undefined ? "" : ` — ${summary.narrowedBy}`);

    /**
     * What the last probe found, if anything has probed.
     *
     * Read rather than re-run: this is a different process, and the canary is
     * a real model call — on a metered backend, real money, on a command
     * people run repeatedly while something is wrong.
     *
     * Absent is not signed-out. A machine that has never probed prints what it
     * always printed, because "nothing has asked yet" is not a finding.
     */
    const authLine = authNote({
      service: name,
      device: deviceName,
      report: recorded.get(name),
    });
    // Three short lines rather than one long one. `openai-http:` prefixed
    // onto `mlx-community/Qwen2.5-14B-Instruct-4bit` with a scope after it
    // wrapped at any sane terminal width, and a wrapped line in a column
    // layout stops looking like a column at all.
    //
    // The backend id goes with the scope rather than the model: it is the
    // same *kind* of fact — how this service behaves — while the model is the
    // thing a person recognises and the only part that is genuinely long.
    io.out(`  ${name}\n`);
    io.out(`      ${shown}\n`);
    const says: string[] = [];
    if (entry.answers.length > 0) {
      says.push(`answers ${entry.answers.join(", ")}`);
    }
    if (entry.defaults.length > 0) {
      // Named as *yours*, because that is the whole of what a default is now:
      // where your own work goes when nothing resolved it. A relayed job
      // arrives already resolved and never consults it.
      says.push(`your default for ${entry.defaults.join(", ")}`);
    }
    io.out(
      `      ${scope} · ${says.length === 0 ? "not offered — see the problems below" : says.join(" · ")}\n`,
    );
    /* The auth line, when the probe found something to say. Same template as
       `byollm connect` and the daemon's output, so one machine cannot
       describe itself differently depending on where you look. */
    if (authLine !== undefined) {
      io.out(`      ${authLine.line}\n`);
      if (authLine.detail !== undefined) {
        io.out(`        ${authLine.detail}\n`);
      }
    }
  }

  // **Withheld is shown, never merely absent.**
  //
  // A kind two services answer is not advertised until the owner says which
  // wins — correct, and silent in every surface that only lists what *is*
  // advertised. An owner adds a second `llm.generate`, their team's jobs stop
  // matching, and nothing anywhere says why. So it is listed here, by name,
  // with the fix.
  for (const held of loaded.withheld) {
    io.out(
      `  … ${held.kind.padEnd(14)} no default — ${String(held.services.length)} services ` +
        `answer it (${held.services.join(", ")})\n` +
        `      a job naming one of them runs; a job naming none has nowhere ` +
        `to go\n` +
        `      set defaults.${held.kind} in ~/.byollm/config.json\n`,
    );
  }
  for (const problem of loaded.problems) {
    io.out(`  ! ${problem.where}: ${problem.message}\n`);
  }

  /**
   * Who can use this device — and the honest admission that this device does
   * not know.
   *
   * It used to print a list, because it held one: first a per-person
   * allowlist, then a signed roster. Amendment J removed both. Membership now
   * arrives one grant at a time, at claim, so there is no moment at which
   * this device is told the set — and a status surface declares whose
   * knowledge it shows.
   *
   * Saying so is the point rather than an apology. A screen that quietly
   * stopped listing people would read as "nobody", which is the flattering
   * lie in the sentence about who may use somebody's computer.
   */
  io.out("\nwho can use this device\n");
  io.out("  you, always\n");
  const paired = pairings.list();
  if (paired.length === 0) {
    io.out("  nobody else — this device is not paired with anything\n");
  }
  for (const pairing of paired) {
    if (pairing.controlPlanePublic === undefined) {
      // Direct mode, and the reason is worth one line: there is no control
      // plane here, so nothing could ever sign a statement that a stranger
      // may use this machine. Owner-only is not a setting somebody forgot to
      // change (ruled 2026-08-26).
      io.out(
        `  nobody else, through ${pairing.origin} — it has no control plane, ` +
          `so nothing\n   can tell this device who anybody else is\n`,
      );
      continue;
    }
    io.out(
      `  whoever ${pairing.origin} admits, one job at a time\n` +
        `   (this device is not told the list — it checks a signature per ` +
        `job.\n    Manage who is on it from your team page.)\n`,
    );
  }

  /*
   * A ledger that could not be read, named — byollm_016, 2026-09-03.
   *
   * The brakes below go on by themselves when the bookkeeping is
   * unreadable, and a brake nobody can explain is indistinguishable from a
   * broken daemon: the machine simply stops taking community work and every
   * number on this screen says it should be taking it. The file is named,
   * never quoted — it is a record of what this machine did for other people,
   * and that does not belong in a screenshot or a support thread.
   */
  const grantsBlocked = spentGrants.blockedReason(now);
  const untrusted = [
    ["community work", budgets.untrustedReason()],
    ["metered spend", spend.untrustedReason()],
    ["used grants", grantsBlocked],
  ].filter((row): row is [string, string] => row[1] !== undefined);
  if (untrusted.length > 0) {
    io.out("\nbookkeeping this device cannot read\n");
    for (const [what, why] of untrusted) {
      io.out(`  ${what}: ${why}\n`);
    }
    /*
     * Two different brakes, two different sentences — CW's rolling review.
     *
     * The first draft said "your own work is unaffected" for whatever was
     * unreadable, which is true of the two ledgers that count what this
     * machine did for other people and false of the third. The used-grants
     * record guards the wire: while it is unreadable this device refuses
     * every relayed job, the owner's own site work included, because a
     * duplicate of your own metered job is still your money.
     *
     * Saying the reassuring one over the strict one would have somebody
     * reading "your own work is unaffected" on the exact screen explaining
     * why their own work had stopped.
     */
    if (grantsBlocked === undefined) {
      io.out(
        "  it is refusing work for other people until this is fixed. Your " +
          "own work is unaffected.\n",
      );
    } else {
      io.out(
        "  it is refusing every job that arrives through a site, including " +
          "your own, until this is fixed.\n" +
          "  that lasts about two minutes from the last start — long enough " +
          "that nothing it forgot could still be replayed.\n",
      );
    }
    io.out("  move the named file aside and this clears on the next start.\n");
  }

  const spentToday = spend.summary(now);
  const metered = loaded.routes.filter((r) => r.cost === "metered");
  if (metered.length > 0) {
    io.out("\nmetered services — your money\n");
    for (const route of metered) {
      const spent = spentToday[route.service] ?? 0;
      io.out(
        route.spendAcknowledged
          ? `  ${route.service}: ${dollars(spent)} spent today of ` +
              `${dollars(route.spendDailyCapCents ?? 0)}\n`
          : `  ${route.service}: not shared — your work only\n`,
      );
    }
  }

  const usage = budgets.usage(now);
  io.out("\ncommunity work done for others\n");
  io.out(
    `  ${String(usage.hour)} in the last hour (cap ${String(usage.limits.maxJobsPerHour)}), ` +
      `${String(usage.day)} today (cap ${String(usage.limits.maxJobsPerDay)})\n`,
  );

  const entries = await ingress.read();
  const prompts = entries.filter((entry) => entry.type === "prompt");
  const outcomes = entries.filter((entry) => entry.type === "outcome");
  io.out("\nthis device has run\n");
  io.out(
    `  ${String(prompts.length)} prompts, ` +
      `${String(outcomes.filter((o) => o.outcome === "ok").length)} ok, ` +
      `${String(outcomes.filter((o) => o.outcome === "error").length)} failed, ` +
      `${String(outcomes.filter((o) => o.outcome === "refused").length)} refused\n`,
  );
  io.out(
    `  full log: ${paths.ingressLog}\n` +
      `  other people's prompts are kept ` +
      `${String(loaded.config.ingress.communityPromptDays)} days, then hashed\n`,
  );
  return 0;
}

// -- log ---------------------------------------------------------------------

async function commandLog(
  paths: DaemonPaths,
  args: readonly string[],
  io: CliIo,
): Promise<ExitCode> {
  const full = args.includes("--full");
  const nIndex = args.findIndex((arg) => arg === "-n" || arg === "--lines");
  const limit =
    nIndex === -1 ? 20 : Math.max(1, Number(args[nIndex + 1] ?? "20") || 20);

  const { ingress } = await context(paths);
  const entries = await ingress.read();
  const shown = entries.slice(-limit);

  if (shown.length === 0) {
    io.out("nothing has run on this device yet\n");
    return 0;
  }

  for (const entry of shown) {
    const at = new Date(entry.at).toISOString().replace("T", " ").slice(0, 19);
    if (entry.type === "outcome") {
      io.out(
        `${at}  ${entry.outcome.padEnd(8)} ${entry.jobId}` +
          (entry.durationMs === undefined
            ? ""
            : ` ${String(entry.durationMs)}ms`) +
          `${entry.detail === undefined ? "" : `  ${stripControlChars(entry.detail)}`}\n`,
      );
      continue;
    }

    io.out(
      `${at}  ${entry.audience.padEnd(7)} ${entry.kind} ` +
        `via ${entry.backendId}:${entry.model}  for ${entry.owner} ` +
        `@ ${new URL(entry.origin).host}\n`,
    );
    if (entry.prompt === undefined) {
      // Retention removed the text. Say so — a blank line here would read as
      // "empty prompt", and zero must never look like unknown.
      io.out(
        `           prompt not retained (${String(entry.promptChars)} chars, ` +
          `sha256 ${entry.promptHash.slice(0, 16)}…)\n`,
      );
    } else if (full) {
      io.out(`${indent(stripControlChars(entry.prompt))}\n`);
    } else {
      const firstLine = entry.prompt.split("\n")[0] ?? "";
      io.out(
        `           ${stripControlChars(firstLine.slice(0, 90))}` +
          `${entry.prompt.length > 90 ? "…" : ""}\n`,
      );
    }
  }
  if (!full) {
    io.out(`\n(${String(entries.length)} entries; --full for whole prompts)\n`);
  }
  return 0;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `           ${line}`)
    .join("\n");
}

// -- allow / disallow (tombstones) --------------------------------------------

/**
 * Two commands that no longer exist, and why they will not be coming back.
 *
 * `byollm allow <site> <user>` kept a device-local list of people permitted
 * to run work here; `byollm disallow` removed one. Both were deleted on
 * 2026-08-26 (byollm_016 Amendments I and J).
 *
 * The reason is not simplification. **The user-granularity was illusory.** A
 * daemon cannot verify a foreign site's user identities, so an entry admitted
 * whatever that site asserted per job about who its user was — which is
 * precisely the unsigned per-job assertion Amendment G property 1 outlawed
 * for the cloud route, wearing an allowlist costume. Against a dishonest site
 * it gated nothing; against an honest one it second-guessed the only party
 * that owns the namespace.
 *
 * The git analogy that settled it: no git client keeps a local list of
 * permitted GitHub users. Who may push is GitHub's decision, made in
 * GitHub's namespace, enforced where the namespace lives. Blocking exists —
 * and you do it at GitHub.
 *
 * A tombstone rather than "unknown command", because somebody's fingers still
 * know these and an unknown-command error would send them to look for a typo.
 * It names where the capability went, which is the whole obligation of a
 * refusal.
 */
function commandRetiredAdmission(name: "allow" | "disallow", io: CliIo): 2 {
  io.err(
    `${wrap(
      `\`byollm ${name}\` is gone. This device no longer keeps its own list ` +
        `of who may use it — it could never check the names on that list, ` +
        `so the list only ever agreed with whoever was asking.`,
    )}\n\n` +
      `${wrap(
        `Membership lives with your relay now, and reaches this device one ` +
          `signed grant at a time. Add or remove people from your team page.`,
      )}\n\n` +
      `${wrap(
        `A device with no relay serves its owner and nobody else, which is ` +
          `what \`byollm status\` will tell you.`,
      )}\n`,
  );
  return 2;
}

// -- offer -------------------------------------------------------------------

/**
 * Cents, as money — one place, because three surfaces print this number.
 *
 * The consent ceremony said "$25.00 a day" and the `services` row said
 * "2500c/day" for the same ceiling, which made a person check whether they
 * were looking at the same figure. Surfaces sharing a value share its unit,
 * and the unit is the one the money is in.
 */
function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * What a service's offer scope actually amounts to on this machine.
 *
 * **A request is not a state** (ruled 2026-08-26). Three things can narrow an
 * owner's request and each of them used to be invisible on the screen built
 * to show it: a subscription's terms, an unacknowledged spend, and — new with
 * Amendment J — having no relay to admit anybody.
 *
 * The third is the one worth spelling out. `team` means "whoever my relay
 * admits", and a device paired with nothing has no relay and therefore admits
 * nobody. That is not a bug to be fixed by widening; it is what direct mode
 * *is*, since nothing there could sign a statement about who a stranger is.
 * But a device printing "team" while serving one person is lying, so it says
 * both: what took effect, and what was asked for.
 */
function offerSummary(input: {
  readonly effective: "private" | "team";
  readonly configured: "private" | "team" | undefined;
  readonly hasRelay: boolean;
}): {
  /** The config's own word, so the two surfaces agree with the file. */
  readonly scope: "private" | "team";
  /** What that word means for a reader who does not know the vocabulary. */
  readonly audience: string;
  /** Why it is not what was asked for, when it is not. */
  readonly narrowedBy: string | undefined;
} {
  const { effective, configured, hasRelay } = input;
  if (effective === "team" && !hasRelay) {
    return {
      scope: "private",
      audience: "only you",
      narrowedBy:
        "no relay paired, so nothing here can admit anybody — " +
        "`byollm connect <relay>` to share it",
    };
  }
  if (effective === "private") {
    return {
      scope: "private",
      audience: "only you",
      narrowedBy:
        configured !== undefined && configured !== "private"
          ? `narrowed from ${configured} — see ! below`
          : undefined,
    };
  }
  return {
    scope: "team",
    audience: "you and the people your relay admits",
    narrowedBy: undefined,
  };
}

/**
 * Change who a backend is offered to.
 *
 * This exists because `resolveConfig` tells an owner to run it. A message that
 * names a command nobody wrote is worse than no message: it reads as though
 * the software has an answer when it does not.
 *
 * Widening a metered backend is the one path here that can cost real money, so
 * it is the one path that asks — and the question names the money rather than
 * asking whether the owner is "sure"
 * ({@link MUSTS.METERED_DEFAULTS_SELF}, {@link MUSTS.METERED_REQUIRES_CEILING}).
 */
async function commandOffer(
  paths: DaemonPaths,
  args: readonly string[],
  io: CliIo,
): Promise<ExitCode> {
  const [serviceKey, scope, ...rest] = args;
  if (serviceKey === undefined || scope === undefined) {
    io.err("usage: byollm offer <service> <private|team> [--cap <cents>]\n");
    return 2;
  }
  if (scope === "public") {
    /**
     * A tombstone, not a typo — refusals split by remedy.
     *
     * `public` was a real scope until 2026-08-26 and somebody's fingers still
     * know it, so it gets its own answer rather than being lumped in with a
     * misspelling. The reason is worth saying because it is the whole point
     * of removing it: `matchAudience` returned ALLOWED for a public service
     * **without consulting this device at all**, so the value was an off
     * switch for admission. Every scope that remains asks a question.
     */
    io.err(
      `${wrap(
        `\`public\` is gone. A service is offered to you alone, or to the ` +
          `people your relay admits — there is no longer a scope that runs a ` +
          `stranger's job without this device checking who they are.`,
      )}\n\n` +
        `\`byollm offer ${serviceKey} team\` shares it with your team.\n`,
    );
    return 2;
  }
  if (scope !== "private" && scope !== "team") {
    // `self, named` were the pre-alpha.44 words, and they survived inside a
    // string where the rename could not see them — the reason error text now
    // joins the one-vocabulary lint.
    io.err(`"${scope}" is not an offer scope — use private or team\n`);
    return 2;
  }

  const capIndex = rest.indexOf("--cap");
  let capCents: number | undefined;
  if (capIndex !== -1) {
    const raw = rest[capIndex + 1];
    const parsed = Number(raw);
    if (raw === undefined || !Number.isFinite(parsed) || parsed <= 0) {
      io.err("--cap takes a number of cents per day, greater than zero\n");
      return 2;
    }
    capCents = Math.round(parsed);
  }

  let raw: string;
  try {
    raw = await readFile(paths.config, "utf8");
  } catch {
    io.err(
      `no config at ${paths.config} — nothing to offer yet.\n` +
        "Write one, or run `byollm connect <url>` first.\n",
    );
    return 1;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    io.err(`${paths.config} is not valid JSON — fix it by hand first\n`);
    return 1;
  }
  const result = DaemonConfig.safeParse(parsed);
  if (!result.success) {
    io.err(`${paths.config} is not a valid byollm config — fix it first\n`);
    return 1;
  }

  const service = result.data.services[serviceKey];
  if (!service) {
    const known = Object.keys(result.data.services);
    io.err(
      `no service named "${serviceKey}" in ${paths.config}\n` +
        (known.length > 0 ? `configured: ${known.join(", ")}\n` : ""),
    );
    return 2;
  }

  const descriptor = backendDescriptor(service.type);
  const baseUrl = service.baseUrl ?? descriptor.defaultBaseUrl;
  // **With the model.** `resolveCost` reads three things and this call passed
  // two, so it and `resolveConfig` answered differently about the same
  // service — the shape this codebase keeps deleting, arriving in a signature.
  //
  // What it cost: `glm-5.2:cloud` on `http://127.0.0.1:11434/v1` is metered,
  // because the `:cloud` tag means the work leaves the machine whatever the
  // address says. Without the model this saw a loopback URL, called it free,
  // required no consent, and wrote `offer: "team"` with no spend block. The
  // command then reported success truthfully — and the daemon, reading the
  // same service *with* the model, narrowed it straight back and told the
  // owner to run the command they had just run.
  // One decision, two views: `classifyCost` answers what it costs *and* why,
  // so a consent sentence can never describe a classification the code did
  // not make.
  const reason = classifyCost(service.type, baseUrl, service.model);
  const cost = reason.cost;
  const widening = scope !== "private";

  /**
   * The fundamental refusal runs first — ruled 2026-08-25.
   *
   * This check used to sit below the `--cap` one, and the ordering told
   * somebody the wrong thing twice. `byollm offer my-claude team --cap 2500`
   * answered "sharing it costs you nothing. Drop --cap" — advice whose whole
   * premise is that sharing is possible. Follow it, re-run, and only then
   * learn the service cannot be offered at all.
   *
   * A fixable detail must never precede an unfixable fact. The ceiling is a
   * flag somebody can drop; a subscription's terms are not a thing they can
   * negotiate, and a message that leads with the flag has buried the answer
   * behind an errand.
   *
   * Named by the service, not by the registry label. The label belongs in the
   * sentence — a subscription's cost *is* the registry's word — but the
   * subject is what the owner typed. "Claude CLI (your subscription) runs on
   * your own subscription" both stuttered and answered a question about a
   * service the owner never named.
   */
  if (cost === "subscription" && widening) {
    io.err(
      `${wrap(
        `${serviceKey} runs on ${backendName(service.type)}, a subscription ` +
          `whose terms cover your work and nobody else's. It cannot be ` +
          `offered to other people.`,
      )}\n`,
    );
    return 1;
  }

  /**
   * **A flag this path will not use is an error, not a shrug.**
   *
   * `--cap` was parsed, validated, and then reached only the metered branch.
   * Ask to share a service this command believes is free and the ceiling
   * vanished silently — which is exactly what happened when the cost
   * calculation disagreed with the daemon's: the owner passed a ceiling, was
   * told the share succeeded, and got neither.
   *
   * Refusing costs one message and removes a class where a command accepts an
   * instruction it has no intention of following.
   *
   * **No class names.** This said "my-ollama is free-class" and "my-claude is
   * subscription-class", which is this codebase's vocabulary on somebody
   * else's screen — nobody's mental model has classes in it. A refusal says
   * what the class *means*: it runs on this machine, or it is not being
   * shared.
   *
   * And it ends with the command to run, because an error message is
   * documentation that arrives at the moment somebody needs it. "Drop --cap"
   * describes an edit; the line under it can be pasted.
   */
  if (capCents !== undefined && !(cost === "metered" && widening)) {
    const because =
      cost === "metered"
        ? "is not being shared, so nothing would spend against it"
        : "runs on this machine, so sharing it costs you nothing";
    io.err(
      `${wrap(`--cap sets a daily spend ceiling, and ${serviceKey} ${because}.`)}\n` +
        `Drop --cap: \`byollm offer ${serviceKey} ${scope}\`\n`,
    );
    return 2;
  }

  if (cost === "metered" && widening) {
    const cap = capCents ?? service.spend?.dailyCapCents;
    if (cap === undefined) {
      io.err(
        `${descriptor.label} bills you per token, so sharing it needs a daily\n` +
          "ceiling. Add one: `byollm offer " +
          `${serviceKey} ${scope} --cap <cents>\`\n`,
      );
      return 2;
    }

    const dollars = (cap / 100).toFixed(2);
    // **Consent names the thing consented to, and the reason it is true.**
    //
    // This read "This lets other people's jobs run on Any OpenAI-compatible
    // server, which bills your account per token" — wrong twice. The registry
    // label is the *type*, not the service somebody is about to share; and
    // the type does not bill per token, since an owner's local qwen is the
    // same type and costs only electricity. So the sentence named the wrong
    // object and gave a reason its reader could check and find false.
    //
    // A label may classify. It may not be the object of consent.
    const where = service.baseUrl ?? descriptor.defaultBaseUrl;
    const confirmed = await io.confirm(
      `\nThis lets other people's jobs run on ${serviceKey}:\n` +
        `  ${service.model}${where === undefined ? "" : ` at ${where}`}\n\n` +
        // Wrapped, because the reason is assembled from a rule and cannot be
        // hard-wrapped where it is written. An unwrapped consent sentence runs
        // to 150 columns in a terminal, and a wrapped-by-the-terminal sentence
        // is one somebody skims.
        `${wrap(`It bills your account per token because ${reason.because}.`)}\n\n` +
        `${wrap(`You would be paying for their work, up to $${dollars} a day, every day, until you change it. Spending stops at that ceiling and resumes the next day.`)}\n\n` +
        `Offer ${serviceKey} to your team?`,
    );
    if (!confirmed) {
      io.out("nothing changed\n");
      return 0;
    }

    result.data.services[serviceKey] = {
      ...service,
      offer: scope,
      spend: {
        centsPerMillionTokens: service.spend?.centsPerMillionTokens ?? 1500,
        ...service.spend,
        acknowledged: true,
        dailyCapCents: cap,
      },
    };
  } else {
    result.data.services[serviceKey] = {
      ...service,
      offer: scope,
      // Narrowing back to `self` withdraws the consent too, so a later
      // widening has to be agreed to again rather than inherited.
      ...(cost === "metered" && !widening && service.spend !== undefined
        ? { spend: { ...service.spend, acknowledged: false } }
        : {}),
    };
  }

  await mkdir(dirname(paths.config), { recursive: true });
  await writeFile(paths.config, `${JSON.stringify(result.data, null, 2)}\n`);

  const written = result.data.services[serviceKey].spend?.dailyCapCents;
  io.out(
    `${serviceKey} is now offered to ${scope}` +
      (written === undefined || !widening
        ? ""
        : `, capped at ${dollars(written)} a day`) +
      "\n",
  );
  return 0;
}

// -- forget -------------------------------------------------------------------

async function commandForget(
  paths: DaemonPaths,
  args: readonly string[],
  io: CliIo,
): Promise<ExitCode> {
  const target = args[0];
  if (target === undefined) {
    io.err("usage: byollm forget <app-url>\n");
    return 2;
  }
  const pairings = new Pairings(paths.pairings);
  await pairings.load();
  reportSkipped(pairings, io);
  const removed = await pairings.remove(normalizeOrigin(target));
  io.out(
    removed
      ? `forgot ${normalizeOrigin(target)} — the app may still list this runner ` +
          `until you revoke it there too\n`
      : `not paired with ${normalizeOrigin(target)}\n`,
  );
  return 0;
}

// -- sites / approve ---------------------------------------------------------

/**
 * Which sites this machine serves, which are waiting on an answer, and which
 * it has served before — V1-1.
 *
 * The pinned fingerprints were already in `byollm status`; what was missing
 * was the *question*. A site the upstream added arrives on a heartbeat, and
 * before V1-1 it was simply pinned — so the one screen where somebody could
 * have compared a fingerprint never existed. This is that screen.
 */
async function commandSites(paths: DaemonPaths, io: CliIo): Promise<ExitCode> {
  const pairings = new Pairings(paths.pairings);
  await pairings.load();
  reportSkipped(pairings, io);

  const list = pairings.list();
  if (list.length === 0) {
    io.out("not paired with anything — run `byollm connect`\n");
    return 0;
  }

  /**
   * What this device serves, and what it still holds a key for.
   *
   * The waiting queue is gone with `byollm approve` (Amendment K) — there is
   * nothing here to answer any more, so this reports rather than asks.
   *
   * The pinned-but-not-offered rows stay, and they matter more now than they
   * did. A key kept for a site nobody is mentioning is exactly what somebody
   * should be able to see they are still holding, and with site policy moved
   * to the account it is the only place that list is visible on the machine.
   */
  for (const pairing of list) {
    io.out(`${pairing.origin}\n`);
    const served = Object.entries(pairing.sites);
    if (served.length === 0) io.out("  (serving nothing right now)\n");
    for (const [, site] of served) {
      io.out(`  serving  ${fingerprint(site.identity)}\n`);
    }
    for (const id of Object.keys(pairing.known ?? {})) {
      if (id in pairing.sites) continue;
      io.out(`  pinned   ${id} (not offered right now)\n`);
    }
  }
  return 0;
}

/**
 * `byollm approve`, retired — byollm_016 Amendment K.
 *
 * The device no longer decides which sites it serves. That is the largest
 * single reduction in device-side control in this design and it is
 * deliberate: site policy moves at account speed, where the person changing
 * it is signed in and can see what they are changing.
 *
 * What the machine kept is the pairing ceremony — where a human compares a
 * fingerprint — the pinning that refuses a key moving under an id, and the
 * grant check that refuses work no control plane signed for. What it gave up
 * is the per-site yes.
 *
 * The tombstone says so plainly rather than pointing at a replacement
 * command, because there is no replacement on this machine. It names the
 * levers that remain, since a refusal with nothing to do about it is noise.
 */
function commandRetiredApprove(io: CliIo): 2 {
  io.err(
    `${wrap(
      "`byollm approve` is gone. Which sites this device serves is decided " +
        "in your dashboard now, not here — and the first job from a new one " +
        "says so in `byollm run`, with its fingerprint.",
    )}\n\n` +
      `${wrap(
        "This device still refuses work no grant was signed for, still " +
          "refuses a site key that changes under an id it pinned, and still " +
          "stops entirely on `byollm stop`.",
      )}\n`,
  );
  return 2;
}

// -- backends ------------------------------------------------------------------

async function commandServices(
  paths: DaemonPaths,
  io: CliIo,
  service: ServiceIo,
): Promise<ExitCode> {
  /**
   * A fresh machine gets a next step, not an error — byollm_020.
   *
   * `services` is the only list now, and on a machine with no config it used
   * to fall through to a config read that fails. The command it replaced said
   * "run `byollm setup`", which is the one useful thing to say to somebody
   * who has just installed this and typed the obvious command. Losing that
   * sentence in a rename would be the rename costing a first impression.
   */
  const { loaded, ingress, budgets, spend, spentGrants } = await context(paths);
  const pairings = new Pairings(paths.pairings);
  await pairings.load();
  const hasRelay = pairings
    .list()
    .some((pairing) => pairing.controlPlanePublic !== undefined);
  const runner = new Runner({
    client: new ProtocolClient({ origin: "https://unused.invalid" }),
    runnerId: "local",
    owner: "local",
    daemonVersion: DAEMON_VERSION,
    loaded,
    budgets,
    spend,
    spentGrants,
    ingress,
  });

  const advertised = await runner.detectCapabilities();
  const advertisedKinds = new Set(advertised.map((c) => c.kind));

  io.out("services\n");
  for (const route of loaded.routes) {
    const ok = advertisedKinds.has(route.kind);
    const pays =
      route.cost === "free"
        ? "free (your electricity)"
        : route.cost === "subscription"
          ? "your subscription — locked to your work"
          : route.spendAcknowledged
            ? `metered — ${route.offerScope}, cap ${dollars(route.spendDailyCapCents ?? 0)}/day`
            : "metered — your money, not shared";
    /**
     * Who it is offered to — which this command did not say at all.
     *
     * It printed the kind, the service, the backend, the model, the address
     * and who pays, and left out the one fact somebody runs `byollm services`
     * to check. Found on 2026-08-26 when the question "is anything on this
     * machine offered publicly?" had to be answered by reading config.json:
     * the surface built to answer it could not, and the surface that could
     * was the file the daemon does not necessarily agree with.
     *
     * Effective, therefore, not configured — for the reason `status` carries
     * the same note. A `team` request that the spend rules narrowed to
     * `private` is a service shared with nobody, and printing the request
     * would be reporting an intention as a state.
     */
    const summary = offerSummary({
      effective: route.offerScope,
      configured: loaded.config.services[route.service]?.offer,
      hasRelay,
    });
    const offered =
      `offered to ${summary.audience}` +
      (summary.narrowedBy === undefined ? "" : ` (${summary.narrowedBy})`);
    io.out(
      `  ${ok ? "✓" : "✗"} ${route.kind.padEnd(14)} ` +
        `${route.service} — ${route.backendId}:${route.model}` +
        `${route.baseUrl === undefined ? "" : ` @ ${route.baseUrl}`}\n` +
        `      ${pays}\n` +
        `      ${offered}\n`,
    );
    // Why, and what to do about it — cloud_002's detection-first ruling.
    // "0 of 2 routes are healthy" is a true sentence that leaves the reader
    // exactly as stuck as before it was printed.
    if (!ok) {
      const hint = await diagnoseRoute({ baseUrl: route.baseUrl });
      if (hint !== undefined) io.out(`      ${hint}\n`);
    }
  }
  // **Withheld is shown, never merely absent** — the same obligation `status`
  // carries, in the command an owner runs when they are asking exactly this
  // question.
  for (const held of loaded.withheld) {
    io.out(
      `  … ${held.kind.padEnd(14)} no default — ${String(held.services.length)} services ` +
        `answer it (${held.services.join(", ")})\n` +
        `      a job naming one of them runs; a job naming none has nowhere ` +
        `to go\n` +
        `      set defaults.${held.kind} in ~/.byollm/config.json\n`,
    );
  }
  for (const problem of loaded.problems) {
    io.out(`  ! ${problem.where}: ${problem.message}\n`);
  }
  // What the build cannot do yet, said where the owner is looking.
  for (const notice of loaded.notices) {
    io.out(`  i ${notice}\n`);
  }
  // **This command speaks for the shell it runs in, not for the daemon.**
  //
  // It used to say "healthy and will be advertised", which is a promise only
  // the daemon can make — and on the machine that produced this change, it was
  // false. The daemon runs under launchd with launchd's own PATH; `claude`
  // lives in `~/.local/bin`; so a probe here found the CLI, reported it
  // healthy, and the daemon could not execute it. The device advertised
  // nothing, and the surface a person turns to for "why" was the one lying.
  //
  // PATH was that machine's divergence and the installer now captures it, but
  // it is one source among many: a different user, a different HOME, a
  // credential visible in a login shell and not to a background agent. So the
  // wording no longer claims to know what the daemon sees. Saying less is the
  // fix; claiming to speak for a process you are not is the bug.
  // From the daemon's own paths, never `homedir()`. The first version read
  // the real home while the rest of this command read `paths` — so under a
  // test, or anywhere `BYOLLM_HOME` differs, it answered about a different
  // machine's state than the one it was describing. Caught by the control
  // asserting the warning is *absent* when nothing is installed, which is the
  // half of the pair that is easy not to write.
  // Built from the same target `install` uses, so the two agree about where
  // the unit lives. The first version called `serviceIsInstalled(homedir())`,
  // which read the real home while the rest of this command read `paths` — it
  // answered about a different machine's state than the one it was
  // describing, and would have done so anywhere `BYOLLM_HOME` differs. Caught
  // by the control asserting the warning is *absent* when nothing is
  // installed, which is the half of that pair that is easy not to write.
  const installed = await serviceIsInstalled(serviceTarget(paths, service));
  io.out(
    `\n${String(advertised.length)} of ${String(loaded.routes.length)} services are ` +
      `healthy from this shell.\n` +
      (loaded.withheld.length > 0
        ? `${String(loaded.withheld.length)} kind(s) are withheld until you pick a default.\n`
        : "") +
      `A route that is not healthy is never offered to an app — the daemon does\n` +
      `not advertise what it cannot actually run.\n` +
      (installed
        ? `\nThis is your shell's view. The daemon runs under a service manager\n` +
          `with its own environment, so what it can reach may differ. Compare\n` +
          `with the device's page, and after installing a new CLI run\n` +
          `\`byollm uninstall && byollm install\` so the service picks up your PATH.\n`
        : ""),
  );
  return advertised.length === 0 ? 1 : 0;
}

// -- shared -------------------------------------------------------------------

async function context(paths: DaemonPaths): Promise<{
  loaded: Awaited<ReturnType<typeof loadConfig>>;
  ingress: IngressLog;
  budgets: Budgets;
  spend: SpendLedger;
  spentGrants: SpentGrants;
}> {
  const loaded = await loadConfig(paths.config);
  const ingress = new IngressLog({
    path: paths.ingressLog,
    communityPromptDays: loaded.config.ingress.communityPromptDays,
    keepSelfPrompts: loaded.config.ingress.keepSelfPrompts,
  });
  const budgets = new Budgets(paths.budgets, loaded.config.community);
  await budgets.load(Date.now());
  const spend = new SpendLedger(paths.spend);
  // Loaded before the loop starts, so a restart inside a grant's freshness
  // window still knows what it already ran.
  const spentGrants = new SpentGrants(paths.spentGrants);
  spentGrants.load(Date.now());
  await spend.load(Date.now());
  return { loaded, ingress, budgets, spend, spentGrants };
}

/**
 * Ask, on a real terminal.
 *
 * Refuses outright when stdin is not a TTY: widening who may use someone's
 * machine is not a thing to do on an implied yes from a script.
 */
async function confirmInteractively(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "refusing to widen access without an interactive confirmation\n",
    );
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * How this machine appears in the app's runner list.
 *
 * `BYOLLM_LABEL` overrides it, because "todd@Todds-MacBook-Pro" is more than
 * some people want to hand an app they are only trying out.
 */

/**
 * Wrap prose to a width a terminal will not re-wrap for us.
 *
 * Sentences assembled from a rule cannot be hard-wrapped where they are
 * written, and an unwrapped consent runs past 150 columns — where the terminal
 * breaks it mid-word and the reader skims. Consent that is not read is not
 * consent.
 */
function wrap(text: string, width = 68): string {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line === "") line = word;
    else if (`${line} ${word}`.length <= width) line = `${line} ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line !== "") out.push(line);
  return out.join("\n");
}

function hostLabel(): string {
  const override = process.env["BYOLLM_LABEL"];
  if (override !== undefined && override !== "") return override.slice(0, 120);
  try {
    return `${userInfo().username}@${hostname()}`.slice(0, 120);
  } catch {
    return hostname().slice(0, 120);
  }
}

/** The `byollm` executable. */
export async function main(argv: readonly string[]): Promise<ExitCode> {
  try {
    return await runCli(argv);
  } catch (error) {
    /**
     * A mistyped address is a usage error, and it is answered here rather
     * than at each command that takes one.
     *
     * Centrally on purpose. The per-command version of this is a list that
     * has to be extended every time a command learns to take an address, and
     * a list like that does not grow when the code does — which is the exact
     * shape of the check that failed to catch the stop-ship this refusal
     * exists because of. Every caller of `normalizeOrigin` lands here for
     * free, including ones written after this comment.
     */
    if (error instanceof UnusableOrigin) {
      process.stderr.write(
        `${
          error.input.trim() === ""
            ? "That is not a usable address"
            : `"${stripControlChars(error.input)}" is not a usable address`
        }: ${error.reason}.\n` +
          `Addresses look like https://app.example.com or localhost:8080.\n`,
      );
      return 2;
    }
    process.stderr.write(
      `${error instanceof ClientError || error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

/** Whether a path is there at all — the fallback leaves no other trace. */
async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
