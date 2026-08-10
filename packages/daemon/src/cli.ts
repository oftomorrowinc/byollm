import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { Allowlist, normalizeOrigin } from "./allowlist.js";
import { Budgets } from "./budgets.js";
import { ClientError, ProtocolClient } from "./client.js";
import { loadConfig } from "./config.js";
import { connect } from "./connect.js";
import { IngressLog, stripControlChars } from "./ingress.js";
import { Pairings } from "./pairings.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import { Runner, type RunnerEvent } from "./runner.js";
import { DAEMON_VERSION } from "./index.js";

const USAGE = `byollm — run an app's LLM jobs on your own models.

  byollm connect <url>        pair with an app and start running its jobs
  byollm run [url]            run jobs for a paired app (or all of them)
  byollm status               what is connected, what is running, what it cost
  byollm log [--full] [-n N]  every prompt that has run on this machine
  byollm pause                stop claiming new work
  byollm resume               start claiming again
  byollm allow <url> <user>   let someone else's jobs run here (named audience)
  byollm allow --list         who can currently use this machine
  byollm disallow <url> <user>
  byollm forget <url>         drop a pairing
  byollm backends             what is installed, healthy, and advertised

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
  } = {},
): Promise<ExitCode> {
  const [command, ...rest] = argv;
  const paths = options.paths ?? daemonPaths();
  const io: CliIo = { ...defaultIo, ...options.io };
  const signal = options.signal;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      io.out(USAGE);
      return 0;
    case "--version":
    case "version":
      io.out(`${DAEMON_VERSION}\n`);
      return 0;
    case "connect":
      return commandConnect(paths, rest, io, signal);
    case "run":
      return commandRun(paths, rest, io, signal);
    case "status":
      return commandStatus(paths, io);
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
    case "forget":
      return commandForget(paths, rest, io);
    case "backends":
      return commandBackends(paths, io);
    default:
      io.err(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

// -- connect -----------------------------------------------------------------

async function commandConnect(
  paths: DaemonPaths,
  args: readonly string[],
  io: CliIo,
  signal?: AbortSignal,
): Promise<ExitCode> {
  const target = args[0];
  if (target === undefined) {
    io.err("usage: byollm connect <url>\n");
    return 2;
  }

  const origin = normalizeOrigin(target);
  const { loaded, ingress, allowlist, budgets } = await context(paths);

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
    ingress,
  });

  const capabilities = await runner.detectCapabilities();
  if (capabilities.length === 0) {
    // Pairing while advertising nothing would produce a runner that silently
    // never receives work — a failure the user could not diagnose.
    io.err(
      "No backend is reachable, so there is nothing to offer this app yet.\n" +
        "Run `byollm backends` to see what is configured and what is wrong.\n",
    );
    return 1;
  }

  io.out(`\nConnecting to ${origin}\n`);

  const result = await connect({
    client,
    daemonVersion: DAEMON_VERSION,
    label: hostLabel(),
    capabilities,
    onCode: (info) => {
      const minutes = Math.max(
        1,
        Math.round((info.expiresAt - Date.now()) / 60_000),
      );
      io.out(
        `\n  Open:  ${info.verificationUrl}\n` +
          `  Code:  ${info.userCode}      (expires in ${String(minutes)}m)\n\n` +
          `  waiting for approval…`,
      );
    },
    onPoll: () => {
      io.out(".");
    },
    ...(signal === undefined ? {} : { signal }),
  });

  if (!result.ok) {
    io.out(`\n\n  ${result.message}\n`);
    return 1;
  }

  const pairings = new Pairings(paths.pairings);
  await pairings.load();
  await pairings.put(result.pairing);

  io.out(
    ` paired as ${result.pairing.ownerLabel ?? result.pairing.owner}\n\n` +
      `Now running jobs for ${origin}. Ctrl-C to stop.\n\n`,
  );

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

async function runLoop(
  paths: DaemonPaths,
  origins: readonly string[],
  io: CliIo,
  signal?: AbortSignal,
): Promise<ExitCode> {
  const { loaded, ingress, allowlist, budgets } = await context(paths);
  const pairings = new Pairings(paths.pairings);
  await pairings.load();

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
      client: new ProtocolClient({ origin, token: pairing.token }),
      runnerId: pairing.runnerId,
      owner: pairing.owner,
      daemonVersion: DAEMON_VERSION,
      loaded,
      allowlist,
      budgets,
      ingress,
      onEvent: (event) => {
        report(origin, event, io);
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
      void Promise.all(
        runners.map((runner) => runner.shutdown("shutdown")),
      ).then(() => process.exit(0));
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
    case "error":
      io.err(`${at} ${host} ${stripControlChars(event.message)}\n`);
      break;
    case "heartbeat":
      break;
  }
}

// -- status ------------------------------------------------------------------

async function commandStatus(paths: DaemonPaths, io: CliIo): Promise<ExitCode> {
  const { loaded, ingress, allowlist, budgets } = await context(paths);
  const pairings = new Pairings(paths.pairings);
  await pairings.load();

  const paused = await isPaused(paths);
  const now = Date.now();

  io.out(`byollm ${DAEMON_VERSION}\n`);
  io.out(`state: ${paused ? "PAUSED" : "running"}\n\n`);

  io.out("paired apps\n");
  const list = pairings.list();
  if (list.length === 0) {
    io.out("  (none — run `byollm connect <url>`)\n");
  }
  for (const pairing of list) {
    io.out(`  ${pairing.origin}  as ${pairing.ownerLabel ?? pairing.owner}\n`);
  }

  io.out("\nroutes\n");
  if (loaded.routes.length === 0) {
    io.out("  (none configured)\n");
  }
  for (const route of loaded.routes) {
    io.out(
      `  ${route.kind.padEnd(14)} ${route.backendId}:${route.model}  ` +
        `offered to: ${route.offerScope}\n`,
    );
  }
  for (const problem of loaded.problems) {
    io.out(`  ! ${problem.where}: ${problem.message}\n`);
  }

  const allowed = allowlist.list();
  io.out("\nwho can use this machine\n");
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

  const usage = budgets.usage(now);
  io.out("\ncommunity work done for others\n");
  io.out(
    `  ${String(usage.hour)} in the last hour (cap ${String(usage.limits.maxJobsPerHour)}), ` +
      `${String(usage.day)} today (cap ${String(usage.limits.maxJobsPerDay)})\n`,
  );

  const entries = await ingress.read();
  const prompts = entries.filter((entry) => entry.type === "prompt");
  const outcomes = entries.filter((entry) => entry.type === "outcome");
  io.out("\nthis machine has run\n");
  io.out(
    `  ${String(prompts.length)} prompts, ` +
      `${String(outcomes.filter((o) => o.outcome === "ok").length)} ok, ` +
      `${String(outcomes.filter((o) => o.outcome === "error").length)} failed, ` +
      `${String(outcomes.filter((o) => o.outcome === "refused").length)} refused\n`,
  );
  io.out(
    `  full log: ${paths.ingressLog}  (community prompts kept ` +
      `${String(loaded.config.ingress.communityPromptDays)} days, then hashed)\n`,
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
    io.out("nothing has run on this machine yet\n");
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
        "Nobody but you can run work on this machine.\n" +
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
    `\nThis lets jobs belonging to "${owner}" on ${origin} run on this machine,\n` +
      `using your hardware and electricity, whenever your daemon is online.\n` +
      `Your subscription-backed models are never included — those stay yours alone.\n\n` +
      `Allow ${owner} to use this machine?`,
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
      ? `${owner} can no longer use this machine\n`
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
  const removed = await pairings.remove(normalizeOrigin(target));
  io.out(
    removed
      ? `forgot ${normalizeOrigin(target)} — the app may still list this runner ` +
          `until you revoke it there too\n`
      : `not paired with ${normalizeOrigin(target)}\n`,
  );
  return 0;
}

// -- backends ------------------------------------------------------------------

async function commandBackends(
  paths: DaemonPaths,
  io: CliIo,
): Promise<ExitCode> {
  const { loaded, ingress, allowlist, budgets } = await context(paths);
  const runner = new Runner({
    client: new ProtocolClient({ origin: "https://unused.invalid" }),
    runnerId: "local",
    owner: "local",
    daemonVersion: DAEMON_VERSION,
    loaded,
    allowlist,
    budgets,
    ingress,
  });

  const advertised = await runner.detectCapabilities();
  const advertisedKinds = new Set(advertised.map((c) => c.kind));

  io.out("configured routes\n");
  for (const route of loaded.routes) {
    const ok = advertisedKinds.has(route.kind);
    io.out(
      `  ${ok ? "✓" : "✗"} ${route.kind.padEnd(14)} ` +
        `${route.backendId}:${route.model}` +
        `${route.baseUrl === undefined ? "" : ` @ ${route.baseUrl}`}\n`,
    );
  }
  for (const problem of loaded.problems) {
    io.out(`  ! ${problem.where}: ${problem.message}\n`);
  }
  io.out(
    `\n${String(advertised.length)} of ${String(loaded.routes.length)} routes are ` +
      `healthy and will be advertised.\n` +
      `A route that is not healthy is never offered to an app — the daemon does\n` +
      `not advertise what it cannot actually run.\n`,
  );
  return advertised.length === 0 ? 1 : 0;
}

// -- shared -------------------------------------------------------------------

async function context(paths: DaemonPaths): Promise<{
  loaded: Awaited<ReturnType<typeof loadConfig>>;
  ingress: IngressLog;
  allowlist: Allowlist;
  budgets: Budgets;
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
  return { loaded, ingress, allowlist, budgets };
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
