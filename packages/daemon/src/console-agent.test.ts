import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  CONSOLE_FRAME_VERSION as V,
  CONSOLE_MAX_DATA_BYTES,
  ConsoleFrame,
  consoleEnvelope,
  generateKeys,
  keyId,
  open,
  publicIdentityOf,
  seal,
  type SealedEnvelope,
} from "@byollm/protocol";
import {
  consoleSession,
  type ConsoleSessionRecord,
  type ConsoleShell,
} from "./console-agent.js";

const SESSION = "sess_console_1";
const DEADLINE = 4_000_000_000_000;

function fakeShell() {
  const wrote: Buffer[] = [];
  const sizes: [number, number][] = [];
  let killed = false;
  let emit: (chunk: Buffer) => void = () => undefined;
  let exit: (reason: string) => void = () => undefined;

  const shell: ConsoleShell = {
    write: (d) => {
      wrote.push(d);
    },
    resize: (c, r) => {
      sizes.push([c, r]);
    },
    onData: (h) => {
      emit = h;
    },
    onExit: (h) => {
      exit = h;
    },
    kill: () => {
      killed = true;
    },
  };
  return {
    shell,
    wrote,
    sizes,
    get killed() {
      return killed;
    },
    say: (s: string) => {
      emit(Buffer.from(s, "utf8"));
    },
    sayBytes: (b: Buffer) => {
      emit(b);
    },
    die: (why: string) => {
      exit(why);
    },
  };
}

/** A real peer: it seals what it sends and opens what it receives. */
function harness() {
  const box = generateKeys(1);
  const browserKeys = generateKeys(2);
  const browser = publicIdentityOf(browserKeys);
  const shell = fakeShell();
  const sent: SealedEnvelope[] = [];
  const records: ConsoleSessionRecord[] = [];
  const logs: { message: string; fields: Record<string, unknown> }[] = [];
  let sendFails = false;

  const session = consoleSession({
    sessionId: SESSION,
    deadlineAt: DEADLINE,
    keys: box,
    browser,
    shell: shell.shell,
    send: (e) => {
      if (sendFails) return Promise.reject(new Error("channel gone"));
      sent.push(e);
      return Promise.resolve();
    },
    record: (r) => {
      records.push(r);
      return Promise.resolve();
    },
    now: () => 1_700_000_000_000,
    log: (message, fields) => {
      logs.push({ message, fields: fields ?? {} });
    },
  });

  const fromBrowser = async (
    frame: unknown,
    as = browserKeys,
  ): Promise<void> => {
    const envelope = await seal({
      plaintext: JSON.stringify(frame),
      senderKeys: as,
      recipientEncryptionPublic: box.encryptionPublic,
      context: consoleEnvelope({
        sessionId: SESSION,
        from: "browser",
        senderKeyId: keyId(browser.identity),
        recipientKeyId: keyId(box.identityPublic),
        deadlineAt: DEADLINE,
      }),
    });
    await session.deliver(envelope);
  };

  const readSent = async (index: number): Promise<ConsoleFrame> => {
    const opened = await open({
      envelope: sent[index]!,
      recipientKeys: browserKeys,
      senderIdentityPublic: box.identityPublic,
      expected: {
        jobId: SESSION,
        senderKeyId: keyId(box.identityPublic),
        recipientKeyId: keyId(browser.identity),
        direction: "result",
      },
    });
    if (!opened.ok) throw new Error(`could not open: ${opened.reason}`);
    return ConsoleFrame.parse(JSON.parse(opened.plaintext));
  };

  const hello = {
    v: V,
    kind: "hello",
    seq: 1,
    browser,
    cols: 100,
    rows: 40,
  };

  return {
    session,
    shell,
    sent,
    records,
    logs,
    said: (part: string) => logs.filter((l) => l.message.includes(part)),
    fromBrowser,
    readSent,
    hello,
    browser,
    box,
    browserKeys,
    failSends: () => {
      sendFails = true;
    },
  };
}

const settle = () => new Promise((done) => setTimeout(done, 0));

describe("a console session, from the box's side", () => {
  it("starts on hello, sizes the pty, and records the start", async () => {
    const h = harness();
    await h.fromBrowser(h.hello);

    expect(h.shell.sizes).toEqual([[100, 40]]);
    expect(h.records).toEqual([
      { sessionId: SESSION, at: 1_700_000_000_000, event: "started" },
    ]);
  });

  it("types stdin into the shell", async () => {
    const h = harness();
    await h.fromBrowser(h.hello);
    await h.fromBrowser({
      v: V,
      kind: "stdin",
      seq: 2,
      data: Buffer.from("whoami\n").toString("base64"),
    });
    expect(Buffer.concat(h.shell.wrote).toString("utf8")).toBe("whoami\n");
  });

  it("seals the shell's output so the browser — and only it — can read it", async () => {
    const h = harness();
    await h.fromBrowser(h.hello);
    h.shell.say("you are root\n");
    await settle();

    const frame = await h.readSent(0);
    expect(frame.kind).toBe("stdout");
    if (frame.kind === "stdout") {
      expect(Buffer.from(frame.data, "base64").toString("utf8")).toBe(
        "you are root\n",
      );
      expect(frame.seq).toBe(1);
    }
  });

  it("splits a burst into frames instead of sending one the far end must refuse", async () => {
    const h = harness();
    await h.fromBrowser(h.hello);
    h.shell.sayBytes(Buffer.alloc(CONSOLE_MAX_DATA_BYTES + 100, 0x61));
    await settle();

    expect(h.sent.length).toBe(2);
    const first = await h.readSent(0);
    const second = await h.readSent(1);
    if (first.kind === "stdout" && second.kind === "stdout") {
      expect(Buffer.from(first.data, "base64").length).toBe(
        CONSOLE_MAX_DATA_BYTES,
      );
      expect(Buffer.from(second.data, "base64").length).toBe(100);
      expect(second.seq).toBe(first.seq + 1);
    }
  });

  it("resizes on a resize frame", async () => {
    const h = harness();
    await h.fromBrowser(h.hello);
    await h.fromBrowser({ v: V, kind: "resize", seq: 2, cols: 10, rows: 5 });
    expect(h.shell.sizes).toEqual([
      [100, 40],
      [10, 5],
    ]);
  });
});

describe("what ends a session, and what the owner is told", () => {
  it("names the fault when the router replays a frame", async () => {
    const h = harness();
    await h.fromBrowser(h.hello);
    const typed = {
      v: V,
      kind: "stdin",
      seq: 2,
      data: Buffer.from("rm -rf /\n").toString("base64"),
    };
    await h.fromBrowser(typed);
    await h.fromBrowser(typed);

    expect(h.session.ended).toBe("the console stream was replayed");
    expect(h.shell.killed).toBe(true);
    // And the replayed command was typed exactly once.
    expect(Buffer.concat(h.shell.wrote).toString("utf8")).toBe("rm -rf /\n");
  });

  it("names the fault when the router drops a frame", async () => {
    const h = harness();
    await h.fromBrowser(h.hello);
    await h.fromBrowser({ v: V, kind: "stdin", seq: 3, data: "aGk" });
    expect(h.session.ended).toBe("the console stream was gap");
  });

  it("ends when a frame is signed by a key that is not the pinned one", async () => {
    const h = harness();
    const impostor = generateKeys(3);
    await h.fromBrowser(h.hello, impostor);
    expect(h.session.ended).toBe(
      "a console frame did not verify (bad-signature)",
    );
    expect(h.records.some((r) => r.event === "started")).toBe(false);
  });

  it("ends when the hub announces one key and the browser speaks with another", async () => {
    /**
     * The hub hands the box the browser's identity at session start, and the
     * browser repeats it inside the sealed `hello`. This is the cross-check
     * between those two, and it is the only thing that catches a broker
     * describing a session differently to each end.
     */
    const h = harness();
    const other = publicIdentityOf(generateKeys(4));
    await h.fromBrowser({ ...h.hello, browser: other });
    expect(h.session.ended).toBe(
      "the console key announced was not the key that spoke",
    );
  });

  it("ends on bye, with the browser's own reason", async () => {
    const h = harness();
    await h.fromBrowser(h.hello);
    await h.fromBrowser({
      v: V,
      kind: "bye",
      seq: 2,
      reason: "you closed the tab",
    });
    expect(h.session.ended).toBe("you closed the tab");
    expect(h.records.at(-1)).toEqual({
      sessionId: SESSION,
      at: 1_700_000_000_000,
      event: "ended",
      reason: "you closed the tab",
    });
  });

  it("ends when the shell exits", async () => {
    const h = harness();
    await h.fromBrowser(h.hello);
    h.shell.die("the shell exited");
    await settle();
    expect(h.session.ended).toBe("the shell exited");
  });

  it("STILL records the end when the channel is already gone", async () => {
    /**
     * Ruling item 4 says EVERY session reaches the owner's feed. A `bye` that
     * cannot be delivered is the normal case — the tab is gone, that is why
     * the session is ending — so a feed that depended on the send succeeding
     * would be missing exactly the sessions that ended abruptly.
     */
    const h = harness();
    await h.fromBrowser(h.hello);
    h.failSends();
    await h.session.stop("the network dropped");

    expect(h.records.at(-1)).toEqual({
      sessionId: SESSION,
      at: 1_700_000_000_000,
      event: "ended",
      reason: "the network dropped",
    });
  });

  it("stays ended — a second stop does not write a second record", async () => {
    const h = harness();
    await h.fromBrowser(h.hello);
    await h.session.stop("first");
    await h.session.stop("second");
    expect(h.session.ended).toBe("first");
    expect(h.records.filter((r) => r.event === "ended").length).toBe(1);
  });

  it("sends nothing after `bye`, even if the pty is still talking", async () => {
    /**
     * `kill()` is not instantaneous — a pty can flush buffered output after
     * it. Without the guard those bytes become a `stdout` frame numbered
     * AFTER the `bye`, and the browser's own ordering rule refuses it as
     * `closed`: the session's last act would be to hand the far end a fault.
     *
     * Found by mutation: this guard survived every other case in this file.
     */
    const h = harness();
    await h.fromBrowser(h.hello);
    await h.session.stop("you closed the tab");
    const after = h.sent.length;

    h.shell.say("goodbye from the pty\n");
    await settle();

    expect(h.sent.length).toBe(after);
  });

  it("takes nothing after it has ended", async () => {
    const h = harness();
    await h.fromBrowser(h.hello);
    await h.session.stop("done");
    const before = h.shell.wrote.length;
    await h.fromBrowser({ v: V, kind: "stdin", seq: 2, data: "aGk" });
    expect(h.shell.wrote.length).toBe(before);
  });
});

describe("what a console session says about itself", () => {
  /* The box was the silent end. A browser could count frames it sent and got
     back; the box could say only that a session began and ended, so a console
     that received everything and answered nothing was indistinguishable from
     one that received nothing at all. These are that distinction. */

  it("counts both directions and reports them when the session ends", async () => {
    const h = harness();
    await h.fromBrowser(h.hello);
    await h.fromBrowser({ v: V, kind: "stdin", seq: 2, data: "YQ" });
    await h.fromBrowser({ v: V, kind: "stdin", seq: 3, data: "Yg" });
    h.shell.say("out");
    await settle();

    await h.session.stop("done");
    await settle();

    const ending = h.said("console session ending");
    expect(ending).toHaveLength(1);
    /* Two stdin frames in, one chunk out — the asymmetry is the point: a
       session that shows frames in and zero out has a shell that went quiet,
       not a channel that dropped them. */
    expect(ending[0]?.fields).toMatchObject({
      reason: "done",
      framesFromBrowser: 2,
      framesToBrowser: 1,
    });
  });

  it("tells a failed send apart from a closed channel", async () => {
    const h = harness();
    await h.fromBrowser(h.hello);
    await settle();
    h.failSends();
    h.shell.say("out");
    await settle();

    const failed = h.said("could not send output");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.fields).toMatchObject({ reason: "channel gone" });
    /* Both counters travel with the failure, because "we could not answer"
       means something different after twenty frames than after none. */
    expect(failed[0]?.fields["fromBrowser"]).toBe(0);
    expect(h.session.ended).toBe("the console channel closed");
  });

  it("reads a payload a shipped box would have sent", async () => {
    /* The shipped box encodes stdin's echo with the standard alphabet, and
       the browser reads base64url. Nothing in this file could tell, because
       both ends here were ours. `+`, `/` and padding are the disagreement. */
    const h = harness();
    await h.fromBrowser(h.hello);
    const bytes = Buffer.from([0xfb, 0xff, 0xbf, 0x0a]);
    await h.fromBrowser({
      v: V,
      kind: "stdin",
      seq: 2,
      data: bytes.toString("base64"),
    });
    await settle();

    expect(h.shell.wrote[0]).toEqual(bytes);
  });

  it("sends output a strict base64url reader can read", async () => {
    const h = harness();
    await h.fromBrowser(h.hello);
    h.shell.sayBytes(Buffer.from([0xfb, 0xff, 0xbf, 0x0a]));
    await settle();

    const frame = await h.readSent(0);
    expect(frame.kind).toBe("stdout");
    /* One typed character is one byte, which always pads — which is why the
       operator saw every keystroke's echo vanish and only some output. */
    if (frame.kind === "stdout") expect(frame.data).not.toMatch(/[+/=]/);
  });
});
