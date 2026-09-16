import { describe, expect, it } from "vitest";
import {
  CONSOLE_FRAME_VERSION,
  CONSOLE_MAX_DATA_BYTES,
  ConsoleFrame,
  consoleEnvelope,
  consoleOrder,
} from "./console.js";
import { generateKeys, publicIdentityOf } from "./keys.js";
import { open, seal } from "./envelope.js";

const v = CONSOLE_FRAME_VERSION;
const stdin = (seq: number, data = "aGk") => ({ v, kind: "stdin", seq, data });
const stdout = (seq: number, data = "aGk") => ({
  v,
  kind: "stdout",
  seq,
  data,
});

const hello = (browserIdentity: ReturnType<typeof publicIdentityOf>) => ({
  v,
  kind: "hello" as const,
  seq: 1 as const,
  browser: browserIdentity,
  cols: 80,
  rows: 24,
});

const browserKeys = generateKeys(Date.now());
const helloFrame = hello(publicIdentityOf(browserKeys));

describe("what a console frame is allowed to be", () => {
  it("accepts the four kinds and refuses an unknown one", () => {
    expect(ConsoleFrame.safeParse(helloFrame).success).toBe(true);
    expect(ConsoleFrame.safeParse(stdin(2)).success).toBe(true);
    expect(ConsoleFrame.safeParse(stdout(1)).success).toBe(true);
    expect(
      ConsoleFrame.safeParse({ v, kind: "bye", seq: 9, reason: "you left" })
        .success,
    ).toBe(true);
    expect(ConsoleFrame.safeParse({ v, kind: "exec", seq: 1 }).success).toBe(
      false,
    );
  });

  it("refuses an unknown field, because strict is the rule everywhere", () => {
    expect(ConsoleFrame.safeParse({ ...stdin(2), sudo: true }).success).toBe(
      false,
    );
  });

  it("caps a frame's data well below the envelope limit", () => {
    const tooBig = "a".repeat(
      Math.ceil((CONSOLE_MAX_DATA_BYTES * 4) / 3) + 100,
    );
    expect(ConsoleFrame.safeParse({ ...stdin(2), data: tooBig }).success).toBe(
      false,
    );
  });

  it("pins the version tag, so a v2 frame cannot be read as a v1 one", () => {
    expect(
      ConsoleFrame.safeParse({ ...stdin(2), v: "byollm/v2/console" }).success,
    ).toBe(false);
  });
});

describe("the ordering rule, which is what the hub could otherwise break", () => {
  it("takes a clean browser stream", () => {
    const order = consoleOrder("browser");
    expect(order.accept(helloFrame as never).ok).toBe(true);
    expect(order.accept(stdin(2) as never).ok).toBe(true);
    expect(order.accept(stdin(3) as never).ok).toBe(true);
    expect(order.seen).toBe(3);
  });

  it("catches a replayed frame", () => {
    const order = consoleOrder("browser");
    order.accept(helloFrame as never);
    order.accept(stdin(2) as never);
    expect(order.accept(stdin(2) as never)).toEqual({
      ok: false,
      fault: "replayed",
    });
  });

  it("catches a DROPPED frame, which merely-increasing would not", () => {
    /**
     * The reason the rule is strictly +1. A router that removes one frame
     * leaves every remaining envelope opening and verifying perfectly — the
     * loss is invisible to the crypto, and on a terminal it is a truncated
     * command that still runs.
     */
    const order = consoleOrder("browser");
    order.accept(helloFrame as never);
    expect(order.accept(stdin(3) as never)).toEqual({
      ok: false,
      fault: "gap",
    });
  });

  it("catches a reorder", () => {
    const order = consoleOrder("browser");
    order.accept(helloFrame as never);
    order.accept(stdin(2) as never);
    order.accept(stdin(3) as never);
    expect(order.accept(stdin(2) as never).ok).toBe(false);
  });

  it("refuses stdout from the browser and stdin from the box", () => {
    const fromBrowser = consoleOrder("browser");
    fromBrowser.accept(helloFrame as never);
    expect(fromBrowser.accept(stdout(2) as never)).toEqual({
      ok: false,
      fault: "wrong-way",
    });

    const fromBox = consoleOrder("box");
    expect(fromBox.accept(stdin(1) as never)).toEqual({
      ok: false,
      fault: "wrong-way",
    });
  });

  it("refuses a resize from the BOX — the browser drives the size", () => {
    /**
     * CW's review nit. The old rule named stdin and stdout and was silent on
     * every other kind, so `resize` travelled both ways unchecked and the
     * browser would have had to decide what a box-sent resize meant. The rule
     * is now a list of what each side may send, which has no default to
     * forget when a kind is added.
     */
    const order = consoleOrder("box");
    expect(order.accept(stdout(1) as never).ok).toBe(true);
    expect(
      order.accept({ v, kind: "resize", seq: 2, cols: 1, rows: 1 } as never),
    ).toEqual({ ok: false, fault: "wrong-way" });
  });

  it("lets the browser resize, and lets either side say bye", () => {
    const browser = consoleOrder("browser");
    browser.accept(helloFrame as never);
    expect(
      browser.accept({ v, kind: "resize", seq: 2, cols: 90, rows: 30 } as never)
        .ok,
    ).toBe(true);
    expect(
      browser.accept({ v, kind: "bye", seq: 3, reason: "left" } as never).ok,
    ).toBe(true);

    const box = consoleOrder("box");
    expect(
      box.accept({ v, kind: "bye", seq: 1, reason: "shell exited" } as never)
        .ok,
    ).toBe(true);
  });

  it("refuses a second hello — a new browser key mid-stream is the substitution", () => {
    const order = consoleOrder("browser");
    order.accept(helloFrame as never);
    order.accept(stdin(2) as never);
    expect(order.accept({ ...helloFrame, seq: 3 } as never)).toEqual({
      ok: false,
      fault: "out-of-turn",
    });
  });

  it("refuses a browser stream that does not open with hello", () => {
    const order = consoleOrder("browser");
    expect(order.accept(stdin(1) as never)).toEqual({
      ok: false,
      fault: "out-of-turn",
    });
  });

  it("lets the BOX open with stdout, because hello is the browser's alone", () => {
    /**
     * The asymmetry, as its own case. Treating the two directions as mirror
     * images was this rule's first bug, and a symmetric rule rejects every
     * real box stream at its very first frame — so the failure would have
     * been total rather than subtle, and still would not have been caught by
     * any test above this one.
     */
    const order = consoleOrder("box");
    expect(order.accept(stdout(1) as never).ok).toBe(true);
    expect(order.accept(stdout(2) as never).ok).toBe(true);
  });

  it("refuses a hello from the box — as a kind it may not send at all", () => {
    /**
     * `wrong-way` rather than `out-of-turn`, and that is the stricter answer:
     * the box may not send `hello` in ANY position, so it is refused by kind
     * before position is even considered. Before the allowed-list it was
     * caught only because it arrived first.
     */
    const order = consoleOrder("box");
    expect(order.accept(helloFrame as never)).toEqual({
      ok: false,
      fault: "wrong-way",
    });
    order.accept(stdout(1) as never);
    expect(order.accept({ ...helloFrame, seq: 2 } as never)).toEqual({
      ok: false,
      fault: "wrong-way",
    });
  });

  it("ends at bye and takes nothing after it", () => {
    const order = consoleOrder("box");
    order.accept(stdout(1) as never);
    expect(
      order.accept({ v, kind: "bye", seq: 2, reason: "session over" } as never)
        .ok,
    ).toBe(true);
    expect(order.accept(stdout(3) as never)).toEqual({
      ok: false,
      fault: "closed",
    });
  });
});

describe("a console frame travels as a job payload does", () => {
  it("seals browser→box and opens with the box's pinned identity", async () => {
    const box = generateKeys(Date.now());
    const sessionId = "sess_1";
    const deadlineAt = Date.now() + 60_000;

    const context = consoleEnvelope({
      sessionId,
      from: "browser",
      senderKeyId: "browser-1",
      recipientKeyId: "box-1",
      deadlineAt,
    });
    expect(context.direction).toBe("payload");
    expect(context.jobId).toBe(sessionId);

    const envelope = await seal({
      plaintext: JSON.stringify(stdin(2)),
      senderKeys: browserKeys,
      recipientEncryptionPublic: box.encryptionPublic,
      context,
    });

    const opened = await open({
      envelope,
      recipientKeys: box,
      senderIdentityPublic: browserKeys.identityPublic,
      expected: {
        jobId: sessionId,
        senderKeyId: "browser-1",
        recipientKeyId: "box-1",
        direction: "payload",
      },
    });
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(ConsoleFrame.parse(JSON.parse(opened.plaintext))).toEqual(
        stdin(2),
      );
    }
  });

  it("the box's answer travels the other direction, not the same one", () => {
    /**
     * If both directions shared a direction tag, a frame the box sent could be
     * replayed back INTO the box as though the browser had typed it. The
     * envelope's direction is what stops that, and this asserts the two calls
     * actually differ rather than assuming they do.
     */
    const toBox = consoleEnvelope({
      sessionId: "s",
      from: "browser",
      senderKeyId: "a",
      recipientKeyId: "b",
      deadlineAt: 1,
    });
    const toBrowser = consoleEnvelope({
      sessionId: "s",
      from: "box",
      senderKeyId: "b",
      recipientKeyId: "a",
      deadlineAt: 1,
    });
    expect(toBox.direction).toBe("payload");
    expect(toBrowser.direction).toBe("result");
    expect(toBox.direction).not.toBe(toBrowser.direction);
  });
});
