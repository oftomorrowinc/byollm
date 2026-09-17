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

function listening(
  over: {
    /** Hand back a different socket per dial, or throw to refuse one. */
    connect?: (n: number) => Promise<ConsoleSocket>;
  } = {},
) {
  const keys = generateKeys(2);
  const wire = socket();
  const ran: string[] = [];
  const logs: { message: string; fields?: Record<string, unknown> }[] = [];
  const waits: number[] = [];
  let finish: (() => void) | undefined;
  let dials = 0;
  let keptAlive = 0;
  let released = 0;

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
    connect: () => {
      dials += 1;
      return over.connect ? over.connect(dials) : Promise.resolve(wire.it);
    },
    /* Immediate, so a reconnect ladder can be walked without spending the
       wall-clock it describes. The DELAYS are still recorded and asserted. */
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    keepalive: () => {
      keptAlive += 1;
      return {
        stop() {
          released += 1;
        },
      };
    },
  });

  return {
    listener,
    wire,
    ran,
    logs,
    keys,
    waits,
    end: () => finish?.(),
    get dials() {
      return dials;
    },
    get keptAlive() {
      return keptAlive;
    },
    get released() {
      return released;
    },
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

/**
 * **The listener was crash-looping on the fleet, and no test could see it.**
 *
 * Box logs, 09-17: "listening for consoles on …" → Node's *"Detected unsettled
 * top-level await"* → exit → supervisor restart, every few seconds. Todd's
 * console died mid-session because he reached the box BETWEEN crashes: it took
 * the announcement, spawned the pty, streamed the first bytes, then exited on
 * schedule and took the socket with it — which is also why no `bye` ever
 * arrived.
 *
 * Two defects, one cause. The process was alive only while its socket was —
 * the caller parks on a promise that settles never and holds nothing, so a
 * closed socket drained the loop — and nothing ever dialled twice, because
 * reconnecting is something you do after the socket is gone.
 */
describe("a control socket that goes away", () => {
  it("dials again instead of dying", async () => {
    const h = listening();
    await settle();
    expect(h.dials).toBe(1);

    h.wire.hangUp("1006");
    await settle();

    expect(h.dials, "the box stopped listening for good").toBe(2);
    h.listener.stop();
  });

  it("says WHY it is reconnecting, every time", async () => {
    /* The old listener printed one optimistic line and then died silently on a
       loop — B228's status-lie in a sidecar: it reported what it intended and
       never what happened to it. An operator reading those logs saw a box that
       was listening, forever, while it was not. */
    const h = listening();
    await settle();
    h.wire.hangUp("1006");
    await settle();

    const said = h.logs.find((l) =>
      l.message.includes("control socket is gone"),
    );
    expect(said).toBeDefined();
    expect(said?.fields?.["why"]).toBe("the broker closed it");
    expect(said?.fields?.["detail"]).toBe("1006");
    expect(said?.fields?.["inMs"]).toBe(1_000);
    h.listener.stop();
  });

  it("reconnects when the broker REFUSES the door, not only when it closes", async () => {
    /* A hub that rejects the signed handshake — a 401 at `/console/device` —
       left the old listener logging once and returning, which is the same
       dead end by a different route. */
    const h = listening({
      connect: (n) =>
        n === 1
          ? Promise.reject(new Error("401 unauthorized"))
          : Promise.resolve(socket().it),
    });
    await settle();
    await settle();

    expect(h.dials).toBeGreaterThan(1);
    const said = h.logs.find(
      (l) => l.fields?.["detail"] === "401 unauthorized",
    );
    expect(said?.fields?.["why"]).toBe(
      "the broker refused or could not be reached",
    );
    h.listener.stop();
  });

  it("backs off, and resets once a dial succeeds", async () => {
    /* A box whose hub is briefly away should be back in a second; a box whose
       hub is down for an hour must not spend that hour dialling. */
    /* Bounded on purpose: `wait` is immediate in these tests, so a connect
       that NEVER succeeds is an infinite loop rather than a slow one — which
       is how the first draft of this test hung the suite for ten minutes. The
       ladder is what is under test, so three refusals is enough to see it. */
    const h = listening({
      connect: (n) =>
        n <= 3
          ? Promise.reject(new Error("down"))
          : Promise.resolve(socket().it),
    });
    for (let i = 0; i < 8; i += 1) await settle();

    expect(h.waits.slice(0, 3)).toEqual([1_000, 2_000, 4_000]);
    h.listener.stop();
  });

  it("stops dialling once it is stopped, and stops SAYING it will", async () => {
    /**
     * The dial count alone did not test the guard it was written for.
     *
     * Two guards stand between a stopped listener and a reconnect — one in
     * `redial`, one inside the wait's callback — and the inner one alone keeps
     * the count flat. Deleting the outer guard passed this case, which made it
     * a test of the wrong thing.
     *
     * What the outer guard actually protects is the log: without it a stopped
     * listener announces a reconnect it will never make, which is the same
     * report-what-you-intended lie the `why` line exists to end.
     */
    const h = listening();
    await settle();
    h.listener.stop();
    const dialled = h.dials;
    const said = h.logs.length;

    h.wire.hangUp("1006");
    await settle();

    expect(h.dials, "a stopped listener kept reconnecting").toBe(dialled);
    expect(
      h.logs.slice(said).map((l) => l.message),
      "a stopped listener announced a reconnect it will never make",
    ).toEqual([]);
  });
});

describe("what keeps the process alive", () => {
  it("holds a handle of its own, rather than relying on the socket", async () => {
    /**
     * The whole crash-loop in one assertion. `byollm console-agent` parks on
     * `await new Promise(() => undefined)` — a promise that never settles and
     * references nothing, so it cannot keep Node running. The socket was doing
     * that by accident, and an accident that ends every time the socket closes
     * is what produced a restart every few seconds.
     */
    const h = listening();
    await settle();
    expect(h.keptAlive, "nothing deliberate is holding the loop open").toBe(1);
    expect(h.released).toBe(0);

    /* Still held across a disconnect — this is the exact moment the process
       used to exit. */
    h.wire.hangUp("1006");
    await settle();
    expect(h.released).toBe(0);

    h.listener.stop();
    expect(h.released, "a stopped listener must let the process end").toBe(1);
  });
});
