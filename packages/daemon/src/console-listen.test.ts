import {
  generateKeys,
  publicIdentityOf,
  verifyRequest,
} from "@byollm/protocol";
import { describe, expect, it } from "vitest";
import {
  CONSOLE_DEVICE_ENDPOINT,
  consoleListener,
  deviceHeaders,
} from "./console-listen.js";
import type { ConsoleSocket } from "./console-agent-main.js";

/**
 * The box waiting to be told — B018c hole 2, from the box's side.
 *
 * The hub's half is tested over real sockets in `byollm-cloud`. This is the
 * half that decides what to DO when told, and the cases that matter are the
 * ones where it is told something it should not act on.
 */

const RUNNER = "box-1";

function socket() {
  const closed: number[] = [];
  let onMessage: (t: string) => void = () => undefined;
  let onClose: (r: string) => void = () => undefined;
  const it: ConsoleSocket = {
    send: () => undefined,
    onMessage: (h) => {
      onMessage = h;
    },
    onClose: (h) => {
      onClose = h;
    },
    close: () => closed.push(1),
  };
  return {
    it,
    get closes() {
      return closed.length;
    },
    say: (v: unknown) => {
      onMessage(typeof v === "string" ? v : JSON.stringify(v));
    },
    hangUp: (r: string) => {
      onClose(r);
    },
  };
}

const announcement = (over: Record<string, unknown> = {}) => ({
  type: "console-session",
  sessionId: "sess_1",
  deadlineAt: 4_000_000_000_000,
  browser: publicIdentityOf(generateKeys(1)),
  ...over,
});

function listening() {
  const keys = generateKeys(2);
  const wire = socket();
  const ran: string[] = [];
  const logs: { message: string; fields?: Record<string, unknown> }[] = [];
  let finish: (() => void) | undefined;

  const listener = consoleListener({
    url: "wss://hub.example/console/device",
    runnerId: RUNNER,
    keys,
    run: (a) => {
      ran.push(a.sessionId);
      return new Promise<void>((done) => {
        finish = done;
      });
    },
    log: (message, fields) =>
      logs.push({ message, ...(fields ? { fields } : {}) }),
    connect: () => Promise.resolve(wire.it),
  });

  return {
    listener,
    wire,
    ran,
    logs,
    keys,
    end: () => finish?.(),
  };
}

const settle = () => new Promise((done) => setTimeout(done, 0));

describe("what the box presents at the control door", () => {
  it("signs the endpoint, and the hub's verifier accepts it", () => {
    /** Not "a signature exists" — the hub's own `verifyRequest` is what has
     *  to accept it, so that is what this asks. */
    const keys = generateKeys(3);
    const at = Date.now();
    const headers = deviceHeaders(keys, RUNNER, at);

    expect(
      verifyRequest({
        identityPublic: publicIdentityOf(keys).identity,
        endpoint: CONSOLE_DEVICE_ENDPOINT,
        body: CONSOLE_DEVICE_ENDPOINT,
        signature: {
          runnerId: headers["x-byollm-runner"]!,
          issuedAt: Number(headers["x-byollm-issued-at"]),
          signature: headers["x-byollm-signature"]!,
        },
        now: at,
      }),
      "null means the hub would accept it",
    ).toBe(null);
  });

  it("a signature from a DIFFERENT key is refused", () => {
    const mine = generateKeys(4);
    const theirs = generateKeys(5);
    const at = Date.now();
    const headers = deviceHeaders(theirs, RUNNER, at);
    expect(
      verifyRequest({
        identityPublic: publicIdentityOf(mine).identity,
        endpoint: CONSOLE_DEVICE_ENDPOINT,
        body: CONSOLE_DEVICE_ENDPOINT,
        signature: {
          runnerId: headers["x-byollm-runner"]!,
          issuedAt: Number(headers["x-byollm-issued-at"]),
          signature: headers["x-byollm-signature"]!,
        },
        now: at,
      }),
    ).not.toBe(null);
  });
});

describe("what it does when told", () => {
  it("runs the session it was announced", async () => {
    const h = listening();
    await settle();
    h.wire.say(announcement());
    expect(h.ran).toEqual(["sess_1"]);
  });

  it("REFUSES a second console while one is running, and says so", async () => {
    /**
     * A box is one person's machine with one console. Two consoles typing
     * into one shell is not a feature. Refused loudly rather than queued —
     * a console that opens minutes later, when the person gave up and
     * clicked again, is worse than one that says no.
     */
    const h = listening();
    await settle();
    h.wire.say(announcement());
    h.wire.say(announcement({ sessionId: "sess_2" }));

    expect(h.ran).toEqual(["sess_1"]);
    expect(
      h.logs.some(
        (l) => l.message === "a console is already running on this box",
      ),
    ).toBe(true);
  });

  it("takes the NEXT one once the first has finished", async () => {
    const h = listening();
    await settle();
    h.wire.say(announcement());
    h.end();
    await settle();
    h.wire.say(announcement({ sessionId: "sess_2" }));
    expect(h.ran).toEqual(["sess_1", "sess_2"]);
  });

  it("is not stopped by a session that throws", async () => {
    const wire = socket();
    const ran: string[] = [];
    consoleListener({
      url: "wss://hub.example/console/device",
      runnerId: RUNNER,
      keys: generateKeys(6),
      run: (a) => {
        ran.push(a.sessionId);
        return Promise.reject(new Error("the pty died"));
      },
      log: () => undefined,
      connect: () => Promise.resolve(wire.it),
    });
    await settle();
    wire.say(announcement());
    await settle();
    /* The box must still take the next console after one fails — otherwise
       one bad session makes the machine permanently unreachable. */
    wire.say(announcement({ sessionId: "sess_2" }));
    await settle();
    expect(ran).toEqual(["sess_1", "sess_2"]);
  });
});

describe("what it refuses to act on", () => {
  it("ignores anything that is not an announcement", async () => {
    const h = listening();
    await settle();
    h.wire.say({ type: "something-else", sessionId: "sess_x" });
    h.wire.say("not json at all");
    expect(h.ran).toEqual([]);
  });

  it("ignores a DIFFERENT message type that otherwise looks like one", async () => {
    /**
     * Found by mutation: removing the `type` gate left every case green,
     * because the other rejects happened to fail the shape parse anyway. The
     * gate only has work to do when a message carries the same FIELDS under
     * a different name — which is exactly what a future control message
     * would look like, and acting on one would start a console nobody asked
     * for.
     */
    const h = listening();
    await settle();
    h.wire.say(announcement({ type: "console-ended" }));
    expect(h.ran).toEqual([]);
  });

  it("refuses an announcement missing the browser identity", async () => {
    /**
     * The identity is what the agent pins and verifies every frame against.
     * An announcement without it describes a session that could never be
     * verified — running it would mean opening a console on somebody's box
     * with nothing to check the far end against.
     */
    const h = listening();
    await settle();
    const { browser: _omitted, ...withoutIdentity } = announcement();
    h.wire.say(withoutIdentity);
    expect(h.ran).toEqual([]);
    expect(
      h.logs.some(
        (l) =>
          l.message === "the console broker announced a session we cannot read",
      ),
    ).toBe(true);
  });

  it("refuses an announcement whose identity is malformed", async () => {
    const h = listening();
    await settle();
    h.wire.say(announcement({ browser: { identity: "only-one-field" } }));
    expect(h.ran).toEqual([]);
  });

  it("stops listening when asked, and closes the socket", async () => {
    const h = listening();
    await settle();
    h.listener.stop();
    expect(h.listener.listening).toBe(false);
    expect(h.wire.closes).toBe(1);
  });
});
