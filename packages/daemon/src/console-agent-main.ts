import { consoleSession, type ConsoleSessionRecord } from "./console-agent.js";
import { openPtyShell } from "./pty-shell.js";
import { NoPtyError } from "./pty-shell.js";
import type {
  PublicIdentity,
  SealedEnvelope,
  StoredKeys,
} from "@byollm/protocol";
import { SealedEnvelope as SealedEnvelopeSchema } from "@byollm/protocol";

/**
 * `byollm console-agent` — the box side of a browser console, and the caller
 * that `consoleSession` was missing.
 *
 * ## This is not something `byollm run` ever starts
 *
 * A capability that lets a remote broker drive a pty should be ABSENT from a
 * laptop daemon's behaviour, not merely disabled in it. So it is a subcommand
 * the box's supervisor launches and nothing else invokes — default-off is a
 * mitigation; not-running-unless-invoked is a property. The pty itself is not
 * even installed outside the box image (see {@link openPtyShell}), so on an
 * ordinary machine this command has nothing to run and says so in one line.
 *
 * ## What it does NOT decide
 *
 * Authorisation. The hub decides which owner may open a session against which
 * box, mints the per-session grant, and announces the browser's ephemeral
 * identity. This agent verifies what it can — that every frame is signed by
 * the announced key and that the sealed `hello` names the same one — and
 * carries the ruling's own honesty about the rest: a control plane that mints
 * access can always mint access, which is why every session is written to the
 * owner's feed.
 */

export interface ConsoleAgentOptions {
  /** `wss://…` — the hub's console endpoint for this session. */
  readonly url: string;
  readonly sessionId: string;
  readonly deadlineAt: number;
  readonly keys: StoredKeys;
  /** The browser's ephemeral identity, as the hub announced it. */
  readonly browser: PublicIdentity;
  /** The restricted shell, as the box image defines it. */
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly record: (entry: ConsoleSessionRecord) => Promise<void>;
  readonly now?: () => number;
  /** Injected in tests. Production opens a real WebSocket. */
  readonly connect?: (url: string) => Promise<ConsoleSocket>;
  readonly openShell?: typeof openPtyShell;
}

/** The transport, as narrow as the agent actually needs it. */
export interface ConsoleSocket {
  send(text: string): void;
  onMessage(handler: (text: string) => void): void;
  onClose(handler: (reason: string) => void): void;
  close(): void;
}

/**
 * Node 22 ships a global `WebSocket`, so the box needs no client library —
 * measured in the image the box actually runs, not assumed from the local
 * Node. That is the second dependency this feature does not add.
 */
const connectWebSocket = (url: string): Promise<ConsoleSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
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
          socket.addEventListener("close", () => {
            handler("the console channel closed");
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

/**
 * Run one console session to completion. Resolves with why it ended.
 */
export async function runConsoleAgent(
  options: ConsoleAgentOptions,
): Promise<string> {
  const shell = await (options.openShell ?? openPtyShell)({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
  });

  const socket = await (options.connect ?? connectWebSocket)(options.url);

  const session = consoleSession({
    sessionId: options.sessionId,
    deadlineAt: options.deadlineAt,
    keys: options.keys,
    browser: options.browser,
    shell,
    send: (envelope: SealedEnvelope) => {
      socket.send(JSON.stringify(envelope));
      return Promise.resolve();
    },
    record: options.record,
    now: options.now ?? (() => Date.now()),
  });

  return new Promise<string>((resolve) => {
    const done = (why: string): void => {
      socket.close();
      resolve(session.ended ?? why);
    };

    /**
     * Stopping is not finishing, and forgetting that was a real bug here: on a
     * malformed message this ended the SESSION and then waited forever for a
     * `done` that only the delivery path and the socket's close could reach.
     * The process would have sat holding a socket with nothing left to do.
     * Found by a test that TIMED OUT rather than failed, which is the tell.
     */
    const abandon = (why: string): void => {
      session.stop(why).then(
        () => {
          done(why);
        },
        () => {
          done(why);
        },
      );
    };

    socket.onMessage((text) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        abandon("the broker sent something that was not a frame");
        return;
      }
      // Parsed, not cast. The broker is not trusted to send well-formed
      // envelopes — it is not trusted at all, which is the point of sealing.
      const envelope = SealedEnvelopeSchema.safeParse(parsed);
      if (!envelope.success) {
        abandon("the broker sent something that was not a frame");
        return;
      }
      session
        .deliver(envelope.data)
        .then(() => {
          if (session.ended !== undefined) done(session.ended);
        })
        .catch(() => {
          done("the console session failed");
        });
    });

    socket.onClose((reason) => {
      session
        .stop(reason)
        .then(() => {
          done(reason);
        })
        .catch(() => {
          done(reason);
        });
    });
  });
}

/** What the CLI prints when the pty is simply not here. */
export function consoleAgentUnavailable(error: unknown): string | undefined {
  return error instanceof NoPtyError ? error.message : undefined;
}
