import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  consoleEnvelope,
  CONSOLE_FRAME_VERSION as V,
  generateKeys,
  keyId,
  publicIdentityOf,
  seal,
  signRequest,
} from "@byollm/protocol";
import { runConsoleAgent, type ConsoleSocket } from "./console-agent-main.js";
import type { ConsoleSessionRecord, ConsoleShell } from "./console-agent.js";
import { NoPtyError } from "./pty-shell.js";

/**
 * Let `runConsoleAgent` finish wiring before speaking to it.
 *
 * It awaits the shell and the socket before registering its handlers, so a
 * message delivered in the same tick as the call would land on nobody. With
 * a real WebSocket that window does not exist — the socket resolves inside
 * the `open` listener and the continuation runs as a microtask, before any
 * further I/O event can be dispatched — but these fakes resolve instantly and
 * would otherwise race it.
 */
const wired = () => new Promise((done) => setTimeout(done, 0));

const SESSION = "sess_main";
/** The runner this box is known by — the data door signs with it. */
const RUNNER = "runner-1";
const DEADLINE = 4_000_000_000_000;

function fakeSocket() {
  const sent: string[] = [];
  let closed = 0;
  let onMessage: (t: string) => void = () => undefined;
  let onClose: (r: string) => void = () => undefined;

  const socket: ConsoleSocket = {
    send: (t) => {
      sent.push(t);
    },
    onMessage: (h) => {
      onMessage = h;
    },
    onClose: (h) => {
      onClose = h;
    },
    close: () => {
      closed += 1;
    },
  };
  return {
    socket,
    sent,
    get closed() {
      return closed;
    },
    deliver: (t: string) => {
      onMessage(t);
    },
    hangUp: (r: string) => {
      onClose(r);
    },
  };
}

function fakeShell() {
  const shell: ConsoleShell = {
    write: () => undefined,
    resize: () => undefined,
    onData: () => undefined,
    onExit: () => undefined,
    kill: () => undefined,
  };
  return shell;
}

function setup() {
  const box = generateKeys(1);
  const browserKeys = generateKeys(2);
  const browser = publicIdentityOf(browserKeys);
  const socket = fakeSocket();
  const records: ConsoleSessionRecord[] = [];
  const logs: { message: string; fields: Record<string, unknown> }[] = [];

  const run = runConsoleAgent({
    runnerId: RUNNER,
    url: "wss://hub.example/console",
    sessionId: SESSION,
    deadlineAt: DEADLINE,
    keys: box,
    browser,
    command: "/bin/rsh",
    args: [],
    cwd: "/home/box",
    env: {},
    record: (entry) => {
      records.push(entry);
      return Promise.resolve();
    },
    now: () => 1_700_000_000_000,
    connect: () => Promise.resolve(socket.socket),
    openShell: () => Promise.resolve(fakeShell()),
    log: (message, fields) => {
      logs.push({ message, fields: fields ?? {} });
    },
  });

  const sealFrame = async (frame: unknown): Promise<string> =>
    JSON.stringify(
      await seal({
        plaintext: JSON.stringify(frame),
        senderKeys: browserKeys,
        recipientEncryptionPublic: box.encryptionPublic,
        context: consoleEnvelope({
          sessionId: SESSION,
          from: "browser",
          senderKeyId: keyId(browser.identity),
          recipientKeyId: keyId(box.identityPublic),
          deadlineAt: DEADLINE,
        }),
      }),
    );

  const hello = {
    v: V,
    kind: "hello",
    seq: 1,
    browser,
    cols: 80,
    rows: 24,
  };

  return { run, socket, records, sealFrame, hello, logs };
}

describe("running one console session end to end", () => {
  it("records the session and ends when the browser says bye", async () => {
    const s = setup();
    await wired();
    s.socket.deliver(await s.sealFrame(s.hello));
    await wired();
    s.socket.deliver(
      await s.sealFrame({
        v: V,
        kind: "bye",
        seq: 2,
        reason: "you closed the tab",
      }),
    );

    expect(await s.run).toBe("you closed the tab");
    expect(s.records.map((r) => r.event)).toEqual(["started", "ended"]);
    expect(s.socket.closed).toBe(1);
  });

  it("passes the log through to the session, or it is not wired at all", async () => {
    /* The option existed and nothing proved it arrived. An instrumentation
       hook that is accepted at the front door and dropped before the session
       is worse than none: it reports silence as evidence. */
    const s = setup();
    await wired();
    s.socket.deliver(await s.sealFrame(s.hello));
    await wired();
    s.socket.deliver(
      await s.sealFrame({ v: V, kind: "stdin", seq: 2, data: "YQ==" }),
    );
    await wired();
    s.socket.deliver(
      await s.sealFrame({ v: V, kind: "bye", seq: 3, reason: "done" }),
    );
    await s.run;

    const ending = s.logs.filter((l) =>
      l.message.includes("console session ending"),
    );
    expect(ending).toHaveLength(1);
    /* And it carries the counters, which is the only reason it is here: a
       session that ends having received frames and answered none is a
       different fault from one that received none. */
    expect(ending[0]?.fields).toMatchObject({
      reason: "done",
      framesFromBrowser: 1,
    });
  });

  it("ends when the broker hangs up", async () => {
    const s = setup();
    await wired();
    s.socket.hangUp("the console channel closed");
    expect(await s.run).toBe("the console channel closed");
  });

  it("does not trust the broker to send a well-formed envelope", async () => {
    /**
     * The broker is not trusted — that is the entire reason the stream is
     * sealed — so what it sends is PARSED, not cast. Garbage ends the session
     * rather than reaching the crypto as a half-shaped object.
     */
    const s = setup();
    await wired();
    s.socket.deliver("{not json at all");
    expect(await s.run).toBe("the broker sent something that was not a frame");
  });

  it("refuses a JSON message that is not an envelope", async () => {
    const s = setup();
    await wired();
    s.socket.deliver(JSON.stringify({ ciphertext: 12, direction: "sideways" }));
    expect(await s.run).toBe("the broker sent something that was not a frame");
  });

  it("sends the box's output as sealed text on the socket", async () => {
    const box = generateKeys(5);
    const browserKeys = generateKeys(6);
    const socket = fakeSocket();
    let emit: (b: Buffer) => void = () => undefined;

    const run = runConsoleAgent({
      runnerId: RUNNER,
      url: "wss://hub.example/console",
      sessionId: SESSION,
      deadlineAt: DEADLINE,
      keys: box,
      browser: publicIdentityOf(browserKeys),
      command: "/bin/rsh",
      args: [],
      cwd: "/",
      env: {},
      record: () => Promise.resolve(),
      connect: () => Promise.resolve(socket.socket),
      openShell: () =>
        Promise.resolve({
          write: () => undefined,
          resize: () => undefined,
          onData: (h: (c: Buffer) => void) => {
            emit = h;
          },
          onExit: () => undefined,
          kill: () => undefined,
        }),
    });

    await wired();
    emit(Buffer.from("hello from the box\n", "utf8"));
    await wired();

    expect(socket.sent.length).toBe(1);
    const parsed = JSON.parse(socket.sent[0]!) as { ciphertext?: string };
    expect(typeof parsed.ciphertext).toBe("string");
    // Sealed, so the plaintext must NOT be recoverable from the wire text.
    expect(socket.sent[0]).not.toContain("hello from the box");

    socket.hangUp("done");
    await run;
  });
});

describe("when there is no pty on this machine", () => {
  it("fails before opening a socket, so nothing is dialled for nothing", async () => {
    const socket = fakeSocket();
    await expect(
      runConsoleAgent({
        runnerId: RUNNER,
        url: "wss://hub.example/console",
        sessionId: SESSION,
        deadlineAt: DEADLINE,
        keys: generateKeys(7),
        browser: publicIdentityOf(generateKeys(8)),
        command: "/bin/rsh",
        args: [],
        cwd: "/",
        env: {},
        record: () => Promise.resolve(),
        connect: () => Promise.resolve(socket.socket),
        openShell: () => Promise.reject(new NoPtyError()),
      }),
    ).rejects.toThrow(NoPtyError);

    expect(socket.sent).toEqual([]);
    expect(socket.closed).toBe(0);
  });
});

/**
 * **The data door is authenticated, and this dialer sent nothing.**
 *
 * Attempt six, 2026-09-17. `.97` taught the CONTROL socket to sign and the box
 * finally held a connection and received an announcement — five releases of
 * dead air ended in one line. Then the agent dialled the DATA socket with
 * `new WebSocket(url)`, bare, at a door that demands runner, issued-at and a
 * signature over the session id and refuses 401 before the handshake.
 *
 * The sibling of never-dialed, and its exact inverse: there the production
 * default was missing, here it exists and cannot succeed. Every test in this
 * file injected `connect` and therefore never asked what the real one sends —
 * the same blindness, one door along, which is why CW's review rule #3 gained
 * a second clause: naming the production caller is not enough, the production
 * DEFAULT has to be exercised too.
 */
describe("what the agent presents at the data door", () => {
  it("signs the dial, over the session it is joining", async () => {
    const keys = generateKeys(7);
    const seen: Record<string, string>[] = [];
    const socket = fakeSocket();

    /* Deliberately not awaited: the agent runs until the session ends, and
       what this test wants is the DIAL it makes on the way in. Errors are
       caught so a rejection cannot surface as an unhandled one. */
    runConsoleAgent({
      runnerId: RUNNER,
      url: "wss://hub.example/console/box?session=sess_1",
      sessionId: SESSION,
      deadlineAt: 4_000_000_000_000,
      keys,
      browser: publicIdentityOf(generateKeys(8)),
      command: "/bin/sh",
      args: [],
      cwd: "/",
      env: {},
      record: () => Promise.resolve(),
      connect: (_url, headers) => {
        seen.push(headers);
        return Promise.resolve(socket.socket);
      },
      openShell: () => Promise.resolve(fakeShell()),
    }).catch(() => undefined);

    await new Promise((done) => setTimeout(done, 0));

    const headers = seen[0];
    expect(
      headers,
      "the dialer sent no headers at an authenticated door",
    ).toBeDefined();
    expect(headers?.["x-byollm-runner"]).toBe(RUNNER);
    expect(headers?.["x-byollm-signature"]).toBeTruthy();
    expect(Number(headers?.["x-byollm-issued-at"])).toBeGreaterThan(0);
  });

  it("signs over the SESSION, not the endpoint — so one dial cannot join another", async () => {
    /**
     * This test's first draft called `signRequest` twice and compared the
     * results. That proves the crypto is a function of its input and says
     * NOTHING about what the agent chose to sign — a mutation swapping the
     * body to the endpoint passed it cleanly.
     *
     * So it now takes the signature the agent actually emitted and asks which
     * body produces it. The control socket signs over its own endpoint because
     * there is no session yet; this door must sign over the session, or a
     * signature captured from one console is replayable to join another.
     */
    const keys = generateKeys(11);
    const seen: Record<string, string>[] = [];
    const socket = fakeSocket();

    /* Deliberately not awaited: the agent runs until the session ends, and
       what this test wants is the DIAL it makes on the way in. Errors are
       caught so a rejection cannot surface as an unhandled one. */
    runConsoleAgent({
      runnerId: RUNNER,
      url: "wss://hub.example/console/box?session=sess_1",
      sessionId: SESSION,
      deadlineAt: 4_000_000_000_000,
      keys,
      browser: publicIdentityOf(generateKeys(12)),
      command: "/bin/sh",
      args: [],
      cwd: "/",
      env: {},
      record: () => Promise.resolve(),
      now: () => 1_000,
      connect: (_url, headers) => {
        seen.push(headers);
        return Promise.resolve(socket.socket);
      },
      openShell: () => Promise.resolve(fakeShell()),
    }).catch(() => undefined);
    await new Promise((done) => setTimeout(done, 0));

    const sent = seen[0]?.["x-byollm-signature"];
    const overSession = signRequest(keys, {
      endpoint: "/console/box",
      runnerId: RUNNER,
      issuedAt: 1_000,
      body: SESSION,
    }).signature;
    const overEndpoint = signRequest(keys, {
      endpoint: "/console/box",
      runnerId: RUNNER,
      issuedAt: 1_000,
      body: "/console/box",
    }).signature;

    expect(sent).toBe(overSession);
    expect(
      sent,
      "signed over the endpoint — one session's dial would join another",
    ).not.toBe(overEndpoint);
  });
});
