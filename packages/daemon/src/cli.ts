import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { FAILURES_BEFORE_ALARM, readHealth } from "./health.js";
import { runSetup, terminalIo } from "./setup.js";
import { backendDescriptor, backendName, classifyCost } from "@byollm/protocol";
import { Allowlist, normalizeOrigin } from "./allowlist.js";
import { Budgets } from "./budgets.js";
import { ClientError, ProtocolClient } from "./client.js";
import { diagnoseRoute } from "./diagnose.js";
import { DaemonConfig, loadConfig } from "./config.js";
import { connect } from "./connect.js";
import { IngressLog, stripControlChars } from "./ingress.js";
import { fingerprint } from "@byollm/protocol";
import { DeviceIdentity } from "./identity.js";
import { Pairings, recordSites } from "./pairings.js";
import { SpendLedger } from "./spend.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import { Runner, type RunnerEvent } from "./runner.js";
import {
  installService,
  serviceState,
  spawnCommand,
  uninstallService,
  type CommandRunner,
} from "./install.js";
import {
  serviceIsInstalled,
  servicePlan,
  type ServicePlatform,
  type ServiceTarget,
} from "./service.js";
import { DAEMON_VERSION, formatVersion } from "./index.js";

const USAGE = `byollm — run an app's LLM jobs on your own models.

  byollm setup                answer three questions instead of editing JSON
  byollm connect [<url>]      pair with an app and start running its jobs
  byollm name [<name>]        what this device calls itself when it pairs
  byollm run [url]            run jobs for a paired app (or all of them)
  byollm status               what is connected, what is running, what it cost
  byollm log [--full] [-n N]  every prompt that has run on this device
  byollm pause                stop claiming new work
  byollm resume               start claiming again
  byollm allow <url> <user>   let someone else's jobs run here (named audience)
  byollm allow --list         who can currently use this device
  byollm offer <backend> <scope>  who a backend is offered to (self|named|public)
  byollm disallow <url> <user>
  byollm sites                which sites this device serves, and which are waiting
  byollm approve <site>       serve a site that asked (or --all)
  byollm forget <url>         drop a pairing
  byollm services             what is installed, healthy, advertised, withheld
  byollm install              keep running in the background, across restarts
  byollm uninstall            stop running in the background

Config lives in ~/.byollm/config.json. Everything this daemon has ever run is
in ~/.byollm/ingress.log — it is yours to read and yours to delete.
`;

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
      return commandSetup(paths, io);
    case "connect":
      return commandConnect(paths, rest, io, signal);
    case "name":
      return commandName(paths, rest, io);
    case "run":
      return commandRun(paths, rest, io, signal);
    case "status":
      return commandStatus(paths, io, service);
    case "log":
      return commandLog(paths, rest, io);
    case "pause":
      return commandPause(paths, true, io);
    case "resume":
      return commandPause(paths, false, io);
    case "allow":
      return commandAllow(paths, rest, io);
    case "disallow":
      return commandDisallow(paths, rest, io);
    case "offer":
      return commandOffer(paths, rest, io);
    case "sites":
      return commandSites(paths, io);
    case "approve":
      return commandApprove(paths, rest, io);
    case "forget":
      return commandForget(paths, rest, io);
    case "services":
      return commandServices(paths, io, service);
    case "install":
      return commandInstall(paths, io, service);
    case "uninstall":
      return commandUninstall(paths, io, service);
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
  };
}

function serviceTarget(paths: DaemonPaths, service: ServiceIo): ServiceTarget {
  return {
    platform: service.platform,
    execPath: service.execPath,
    scriptPath: service.scriptPath,
    ...(service.home === undefined ? {} : { home: service.home }),
    ...(service.uid === undefined ? {} : { uid: service.uid }),
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
): Promise<ExitCode> {
  const result = await installService(
    serviceTarget(paths, service),
    service.run,
  );
  for (const line of result.lines) (result.ok ? io.out : io.err)(`${line}\n`);
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
  paths: DaemonPaths,
  service: ServiceIo,
): Promise<string> {
  const plan = servicePlan(serviceTarget(paths, service));
  const state = await serviceState(plan, service.run);
  switch (state.state) {
    case "running":
      return `service: running under ${plan.supervisor}\n`;
    case "installed":
      return (
        `service: installed but NOT running (${state.detail}) — ` +
        `this device is on rosters and serving nothing. See ${plan.logPath}\n`
      );
    case "absent":
      return `service: not installed — jobs only run while \`byollm run\` is open (\`byollm install\` fixes that)\n`;
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
async function commandSetup(paths: DaemonPaths, io: CliIo): Promise<ExitCode> {
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
  );
  return result.wrote || result.services.length > 0 ? 0 : 1;
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
  const { loaded, ingress, allowlist, budgets, spend } = await context(paths);

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
    allowlist,
    budgets,
    spend,
    ingress,
  });

  const capabilities = await runner.detectCapabilities();

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
  if (capabilities.length === 0) {
    io.err(
      "\n0 backends are healthy, so nothing will route to this device yet.\n" +
        "Pairing anyway — set a model server up " +
        "(docs.byollm.cloud/guides/models),\nthen check `byollm services`. " +
        "Work starts arriving on its own once one is healthy.\n",
    );
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
         */
        io.out(
          `\n  Your steps:\n` +
            `    1) Open:       ${info.verificationUrl}\n` +
            `    2) Enter code: ${info.userCode}   ` +
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

  io.out(` paired as ${result.pairing.ownerLabel ?? result.pairing.owner}\n`);
  // The keys this machine just pinned, printed where somebody can still
  // compare them. The approval happened in a browser, so this is the first
  // moment the two ends of that decision are visible on the same screen —
  // and a pin nobody can see is a pin nobody checks. Sites that arrive
  // *later* get the same treatment through `byollm sites`, where they wait
  // for an answer rather than being pinned (V1-1).
  for (const [id, site] of Object.entries(result.pairing.sites)) {
    io.out(`   ${id}\n     ${fingerprint(site.identity)}\n`);
  }
  io.out(`\nNow running jobs for ${origin}. Ctrl-C to stop.\n\n`);

  return runLoop(paths, [result.pairing.origin], io, signal);
}

// -- run ---------------------------------------------------------------------

async function commandRun(
  paths: DaemonPaths,
  args: readonly string[],
  io: CliIo,
  signal?: AbortSignal,
): Promise<ExitCode> {
  const pairings = new Pairings(paths.pairings);
  await pairings.load();
  reportSkipped(pairings, io);

  const target = args[0];
  const origins =
    target === undefined
      ? pairings.list().map((pairing) => pairing.origin)
      : [normalizeOrigin(target)];

  if (origins.length === 0) {
    io.err("No apps are paired yet. Run `byollm connect <url>` first.\n");
    return 2;
  }
  return runLoop(paths, origins, io, signal);
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
}

async function runLoop(
  paths: DaemonPaths,
  origins: readonly string[],
  io: CliIo,
  signal?: AbortSignal,
): Promise<ExitCode> {
  const { loaded, ingress, allowlist, budgets, spend } = await context(paths);
  const identity = new DeviceIdentity(paths.keys);
  const pairings = new Pairings(paths.pairings);
  await pairings.load();
  reportSkipped(pairings, io);

  const controller = new AbortController();
  signal?.addEventListener(
    "abort",
    () => {
      controller.abort();
    },
    { once: true },
  );
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
      // Only the long-running daemon records health. The short-lived commands
      // that also build a Runner — `connect`, `services` — would otherwise
      // write a count from one attempt, which says nothing about how the
      // daemon that actually runs is getting on.
      healthPath: paths.health,
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
      allowlist,
      budgets,
      spend,
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
            pending: runner.pending,
          })
            .then(async () => {
              // Then read the file back, because somebody may have answered
              // in another terminal: `byollm approve` cannot call into a
              // running loop, so approval arrives the only way one process
              // can hand something to another here — through the file both
              // of them already share.
              await pairings.load();
              const answered = pairings.get(origin)?.known;
              if (answered) {
                runner.applyApprovals(new Map(Object.entries(answered)));
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
        if (event.type === "revoked") {
          void pairings
            .remove(origin)
            .then(() => {
              io.out(
                `${new URL(origin).host} pairing dropped — ` +
                  "reconnect with `byollm connect`\n",
              );
            })
            .catch((error: unknown) => {
              io.err(
                `could not drop the pairing for ${origin}: ` +
                  `${error instanceof Error ? error.message : "unknown error"}\n`,
              );
            });
        }
      },
    });
    runners.push(runner);
  }

  if (runners.length === 0) return 2;

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
    case "site-awaiting-approval":
      // The one sentence in this log that asks for something. A site nobody
      // here approved is offered no work at all, so the failure it prevents
      // is silent — which is exactly why it has to be said out loud, with the
      // fingerprint the site displays next to it.
      io.out(
        `${at} ${host} site ${event.site} is asking this device to serve ` +
          `it.\n    fingerprint: ${event.fingerprint}\n` +
          `    Compare that against what the site shows you, then run ` +
          `\`byollm approve ${event.site}\`.\n` +
          `    Nothing runs for it until you do.\n`,
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
  const { loaded, ingress, allowlist, budgets, spend } = await context(paths);
  const pairings = new Pairings(paths.pairings);
  await pairings.load();
  reportSkipped(pairings, io);

  const paused = await isPaused(paths);
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
  io.out(
    `state: ${paused ? "PAUSED" : failing ? "NOT REPORTING" : "running"}\n`,
  );
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
  io.out(await supervisionLine(paths, service));
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
  // The two facts a service can have about a kind are now said apart, because
  // "serves nothing right now" and "is not on the menu" are different and no
  // surface said which. Every declared service is selectable by name; the
  // default is only where an *unselected* job goes.
  //
  // There is no separate `defaults` section, and there was one for about an
  // hour. It listed `llm.chat → claude` beside a service line already reading
  // `claude — default for llm.chat`: the same fact twice, which is the
  // criticism that removed `routes` the same afternoon. A display that
  // restates itself is two things to keep in step, and only one of them gets
  // updated.
  const byService = new Map<
    string,
    { defaults: string[]; selectable: string[] }
  >();
  for (const route of loaded.routes) {
    const entry = byService.get(route.service) ?? {
      defaults: [],
      selectable: [],
    };
    (route.isDefault ? entry.defaults : entry.selectable).push(route.kind);
    byService.set(route.service, entry);
  }

  io.out("\nservices\n");
  const declared = Object.entries(loaded.config.services);
  if (declared.length === 0) {
    io.out("  (none configured)\n");
  }
  for (const [name, service] of declared) {
    const entry = byService.get(name) ?? { defaults: [], selectable: [] };
    const route = loaded.routes.find((r) => r.service === name);
    const shown =
      route === undefined
        ? service.model
        : `${route.model}  (${route.backendId})`;
    // "private (only you)" rather than "offered to private" — the config's
    // word, with the consequence beside it, so nobody has to already know
    // what the word means to read the line.
    const scope =
      service.offer === "private"
        ? "private (only you)"
        : service.offer === "team"
          ? "team (you and people you allow)"
          : "public (anyone)";
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
    if (entry.defaults.length > 0) {
      says.push(`default for ${entry.defaults.join(", ")}`);
    }
    if (entry.selectable.length > 0) {
      // Selectable and not the default: a site that names it gets it, a site
      // that names nothing does not. That is a real state and it had no words.
      says.push(`selectable for ${entry.selectable.join(", ")}`);
    }
    io.out(
      `      ${scope} · ${says.length === 0 ? "not offered — see the problems below" : says.join(" · ")}\n`,
    );
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

  const allowed = allowlist.list();
  io.out("\nwho can use this device\n");
  io.out(`  you, always\n`);
  if (allowed.length === 0) {
    io.out("  nobody else\n");
  }
  for (const entry of allowed) {
    io.out(
      `  ${entry.owner} on ${entry.origin}` +
        `${entry.note === undefined ? "" : ` (${stripControlChars(entry.note)})`}\n`,
    );
  }

  const spentToday = spend.summary(now);
  const metered = loaded.routes.filter((r) => r.cost === "metered");
  if (metered.length > 0) {
    io.out("\nmetered services — your money\n");
    for (const route of metered) {
      const spent = spentToday[route.service] ?? 0;
      io.out(
        route.spendAcknowledged
          ? `  ${route.service}: ${spent.toFixed(1)}c spent today of ` +
              `${String(route.spendDailyCapCents ?? 0)}c\n`
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

// -- pause / resume -----------------------------------------------------------

async function commandPause(
  paths: DaemonPaths,
  pause: boolean,
  io: CliIo,
): Promise<ExitCode> {
  await mkdir(paths.root, { recursive: true });
  if (pause) {
    await writeFile(paths.pauseFlag, `${new Date().toISOString()}\n`);
    io.out(
      "paused — no new work will be claimed. `byollm resume` to start again.\n",
    );
  } else {
    await rm(paths.pauseFlag, { force: true });
    io.out("resumed\n");
  }
  return 0;
}

async function isPaused(paths: DaemonPaths): Promise<boolean> {
  try {
    await stat(paths.pauseFlag);
    return true;
  } catch {
    return false;
  }
}

// -- allow / disallow ---------------------------------------------------------

async function commandAllow(
  paths: DaemonPaths,
  args: readonly string[],
  io: CliIo,
): Promise<ExitCode> {
  const allowlist = new Allowlist(paths.allowlist);
  await allowlist.load();

  if (args[0] === "--list" || args.length === 0) {
    const entries = allowlist.list();
    if (entries.length === 0) {
      io.out(
        "Nobody but you can run work on this device.\n" +
          "`byollm allow <app-url> <user-id>` to change that.\n",
      );
      return 0;
    }
    for (const entry of entries) {
      io.out(
        `${entry.owner}  on ${entry.origin}` +
          `${entry.note === undefined ? "" : `  (${stripControlChars(entry.note)})`}\n`,
      );
    }
    return 0;
  }

  const [rawOrigin, owner, ...noteParts] = args;
  if (rawOrigin === undefined || owner === undefined) {
    io.err("usage: byollm allow <app-url> <user-id> [note]\n");
    return 2;
  }
  const origin = normalizeOrigin(rawOrigin);

  // byollm_002: widening scope requires an explicit confirmation that names
  // what it means. Not a y/N on an ambiguous question — the actual sentence.
  const confirmed = await io.confirm(
    `\nThis lets jobs belonging to "${owner}" on ${origin} run on this device,\n` +
      `using your hardware and electricity, whenever your daemon is online.\n` +
      `Your subscription-backed models are never included — those stay yours alone.\n\n` +
      `Allow ${owner} to use this device?`,
  );
  if (!confirmed) {
    io.out("nothing changed\n");
    return 0;
  }

  await allowlist.add(
    {
      origin,
      owner,
      ...(noteParts.length > 0 ? { note: noteParts.join(" ") } : {}),
    },
    Date.now(),
  );
  io.out(`allowed ${owner} on ${origin}\n`);
  return 0;
}

// -- offer -------------------------------------------------------------------

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
    io.err(
      "usage: byollm offer <backend> <self|named|public> [--cap <cents>]\n",
    );
    return 2;
  }
  if (scope !== "private" && scope !== "team" && scope !== "public") {
    // `self, named` are the pre-alpha.44 words, surviving inside a string
    // where the rename could not see them — the second such survivor found in
    // an hour, and the reason error text now joins the one-vocabulary lint.
    io.err(`"${scope}" is not an offer scope — use private, team, or public\n`);
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
        `Offer ${serviceKey} to ${scope === "public" ? "anyone" : "people you have allowed"}?`,
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
        : `, capped at ${String(written)}c a day`) +
      "\n",
  );
  return 0;
}

async function commandDisallow(
  paths: DaemonPaths,
  args: readonly string[],
  io: CliIo,
): Promise<ExitCode> {
  const [rawOrigin, owner] = args;
  if (rawOrigin === undefined || owner === undefined) {
    io.err("usage: byollm disallow <app-url> <user-id>\n");
    return 2;
  }
  const allowlist = new Allowlist(paths.allowlist);
  await allowlist.load();
  const removed = await allowlist.remove(normalizeOrigin(rawOrigin), owner);
  io.out(
    removed
      ? `${owner} can no longer use this device\n`
      : `${owner} was not on the list — nothing changed\n`,
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

  let waiting = 0;
  for (const pairing of list) {
    io.out(`${pairing.origin}\n`);
    const served = Object.entries(pairing.sites);
    if (served.length === 0) io.out("  (serving nothing right now)\n");
    for (const [id, site] of served) {
      io.out(`  serving  ${id}\n           ${fingerprint(site.identity)}\n`);
    }
    for (const [id, site] of Object.entries(pairing.pending ?? {})) {
      waiting += 1;
      io.out(
        `  WAITING  ${id}\n           ${fingerprint(site.identity)}\n` +
          `           compare that with the site, then ` +
          `\`byollm approve ${id}\`\n`,
      );
    }
    // Approved once, not being offered now — consent ended, or the site is
    // quiet. Shown because a key kept for a site nobody mentions is exactly
    // what somebody should be able to see they are still holding.
    for (const id of Object.keys(pairing.known ?? {})) {
      if (id in pairing.sites) continue;
      if (id in (pairing.pending ?? {})) continue;
      io.out(`  approved ${id} (not offered right now)\n`);
    }
  }
  if (waiting > 0) {
    io.out(
      `\n${String(waiting)} site${waiting === 1 ? "" : "s"} waiting. ` +
        "Nothing runs for them until you approve them.\n",
    );
  }
  return 0;
}

/**
 * Say yes to a site that asked — the local half of the trust model.
 *
 * The key that gets pinned is the one this file was shown, not one re-fetched
 * from the upstream: approving is answering the question that was on screen,
 * and a re-fetch would let the answer land on a different question.
 *
 * `--all` exists because a person connecting three sites in a dashboard
 * should not have to type three ids — but it approves what is *currently*
 * waiting and nothing else, so it can never mean "and anything that turns up
 * later".
 */
async function commandApprove(
  paths: DaemonPaths,
  args: readonly string[],
  io: CliIo,
): Promise<ExitCode> {
  const which = args[0];
  if (which === undefined) {
    io.err("usage: byollm approve <site-id> | --all\n");
    return 2;
  }

  const pairings = new Pairings(paths.pairings);
  await pairings.load();
  reportSkipped(pairings, io);

  let approved = 0;
  for (const pairing of pairings.list()) {
    const pending = Object.entries(pairing.pending ?? {});
    const taking = pending.filter(
      ([id, site]) =>
        which === "--all" ||
        id === which ||
        fingerprint(site.identity) === which,
    );
    if (taking.length === 0) continue;

    const known = { ...(pairing.known ?? {}) };
    const takenIds = new Set(taking.map(([id]) => id));
    const rest = Object.fromEntries(
      Object.entries(pairing.pending ?? {}).filter(([id]) => !takenIds.has(id)),
    );
    for (const [id, site] of taking) {
      known[id] = site;
      approved += 1;
      io.out(`approved ${id} for ${pairing.origin}\n`);
      io.out(`  ${fingerprint(site.identity)}\n`);
    }
    // Built without `pending` and then given one back only if anything is
    // still waiting. Spreading the old row and overwriting would leave the
    // approved site listed as waiting forever — the whole row is replaced, so
    // what is not written is what is gone.
    const { pending: _dropped, ...rest_of_pairing } = pairing;
    await pairings.put({
      ...rest_of_pairing,
      known,
      ...(Object.keys(rest).length === 0 ? {} : { pending: rest }),
    });
  }

  if (approved === 0) {
    io.err(
      which === "--all"
        ? "nothing is waiting for approval\n"
        : `nothing waiting matches ${which} — run \`byollm sites\`\n`,
    );
    return 1;
  }
  io.out(
    "A running `byollm run` picks this up on its next heartbeat.\n" +
      "Work for these sites starts then.\n",
  );
  return 0;
}

// -- backends ------------------------------------------------------------------

async function commandServices(
  paths: DaemonPaths,
  io: CliIo,
  service: ServiceIo,
): Promise<ExitCode> {
  const { loaded, ingress, allowlist, budgets, spend } = await context(paths);
  const runner = new Runner({
    client: new ProtocolClient({ origin: "https://unused.invalid" }),
    runnerId: "local",
    owner: "local",
    daemonVersion: DAEMON_VERSION,
    loaded,
    allowlist,
    budgets,
    spend,
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
            ? `metered — shared, cap ${String(route.spendDailyCapCents ?? 0)}c/day`
            : "metered — your money, not shared";
    io.out(
      `  ${ok ? "✓" : "✗"} ${route.kind.padEnd(14)} ` +
        `${route.service} — ${route.backendId}:${route.model}` +
        `${route.baseUrl === undefined ? "" : ` @ ${route.baseUrl}`}\n` +
        `      ${pays}\n`,
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
  allowlist: Allowlist;
  budgets: Budgets;
  spend: SpendLedger;
}> {
  const loaded = await loadConfig(paths.config);
  const ingress = new IngressLog({
    path: paths.ingressLog,
    communityPromptDays: loaded.config.ingress.communityPromptDays,
    keepSelfPrompts: loaded.config.ingress.keepSelfPrompts,
  });
  const allowlist = new Allowlist(paths.allowlist);
  await allowlist.load();
  const budgets = new Budgets(paths.budgets, loaded.config.community);
  await budgets.load(Date.now());
  const spend = new SpendLedger(paths.spend);
  await spend.load(Date.now());
  return { loaded, ingress, allowlist, budgets, spend };
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
    process.stderr.write(
      `${error instanceof ClientError || error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}
