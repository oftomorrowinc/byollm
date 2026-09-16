import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  consoleEnvelope,
  CONSOLE_FRAME_VERSION as V,
  generateKeys,
  keyId,
  publicIdentityOf,
  seal,
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

  const run = runConsoleAgent({
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

  return { run, socket, records, sealFrame, hello };
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
