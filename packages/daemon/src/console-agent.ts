import { Buffer } from "node:buffer";
import {
  ConsoleFrame,
  CONSOLE_FRAME_VERSION,
  CONSOLE_MAX_DATA_BYTES,
  consoleDataBytes,
  consoleEnvelope,
  consoleOrder,
  encodeConsoleData,
  keyId,
  open,
  seal,
  verifyPublicIdentity,
  type PublicIdentity,
  type SealedEnvelope,
  type StoredKeys,
} from "@byollm/protocol";

/**
 * The box side of a console session — byollm_018 §"Console redesign: brokered
 * E2E replaces SSH-first (RULED, Todd 2026-09-03)".
 *
 * ## What this can prove, and what it cannot — read this before hardening it
 *
 * The stream is sealed with `crypto_box_seal`, which is **anonymous**
 * encryption: the box's encryption key is public, so ANYONE who can reach the
 * box can produce a frame it will decrypt. The box therefore cannot tell the
 * owner's browser from the broker on cryptography alone, and no amount of
 * work here changes that — what authorises a session is the hub's grant, and
 * the hub is the party issuing it.
 *
 * That is not a gap in this implementation. It is the ruling's own finding,
 * reached before any of this was designed: *"every hosted console is
 * operator-ACCOUNTABLE, not operator-incapable — the control plane that mints
 * access can always mint access, and true 'cannot' on hardware we operate is
 * attestation (B2), not software. We build the accountable version, then say
 * exactly that."* Item 4's session feed is where the accountability is paid,
 * which is why {@link ConsoleSessionDeps.record} is not optional.
 *
 * **So do not add a check here that pretends otherwise.** A guarantee the
 * architecture cannot keep is worse than the honest copy we ship, because the
 * copy is what a customer reads.
 *
 * ## What it CAN prove, and does
 *
 * Within one session, continuity. The hub announces the browser's ephemeral
 * identity at session start; this agent pins it for the session's life and
 * verifies every frame against it, including the `hello`. After that first
 * frame nobody can splice into the stream — not another tab, not the hub —
 * without the signature failing. And `hello` carries the browser's identity
 * a second time, SEALED, so a hub that announces one key while a browser
 * speaks with another is caught rather than silently tolerated.
 *
 * Plus everything `consoleOrder` gives: no drops, no reordering, no replay,
 * checked inside the ciphertext where the router cannot reach.
 */

/** What the session writes to the owner's feed. Ruling item 4. */
export interface ConsoleSessionRecord {
  readonly sessionId: string;
  readonly at: number;
  readonly event: "started" | "ended";
  /** Present on `ended`. A sentence, because an owner reads it. */
  readonly reason?: string;
}

/** The pty side, kept abstract so the pump is testable without one. */
export interface ConsoleShell {
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  /**
   * Subscribe to the shell's output.
   *
   * **Whatever the shell produced before this was called must be delivered
   * here.** A pty starts producing at spawn and the console does not build
   * its session until a socket is up, so a shell's greeting and its first
   * prompt — the only signal that it is safe to type — land in that window.
   * An implementation that subscribes lazily drops them and shows an
   * operator an empty pane. See `pty-shell.test.ts`, which holds this to it.
   */
  onData(handler: (chunk: Buffer) => void): void;
  onExit(handler: (reason: string) => void): void;
  kill(): void;
}

export interface ConsoleSessionDeps {
  readonly sessionId: string;
  /** When this session's envelopes stop being valid. */
  readonly deadlineAt: number;
  /** The box's own keys — the pairing identity, per the 09-16 delta call. */
  readonly keys: StoredKeys;
  /**
   * The browser's ephemeral identity, as announced by the hub at session
   * start. Pinned for this session and cross-checked against `hello`.
   */
  readonly browser: PublicIdentity;
  readonly shell: ConsoleShell;
  /** Send one sealed envelope to the hub. */
  send(envelope: SealedEnvelope): Promise<void>;
  /** Ruling item 4: EVERY session, including any we ever open ourselves. */
  record(entry: ConsoleSessionRecord): Promise<void>;
  /**
   * What the agent did with each frame — the box's half of `?debug=1`.
   *
   * Separate from {@link record}, which is the OWNER's feed and says only that
   * a session began and ended. This says what happened inside one, and the
   * distinction matters: today a session sat open for five minutes producing
   * nothing while the browser sent twenty-eight frames into it, and neither
   * end could say whether they arrived. The browser had counters by then; this
   * side had none.
   *
   * Kinds and counts, never contents — the frames carry somebody's shell.
   */
  log?:
    ((message: string, fields?: Record<string, unknown>) => void) | undefined;
  now(): number;
}

export interface ConsoleSession {
  /** Feed one envelope that arrived from the hub. */
  deliver(envelope: SealedEnvelope): Promise<void>;
  /** End the session and tell the other end why. */
  stop(reason: string): Promise<void>;
  /** Why the session ended, or undefined while it runs. */
  readonly ended: string | undefined;
}

/**
 * Start a console session.
 *
 * Nothing here starts on its own: this is reached from an explicit
 * subcommand the box's supervisor launches, never from `byollm run`. A
 * capability that lets a remote broker drive a pty should be absent from a
 * laptop daemon's behaviour, not merely disabled in it.
 */
export function consoleSession(deps: ConsoleSessionDeps): ConsoleSession {
  const inbound = consoleOrder("browser");
  /* Counted so a session that goes quiet can say whether it stopped RECEIVING
     or stopped ANSWERING — two different faults that look identical from a
     browser, and the ambiguity that cost this afternoon. */
  /* Bound once rather than called through `?.` at each site: two optional
     calls are two arms apiece, and the arm where nobody is listening is the
     one a test forgets. One default, exercised both ways. */
  const log = deps.log ?? (() => undefined);
  let fromBrowser = 0;
  let toBrowser = 0;
  const boxKeyId = keyId(deps.keys.identityPublic);
  const browserKeyId = keyId(deps.browser.identity);

  let outSeq = 0;
  let ended: string | undefined;
  let started = false;

  const sealTo = async (frame: ConsoleFrame): Promise<void> => {
    const envelope = await seal({
      plaintext: JSON.stringify(frame),
      senderKeys: deps.keys,
      recipientEncryptionPublic: deps.browser.encryption,
      context: consoleEnvelope({
        sessionId: deps.sessionId,
        from: "box",
        senderKeyId: boxKeyId,
        recipientKeyId: browserKeyId,
        deadlineAt: deps.deadlineAt,
      }),
    });
    await deps.send(envelope);
  };

  const finish = async (reason: string): Promise<void> => {
    if (ended !== undefined) return;
    ended = reason;
    /* One line per session saying what actually moved. A console that ends
       having received frames and sent none is a different fault from one that
       received none at all, and from a browser they look the same. */
    log("console session ending", {
      reason,
      framesFromBrowser: fromBrowser,
      framesToBrowser: toBrowser,
    });
    deps.shell.kill();
    // The record is written even if telling the browser fails — the owner's
    // feed is the thing that must not have a hole in it.
    try {
      outSeq += 1;
      await sealTo({
        v: CONSOLE_FRAME_VERSION,
        kind: "bye",
        seq: outSeq,
        reason,
      });
    } catch {
      // The channel is already gone; that is what most `bye`s mean.
    }
    await deps.record({
      sessionId: deps.sessionId,
      at: deps.now(),
      event: "ended",
      reason,
    });
  };

  deps.shell.onData((chunk) => {
    if (ended !== undefined) return;
    // Split at the frame cap rather than sending one oversized frame the far
    // end is obliged to refuse — a burst of output is normal, not an attack.
    for (let at = 0; at < chunk.length; at += CONSOLE_MAX_DATA_BYTES) {
      const slice = chunk.subarray(at, at + CONSOLE_MAX_DATA_BYTES);
      outSeq += 1;
      toBrowser += 1;
      void sealTo({
        v: CONSOLE_FRAME_VERSION,
        kind: "stdout",
        seq: outSeq,
        data: encodeConsoleData(slice),
      }).catch((cause: unknown) => {
        /* Was "the console channel closed", flatly, whatever happened — the
           same sentence the socket's own onClose uses, so a failed SEAL and a
           closed SOCKET were one message with two causes and no way to tell
           them apart in a log. */
        log("could not send output to the browser", {
          reason: cause instanceof Error ? cause.message : String(cause),
          fromBrowser,
          toBrowser,
        });
        /* Returned, not voided: the caller already voids the chain, and the
           catch handler owns the shutdown it starts. */
        return finish("the console channel closed");
      });
    }
  });

  deps.shell.onExit((reason) => void finish(reason));

  return {
    get ended() {
      return ended;
    },

    async stop(reason: string) {
      await finish(reason);
    },

    async deliver(envelope: SealedEnvelope) {
      if (ended !== undefined) return;

      const opened = await open({
        envelope,
        recipientKeys: deps.keys,
        senderIdentityPublic: deps.browser.identity,
        expected: {
          jobId: deps.sessionId,
          senderKeyId: browserKeyId,
          recipientKeyId: boxKeyId,
          direction: "payload",
        },
      });
      if (!opened.ok) {
        await finish(`a console frame did not verify (${opened.reason})`);
        return;
      }

      const parsed = ConsoleFrame.safeParse(
        JSON.parse(opened.plaintext) as unknown,
      );
      if (!parsed.success) {
        await finish("a console frame was not a console frame");
        return;
      }
      const frame = parsed.data;

      const order = inbound.accept(frame);
      if (!order.ok) {
        // Named in the reason, because these are the four things a router can
        // do to a stream it cannot read, and an owner reading the feed after
        // a dropped session deserves to know which one happened.
        await finish(`the console stream was ${order.fault}`);
        return;
      }

      switch (frame.kind) {
        case "hello": {
          // The hub told us this key; the browser now tells us the same key
          // from inside the ciphertext. Disagreement means the two are not
          // talking about the same browser.
          const same =
            frame.browser.identity === deps.browser.identity &&
            frame.browser.encryption === deps.browser.encryption &&
            frame.browser.encryptionSig === deps.browser.encryptionSig;
          if (!same || !verifyPublicIdentity(frame.browser)) {
            await finish(
              "the console key announced was not the key that spoke",
            );
            return;
          }
          deps.shell.resize(frame.cols, frame.rows);
          started = true;
          await deps.record({
            sessionId: deps.sessionId,
            at: deps.now(),
            event: "started",
          });
          return;
        }
        case "stdin":
          /* Unreachable, and left explicit for the same reason `stdout` below
             is: every path that leaves `started` false also ends the session,
             and `deliver` returns at the door once it has. Keeping the guard
             costs nothing; making it SPEAK would have been a log line for a
             case that cannot happen, which is how a silent drop gets looked
             for in the wrong place. The keystrokes really were vanishing —
             see `decodeConsoleData`, which is where. */
          if (!started) return;
          fromBrowser += 1;
          deps.shell.write(Buffer.from(consoleDataBytes(frame.data)));
          return;
        case "resize":
          if (!started) return; // Unreachable; see `stdin` above.
          fromBrowser += 1;
          deps.shell.resize(frame.cols, frame.rows);
          return;
        case "stdout":
          // `consoleOrder` already refuses this as `wrong-way`; unreachable,
          // and left explicit so a future kind cannot fall through silently.
          await finish("the console stream was wrong-way");
          return;
        case "bye":
          await finish(frame.reason);
          return;
      }
    },
  };
}
