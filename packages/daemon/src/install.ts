import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  refuseToSupervise,
  servicePlan,
  type ServicePlan,
  type ServiceTarget,
} from "./service.js";

/**
 * Installing and removing the service, and asking whether it is running.
 *
 * The half that touches the machine. Kept apart from `service.ts` (which
 * decides *what* to write) so the decisions stay testable everywhere and the
 * effects stay in one small file with two injected seams: writing files and
 * running commands.
 *
 * Nothing here is clever. The interesting property is that every failure
 * arrives as a sentence naming the command that failed and what to do — an
 * install that half-worked is worse than one that refused, because the
 * machine will look installed and not serve.
 */

export type CommandRunner = (command: readonly string[]) => Promise<{
  readonly code: number;
  readonly output: string;
}>;

/** What the supervisor says about us. */
export type ServiceState =
  | { readonly state: "running" }
  /** The unit is installed but the supervisor is not running it. */
  | { readonly state: "installed"; readonly detail: string }
  | { readonly state: "absent" };

export async function serviceState(
  plan: ServicePlan,
  run: CommandRunner,
): Promise<ServiceState> {
  const result = await run(plan.query).catch(() => ({
    code: 127,
    output: "",
  }));
  if (result.code !== 0) return { state: "absent" };

  // Each supervisor answers differently, and each answer has to be read for
  // *running*, not merely *known*. launchd prints a `state = running` line for
  // a live job and a `pid` only when there is one; a loaded-but-stopped job
  // still prints a whole record, so an exit code of zero here means "the
  // service exists", never "it is serving".
  if (plan.platform === "darwin") {
    if (
      /\bstate = running\b/.test(result.output) ||
      /\n\s*pid = \d+/.test(result.output)
    ) {
      return { state: "running" };
    }
    const last = /last exit (?:code|status) = (-?\d+)/.exec(result.output);
    return {
      state: "installed",
      detail:
        last === null
          ? "loaded but not running"
          : `not running (last exit ${last[1] ?? "?"})`,
    };
  }

  if (plan.platform === "linux") {
    // `is-active` exits non-zero for anything but active, so reaching here
    // usually means active — but read the word rather than infer it, because
    // `activating` also exits zero on some versions and is not yet serving.
    const word = result.output.trim();
    return word === "active"
      ? { state: "running" }
      : { state: "installed", detail: word === "" ? "not running" : word };
  }

  // `schtasks /query` prints a status column; "Running" is the only one that
  // means a process exists. "Ready" means it will start at the next logon,
  // which is a real state and not the same as serving.
  if (/\bRunning\b/.test(result.output)) return { state: "running" };
  return { state: "installed", detail: "registered, not running" };
}

export interface InstallResult {
  readonly ok: boolean;
  /** Sentences to print, in order. Empty on plain success is not allowed. */
  readonly lines: readonly string[];
  readonly plan: ServicePlan;
}

export async function installService(
  target: ServiceTarget,
  run: CommandRunner,
): Promise<InstallResult> {
  const plan = servicePlan(target);

  const refusal = refuseToSupervise(target.scriptPath);
  if (refusal !== null) {
    return { ok: false, lines: [refusal], plan };
  }

  await mkdir(dirname(plan.unitPath), { recursive: true });
  await writeFile(plan.unitPath, plan.unitContents, "utf8");

  for (const [index, command] of plan.activate.entries()) {
    const result = await run(command);
    // The first step on macOS is a `bootout` that clears any previous copy,
    // and it fails whenever there was none. Only that one is allowed to.
    const mayFail = plan.platform === "darwin" && index === 0;
    if (result.code !== 0 && !mayFail) {
      return {
        ok: false,
        plan,
        lines: [
          `wrote ${plan.unitPath}, but ${plan.supervisor} refused it:`,
          "",
          `  ${command.join(" ")}`,
          `  exit ${String(result.code)}${result.output.trim() === "" ? "" : `: ${result.output.trim()}`}`,
          "",
          `The daemon is not supervised. \`byollm run\` still works in a terminal.`,
        ],
      };
    }
  }

  const lines = [
    `Installed. ${plan.supervisor} will keep byollm running and restart it if it stops.`,
    "",
    `  service:  ${plan.unitPath}`,
    `  log:      ${plan.logPath}`,
    `  check:    byollm status`,
    `  remove:   byollm uninstall`,
  ];

  if (plan.platform === "linux") {
    // The one thing install does not do for somebody: lingering changes
    // behaviour outside their session, and choosing that for them is not this
    // command's business.
    lines.push(
      "",
      "To keep serving after you log out:",
      "",
      "  sudo loginctl enable-linger $USER",
    );
  }

  return { ok: true, plan, lines };
}

export async function uninstallService(
  target: ServiceTarget,
  run: CommandRunner,
): Promise<InstallResult> {
  const plan = servicePlan(target);
  const failures: string[] = [];

  for (const command of plan.deactivate) {
    const result = await run(command).catch(() => ({ code: 127, output: "" }));
    // Every deactivation step is allowed to fail: "it was not installed" and
    // "it is now not installed" are the same end state, and an uninstall that
    // errors on a machine with nothing to remove teaches people to ignore it.
    if (result.code !== 0 && result.output.trim() !== "") {
      failures.push(`  ${command.join(" ")} — ${result.output.trim()}`);
    }
  }

  await rm(plan.unitPath, { force: true });

  return {
    ok: true,
    plan,
    lines: [
      `Removed. ${plan.supervisor} is no longer running byollm.`,
      `Your pairings, allowlist and logs are untouched in ~/.byollm.`,
      ...(failures.length === 0
        ? []
        : [
            "",
            "The supervisor had something to say (usually harmless):",
            ...failures,
          ]),
    ],
  };
}

/**
 * Run a command and collect everything it said.
 *
 * Exported because the alternative — a private closure inside the CLI — is a
 * seam nothing can exercise, and this one has the two failure modes that
 * matter: a binary that is not there (a container with no `systemctl`) and a
 * command that exits non-zero with its reason on stderr. Both are the
 * difference between "not installed" and a crash.
 */
export const spawnCommand: CommandRunner = async (command) => {
  const { spawn } = await import("node:child_process");
  const [file, ...args] = command;
  return new Promise((resolve) => {
    // No shell, ever. Every argument is passed through as itself, so nothing
    // here can be re-interpreted by whichever `/bin/sh` a platform ships —
    // and there is nothing left to quote.
    const child = spawn(file ?? "", args);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", () => {
      resolve({ code: 127, output });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 0, output });
    });
  });
};
