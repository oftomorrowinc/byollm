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
  /**
   * Injected in tests. **Production uses {@link dialControlSocket}**, and the
   * absence of that default is the whole reason a console never worked.
   *
   * `dial()` began `if (deps.connect === undefined) return;` and the CLI never
   * passed one — so on every box, in every release, this function opened no
   * socket, registered with no broker, and returned without a word. The box
   * printed "listening for consoles", which was the last true thing it said.
   *
   * It survived because it is invisible from both ends. The box looks healthy
   * (nothing failed). The hub looks healthy (a device that never attached is
   * indistinguishable from one that is merely offline). And .96's keepalive
   * made it worse by making it calm: before, the process at least crash-looped
   * loudly; after, it held a socketless silence forever.
   */
  readonly connect?: (
    url: string,
    headers: Record<string, string>,
  ) => Promise<ConsoleSocket>;
  /** Injected in tests, so a reconnect ladder can be walked without waiting. */
  readonly wait?: (ms: number) => Promise<void>;
  /** Injected in tests. Holds the event loop open; see `keepalive` below. */
  readonly keepalive?: () => { stop(): void };
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
/**
 * The control socket a box holds open, with the headers that say which box.
 *
 * Node's global `WebSocket` takes a `headers` option, which is not in the
 * WHATWG standard but is what makes this possible without a client library —
 * the browser's door has to carry its credentials in the query string
 * precisely because a browser cannot do this.
 *
 * **Measured in the image the box actually runs**, per the standard
 * `console-agent-main.ts` set for the same question: `node:22-bookworm-slim`
 * at the pinned digest, Node v22.23.2, header received. Not assumed from the
 * local Node, which is a 24.
 */
const dialControlSocket = (
  url: string,
  headers: Record<string, string>,
): Promise<ConsoleSocket> =>
  new Promise((resolve, reject) => {
    /* The options bag is accepted by the runtime and by the type — no cast
       needed, which is worth noticing: the headers path is supported rather
       than smuggled. */
    const socket = new WebSocket(url, { headers });
    socket.addEventListener("open", () => {
      resolve({
        send: (text) => {
          socket.send(text);
        },
        onMessage: (handler) => {
          socket.addEventListener("message", (event: MessageEvent) => {
            handler(String(event.data));
          });
        },
        onClose: (handler) => {
          socket.addEventListener("close", (event: CloseEvent) => {
            /* The code, because "it closed" was never the question. A 1006
               and a 1008 send an operator to different places, and the door
               refusing a signature looks identical to a network drop without
               it. */
            handler(
              `${String(event.code)}${event.reason === "" ? "" : ` ${event.reason}`}`,
            );
          });
        },
        close: () => {
          socket.close();
        },
      });
    });
    socket.addEventListener("error", () => {
      reject(new Error(`could not reach the console broker at ${url}`));
    });
  });

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

  /**
   * Something that holds the event loop open ON PURPOSE.
   *
   * The box logs on 09-17 read: "listening for consoles" → Node's *"Detected
   * unsettled top-level await"* → exit → supervisor restart, every few
   * seconds. The listener was alive only for as long as its socket was: the
   * caller parks on `await new Promise(() => undefined)`, which settles never
   * and REFERENCES nothing, so the moment the socket closed the loop had no
   * work left, drained, and Node exited with that await still pending.
   *
   * A process whose lifetime is a side effect of an open socket cannot
   * reconnect, because reconnecting is something you do after the socket is
   * gone. So the listener owns a handle of its own and keeps it until `stop()`.
   */
  const alive = (deps.keepalive ?? defaultKeepalive)();

  /* 1s doubling to 30s, reset on every successful dial. A box whose hub is
     briefly away should be back in a second; a box whose hub is down for an
     hour should not spend that hour dialling. */
  let backoffMs = 1_000;
  const wait = deps.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  const redial = (why: string, detail?: string): void => {
    if (stopped) return;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, 30_000);
    /* SAYS WHY, every time. The old listener printed one optimistic line and
       then died silently on a loop — B228's status-lie in a sidecar: the
       process reported what it intended, never what happened to it. */
    deps.log("the console control socket is gone — reconnecting", {
      why,
      ...(detail === undefined ? {} : { detail }),
      inMs: delay,
    });
    /* Handled rather than voided, and the rule that insisted is right: a
       rejection here is the reconnect quietly not happening, which is the
       exact silence this whole change exists to end. */
    wait(delay)
      .then(() => {
        if (stopped) return undefined;
        return dial();
      })
      .catch((cause: unknown) => {
        deps.log("the reconnect itself failed", {
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      });
  };

  const dial = async (): Promise<void> => {
    /* Defaulted, never skipped. An absent dependency that turns the whole
       function into a silent no-op is not a safe default — it is the bug. */
    const connect = deps.connect ?? dialControlSocket;
    try {
      socket = await connect(
        deps.url,
        deviceHeaders(deps.keys, deps.runnerId, now()),
      );
    } catch (cause) {
      redial(
        "the broker refused or could not be reached",
        cause instanceof Error ? cause.message : String(cause),
      );
      return;
    }
    if (stopped) {
      socket.close();
      return;
    }
    backoffMs = 1_000;
    deps.log("holding the console control socket");
    socket.onMessage(handle);
    socket.onClose((reason) => {
      redial("the broker closed it", reason);
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
      alive.stop();
      socket?.close();
    },
  };
}

/** A bare timer, unref'd nowhere: holding the loop open is its whole job. */
function defaultKeepalive(): { stop(): void } {
  const handle = setInterval(() => undefined, 60_000);
  return {
    stop() {
      clearInterval(handle);
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
