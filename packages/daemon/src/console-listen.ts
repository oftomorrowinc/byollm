import { signRequest, type StoredKeys } from "@byollm/protocol";
import { ConsoleAgentSpec } from "./console-agent-spec.js";
import type { ConsoleSocket } from "./console-agent-main.js";

/**
 * Waiting to be told a console is wanted — the box side of B018c's hole 2.
 *
 * Until this existed a console session could be minted, opened by a browser,
 * and never joined: `byollm console-agent` took a session description and
 * **nothing ever gave it one**. The browser end is what exposed that, because
 * nothing else had ever tried to be the other party.
 *
 * ## Why a held socket rather than the heartbeat
 *
 * Ruled by CW, 2026-09-16, and the losing option was reasonable. The daemon
 * already heartbeats, so the response could have carried a pending console and
 * nothing would stay connected — but the console is INTERACTIVE, and a
 * heartbeat interval before anything happens reads as broken to the person who
 * just clicked. The showcase is "setup via the website"; the first impression
 * is the connect. It would also be a wire change, which the schema lock prices
 * at a version both ends move together.
 *
 * ## It carries announcements, never frames
 *
 * This socket learns that a session exists and nothing else. The session's
 * bytes go over a second, separate connection — the data door the broker
 * already relays blindly. Keeping them apart means the broker never has to
 * parse what it carries, which is the property the whole design rests on.
 */

/**
 * What the hub sends down the control socket. Parsed, never trusted.
 *
 * Not exported: it is structural, and every caller reaches it through
 * `ConsoleListenDeps["run"]` rather than by name. An export nothing imports is
 * surface without a reader, which `knip` is right to object to.
 */
interface ConsoleAnnouncement {
  readonly sessionId: string;
  readonly deadlineAt: number;
  readonly browser: ConsoleAgentSpec["browser"];
}

/** The endpoint the signature covers. One definition; the hub has the other. */
export const CONSOLE_DEVICE_ENDPOINT = "/console/device";

export interface ConsoleListenDeps {
  /** `wss://hub…/console/device`, already absolute. */
  readonly url: string;
  readonly runnerId: string;
  readonly keys: StoredKeys;
  /** Run one session. Returns when it ends. */
  readonly run: (announcement: ConsoleAnnouncement) => Promise<void>;
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
  readonly now?: () => number;
  /** Injected in tests. */
  readonly connect?: (
    url: string,
    headers: Record<string, string>,
  ) => Promise<ConsoleSocket>;
}

/** Headers the box presents. Mirrors the hub's `BOX_HEADERS`. */
export const deviceHeaders = (
  keys: StoredKeys,
  runnerId: string,
  now: number,
): Record<string, string> => {
  const signed = signRequest(keys, {
    endpoint: CONSOLE_DEVICE_ENDPOINT,
    runnerId,
    issuedAt: now,
    /* The endpoint signs for itself: there is no session yet, which is the
       entire point of this door. A replay inside the skew window opens a
       socket that receives the announcements the real box would receive —
       it buys an attacker nothing it did not already have. */
    body: CONSOLE_DEVICE_ENDPOINT,
  });
  return {
    "x-byollm-runner": signed.runnerId,
    "x-byollm-issued-at": String(signed.issuedAt),
    "x-byollm-signature": signed.signature,
  };
};

export interface ConsoleListener {
  /** Stop listening. Any session already running is left to finish. */
  stop(): void;
  readonly listening: boolean;
}

/**
 * Hold the control socket and run a session per announcement.
 *
 * One session at a time, deliberately: a box is one person's machine with one
 * console, and two consoles typing into one shell is not a feature anybody
 * asked for. A second announcement while one is running is refused loudly
 * rather than queued — a console that opens minutes later, when the person has
 * given up and clicked again, is worse than one that says no.
 */
export function consoleListener(deps: ConsoleListenDeps): ConsoleListener {
  const now = deps.now ?? Date.now;
  let stopped = false;
  let running = false;
  let socket: ConsoleSocket | undefined;

  const handle = (text: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      deps.log("the console broker sent something that was not a message");
      return;
    }
    const message = parsed as { type?: unknown } | null;
    if (message?.type !== "console-session") return;

    /* `type` is stripped before parsing, and the reason is the one this
       project documented in the schema lock this morning: the spec is
       `.strict()`, so an UNKNOWN KEY IS REFUSED — passing the whole message
       through made every announcement unreadable. The envelope's routing
       field is not part of the thing it routes. */
    const { type: _routing, ...body } = message as Record<string, unknown>;
    const spec = ConsoleAnnouncement(body);
    if (spec === undefined) {
      deps.log("the console broker announced a session we cannot read");
      return;
    }

    if (running) {
      /* Said, not swallowed. The person clicked and nothing will happen; the
         log is the only place that can explain why. */
      deps.log("a console is already running on this box", {
        refused: spec.sessionId,
      });
      return;
    }

    running = true;
    deps.log("a console session was announced", { session: spec.sessionId });
    void deps
      .run(spec)
      .catch((cause: unknown) => {
        deps.log("the console session ended badly", {
          session: spec.sessionId,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      })
      .finally(() => {
        running = false;
      });
  };

  const dial = async (): Promise<void> => {
    if (deps.connect === undefined) return;
    try {
      socket = await deps.connect(
        deps.url,
        deviceHeaders(deps.keys, deps.runnerId, now()),
      );
    } catch (cause) {
      deps.log("could not reach the console broker", {
        reason: cause instanceof Error ? cause.message : String(cause),
      });
      return;
    }
    if (stopped) {
      socket.close();
      return;
    }
    socket.onMessage(handle);
    socket.onClose((reason) => {
      deps.log("the console broker closed the control socket", { reason });
    });
  };
  dial().catch(() => {
    /* `dial` already logs what it could not do; this is the last net so a
       rejection here cannot take the daemon down with it. */
  });

  return {
    get listening() {
      return !stopped;
    },
    stop() {
      stopped = true;
      socket?.close();
    },
  };
}

/** Read an announcement, or undefined. The hub is input, like anything else. */
function ConsoleAnnouncement(value: unknown): ConsoleAnnouncement | undefined {
  const parsed = ConsoleAgentSpec.pick({
    sessionId: true,
    deadlineAt: true,
    browser: true,
  }).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
