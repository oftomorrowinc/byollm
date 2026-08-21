import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Running the daemon under the machine's own supervisor — cloud_002.
 *
 * Found the first time somebody paired for real: `byollm connect` ends in
 * `Now running jobs… Ctrl-C to stop`, and that was the only way to run one.
 * Todd's words were *"people shouldn't have to keep terminals open"*, and the
 * cost is not inconvenience. A machine that stops serving when a window
 * closes stops earning its place on a roster **silently** — the owner finds
 * out when a teammate's job does not run, on a different machine, later.
 *
 * ## A plan, not a side effect
 *
 * Everything platform-specific is decided here, in a function that writes
 * nothing: given a platform and a resolved executable, it returns the unit
 * file's path and contents and the commands that activate it. That is what
 * makes three operating systems testable on one — the macOS plist and the
 * systemd unit are asserted on Linux CI, exactly, including the arguments
 * they run. A wrong plist is otherwise a thing you discover by rebooting.
 *
 * ## User-level, always
 *
 * A LaunchAgent rather than a LaunchDaemon; `systemd --user` rather than a
 * system unit; a logon task rather than a Windows service. All three mean:
 * no root to install, runs as the person whose models these are, and dies
 * with their account. The daemon's whole premise is that it runs on somebody's
 * own machine under their own control — installing it as root would make the
 * uninstall a sudo operation and the process a thing the owner cannot inspect.
 * `~/.byollm` is theirs; so is this.
 *
 * ## What it runs
 *
 * `byollm run`, with no URL: every pairing this machine has. Not `connect`,
 * which is interactive and prints a code for somebody to type. The pairing
 * file already survives a restart, so supervision is the only missing piece.
 */

export type ServicePlatform = "darwin" | "linux" | "win32";

/** The reverse-DNS name all three platforms key the service by. */
export const SERVICE_LABEL = "cloud.byollm.daemon";

/**
 * Which of the three supervisors this platform has.
 *
 * Everything that is not macOS or Windows is treated as systemd. That is a
 * simplification with a name: a BSD or a musl box with OpenRC gets a unit file
 * its init system will not read, and `install` will report the failure that
 * follows rather than pretend. Guessing wrong loudly beats refusing to run on
 * a platform somebody actually has.
 */
export function servicePlatform(platform: string): ServicePlatform {
  if (platform === "win32") return "win32";
  if (platform === "darwin") return "darwin";
  return "linux";
}

export interface ServicePlan {
  readonly platform: ServicePlatform;
  /** The file that defines the service — plist, unit, or task XML. */
  readonly unitPath: string;
  readonly unitContents: string;
  /** Run these, in order, to make it live. */
  readonly activate: readonly (readonly string[])[];
  /** Run these, in order, to take it away. Tolerant of "already gone". */
  readonly deactivate: readonly (readonly string[])[];
  /** Asks the platform whether it is running right now. */
  readonly query: readonly string[];
  /** Where the supervisor sends the daemon's output. */
  readonly logPath: string;
  /** In words, for the person at the terminal. */
  readonly supervisor: string;
}

export interface ServiceTarget {
  readonly platform: ServicePlatform;
  /** The node binary, absolute. */
  readonly execPath: string;
  /** The CLI's entry script, absolute. */
  readonly scriptPath: string;
  readonly home?: string;
  /** `~/.byollm`, so the service and the CLI agree about state. */
  readonly root?: string;
}

/** XML-escape a path — a home directory can contain `&` and an apostrophe. */
function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function servicePlan(target: ServiceTarget): ServicePlan {
  const home = target.home ?? homedir();
  const root = target.root ?? join(home, ".byollm");
  const logPath = join(root, "service.log");
  const { execPath, scriptPath } = target;

  if (target.platform === "darwin") {
    // `KeepAlive` unconditionally true, not `SuccessfulExit: false`: a daemon
    // that exits cleanly because a hub was unreachable at boot has still
    // stopped serving, and "it exited zero" is not a reason to leave a
    // machine off its roster.
    const unitPath = join(
      home,
      "Library",
      "LaunchAgents",
      `${SERVICE_LABEL}.plist`,
    );
    const unitContents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(execPath)}</string>
    <string>${xml(scriptPath)}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
    // `bootstrap gui/<uid>` rather than the deprecated `load`: it reports a
    // real error when the plist is malformed instead of failing quietly,
    // which is the difference between finding a typo now and finding it at
    // the next reboot.
    const domain = "gui/$UID";
    return {
      platform: "darwin",
      unitPath,
      unitContents,
      activate: [
        ["launchctl", "bootout", domain, unitPath],
        ["launchctl", "bootstrap", domain, unitPath],
        ["launchctl", "enable", `${domain}/${SERVICE_LABEL}`],
      ],
      deactivate: [["launchctl", "bootout", domain, unitPath]],
      query: ["launchctl", "print", `${domain}/${SERVICE_LABEL}`],
      logPath,
      supervisor: "launchd",
    };
  }

  if (target.platform === "linux") {
    const unitPath = join(
      home,
      ".config",
      "systemd",
      "user",
      `${SERVICE_LABEL}.service`,
    );
    // No `WantedBy=default.target` alone: `systemctl --user enable` writes
    // that link, and `linger` is what makes it survive logout. Whether to
    // enable lingering is the owner's call — it is the one line here that
    // changes something outside their session — so `install` prints it
    // rather than running it.
    const unitContents = `[Unit]
Description=byollm — run an app's LLM jobs on your own models
Documentation=https://byo-llm.com/docs
After=network-online.target

[Service]
Type=simple
ExecStart=${execPath} ${scriptPath} run
Restart=always
RestartSec=10
# Output goes to the journal *and* to the same file the other platforms use,
# so "where are the logs" has one answer in the docs.
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
    return {
      platform: "linux",
      unitPath,
      unitContents,
      activate: [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", `${SERVICE_LABEL}.service`],
      ],
      deactivate: [
        ["systemctl", "--user", "disable", "--now", `${SERVICE_LABEL}.service`],
        ["systemctl", "--user", "daemon-reload"],
      ],
      query: ["systemctl", "--user", "is-active", `${SERVICE_LABEL}.service`],
      logPath,
      supervisor: "systemd (user)",
    };
  }

  // Windows has no user-level service, so this is a scheduled task at logon.
  // Registered from XML rather than `schtasks /create /sc onlogon`, because
  // the flag form cannot express restart-on-failure — and a task that starts
  // once at logon and never again after a crash is precisely the silent
  // failure this command exists to prevent.
  const unitPath = join(root, "byollm-task.xml");
  const unitContents = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>byollm — run an app's LLM jobs on your own models</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions>
    <Exec>
      <Command>${xml(execPath)}</Command>
      <Arguments>"${xml(scriptPath)}" run</Arguments>
    </Exec>
  </Actions>
</Task>
`;
  return {
    platform: "win32",
    unitPath,
    unitContents,
    activate: [
      ["schtasks", "/create", "/tn", SERVICE_LABEL, "/xml", unitPath, "/f"],
      ["schtasks", "/run", "/tn", SERVICE_LABEL],
    ],
    deactivate: [["schtasks", "/delete", "/tn", SERVICE_LABEL, "/f"]],
    query: ["schtasks", "/query", "/tn", SERVICE_LABEL],
    logPath,
    supervisor: "Task Scheduler",
  };
}

/**
 * Why this executable cannot be supervised, or null if it can.
 *
 * `npx` runs from a cache directory that npm deletes without warning. A
 * service pointing into one works today and fails at some later boot with
 * "no such file" in a log nobody is reading — the same invisible-stop this
 * command exists to prevent, reintroduced by the install itself. Refusing is
 * the only honest answer, and the fix is one line.
 */
export function refuseToSupervise(scriptPath: string): string | null {
  const ephemeral =
    /[/\\]_npx[/\\]|[/\\]\.npm[/\\]_cacache[/\\]|[/\\]npm-cache[/\\]_npx[/\\]/;
  if (ephemeral.test(scriptPath)) {
    return (
      `this copy of byollm lives in npx's cache (${scriptPath}), which npm ` +
      `deletes without warning — a service pointing at it would stop working ` +
      `at some later boot, silently.\n\n` +
      `  Install it properly first:  npm install -g byollm@alpha\n` +
      `  Then:                       byollm install`
    );
  }
  return null;
}
