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

/**
 * The refusal, named when we can name it.
 *
 * "exit 1" tells somebody nothing they can act on. Windows says "Access is
 * denied" for the two cases that actually happen — no elevation, or policy —
 * and saying which turns a dead end into a sentence with a next step in it.
 */
function refusalOf(
  command: readonly string[],
  result: { code: number; output: string },
): string {
  const said = result.output.trim();
  const denied = /access is denied|requires elevation|0x80070005/i.test(said);
  return denied
    ? `${command.join(" ")} — this machine will not let you register a ` +
        `scheduled task (no administrator rights, or IT policy).`
    : `${command.join(" ")} — exit ${String(result.code)}` +
        (said === "" ? "" : `: ${said}`);
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
  await writeUnit(plan.unitPath, plan.unitContents, plan.unitEncoding);

  for (const [index, command] of plan.activate.entries()) {
    const result = await run(command);
    // The first step on macOS is a `bootout` that clears any previous copy,
    // and it fails whenever there was none. Only that one is allowed to.
    const mayFail = plan.platform === "darwin" && index === 0;
    if (result.code !== 0 && !mayFail) {
      /**
       * A machine that will not register a task still gets to start byollm.
       *
       * Registering a scheduled task is not always permitted: a managed
       * laptop can have it blocked by policy, a standard account can be
       * refused elevation. What that produced was an exit code and "the
       * daemon is not supervised" — on the machine most likely to be
       * somebody's work computer, which is the machine most likely to need
       * it, and the one where "run it in a terminal forever" is least
       * plausible.
       *
       * So there is a second way, and it is weaker in a way the person is
       * told about rather than left to discover after a crash nobody noticed.
       */
      const fallback = plan.fallback;
      if (fallback !== undefined) {
        // Bound to a local first: `plan.fallback!` inside the closures would
        // be an assertion that the narrowing above still holds several
        // statements later, which is the kind of claim this project makes the
        // compiler check rather than the author.
        const fell = await mkdir(dirname(fallback.unitPath), {
          recursive: true,
        })
          .then(() =>
            writeUnit(
              fallback.unitPath,
              fallback.unitContents,
              fallback.unitEncoding,
            ),
          )
          .then(
            () => true,
            () => false,
          );
        if (fell) {
          return {
            ok: true,
            plan,
            lines: [
              `${plan.supervisor} would not register the task, so byollm is`,
              `set to start from ${fallback.supervisor} instead.`,
              "",
              `  ${fallback.caveat}`,
              "",
              `  ${refusalOf(command, result)}`,
              "",
              `  startup:  ${fallback.unitPath}`,
              `  log:      ${plan.logPath}`,
              `  check:    byollm status`,
              `  remove:   byollm uninstall`,
            ],
          };
        }
      }
      return {
        ok: false,
        plan,
        lines: [
          `wrote ${plan.unitPath}, but ${plan.supervisor} refused it:`,
          "",
          `  ${refusalOf(command, result)}`,
          "",
          `The daemon is not supervised. \`byollm run\` still works in a terminal,`,
          `and is the way to keep serving until this is sorted.`,
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

  /**
   * And the fallback, which on Windows is the one that was actually there.
   *
   * This removed `plan.unitPath` only. Every Windows install had fallen to
   * the Startup folder — see `writeUnit` for why — so uninstall deleted a
   * task XML that had never registered, printed "Removed", and left the
   * thing that starts the daemon exactly where it was. Next logon it came
   * back.
   *
   * A daemon that restarts after its owner removed it is not a bug about
   * supervisors. It is somebody's machine doing work they told it to stop
   * doing, and being told it had stopped.
   *
   * Removed unconditionally rather than only when the fallback was used:
   * uninstall's whole contract is that "it was not installed" and "it is now
   * not installed" end the same way, and a machine that has been through
   * several versions may carry both.
   */
  const fallbackPath = plan.fallback?.unitPath;
  if (fallbackPath !== undefined) {
    await rm(fallbackPath, { force: true });
  }

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

/**
 * Write a unit file as the thing it says it is.
 *
 * This was `writeFile(path, contents, "utf8")` for every platform, and the
 * Windows task XML declares `encoding="UTF-16"` on its own first line. MSXML
 * refused the mismatch, so every `schtasks /create /xml` failed — on every
 * Windows machine, with or without administrator rights — and fell to the
 * Startup folder, which cannot restart a crashed daemon. Restart-on-failure
 * has never shipped to a Windows user.
 *
 * The BOM is not decoration. `schtasks` identifies the encoding from it;
 * UTF-16LE bytes without one are read as something else and refused just as
 * firmly as the mismatch was. Node writes the code units and no mark, so it
 * is prepended here.
 *
 * **Not verified on Windows from this machine.** The mismatch is provable
 * from the source and the fix is the shape Task Scheduler's own export uses,
 * but the thing that would settle it is a real `schtasks /create` — which is
 * Kevin, and which is why the test below asserts the bytes rather than the
 * outcome.
 */
async function writeUnit(
  path: string,
  contents: string,
  encoding: "utf8" | "utf16le",
): Promise<void> {
  await writeFile(
    path,
    encoding === "utf16le" ? `\uFEFF${contents}` : contents,
    encoding,
  );
}
