import { z } from "zod";
import { fromBase64Url, toBase64Url } from "./envelope-format.js";
import { PublicIdentity } from "./public-identity.js";
import type { EnvelopeContext } from "./envelope.js";

/**
 * The terminal stream a hosted box's console runs over — byollm_018 §"Console
 * redesign: brokered E2E replaces SSH-first (RULED, Todd 2026-09-03)".
 *
 * The ruling's item 3 is the whole reason this file exists: *"The terminal
 * stream is E2E encrypted browser↔agent with the sealed-channel pattern jobs
 * use; the hub routes ciphertext."* So the bytes are carried by
 * {@link seal}/{@link open} exactly as a job's payload is, and what is defined
 * here is the thing a sealed envelope does not carry: **what a frame means,
 * and where it sits in the stream.**
 *
 * ## Why an ordering rule is protocol and not an implementation detail
 *
 * Sealing makes the hub unable to READ the stream. It does nothing to make
 * the hub unable to reshape it. A router that holds ciphertext can drop a
 * frame, deliver two out of order, or send the same frame twice, and every
 * envelope still opens, still verifies against the pinned identity, and still
 * looks perfect to the receiver — because each envelope is authenticated on
 * its own and says nothing about the ones around it.
 *
 * On a terminal that is not a theoretical loss of tidiness. A dropped
 * keystroke is a different command; two frames swapped is a different command;
 * a replayed frame is a command run twice. The console carries vendor
 * sign-in flows (byollm_018 item 5), so "a different command" can mean an auth
 * code going somewhere it was not typed.
 *
 * Hence {@link consoleOrder}: a sequence inside the ciphertext, checked by
 * both ends. Inside, because a counter the hub could see is a counter the hub
 * could rewrite.
 *
 * ## One definition, both ends, and there are three ends
 *
 * The browser, the box's agent, and the hub broker all handle these frames,
 * and the first two must agree byte for byte or the stream silently corrupts.
 * The hub must NOT be able to agree — it only ever sees the sealed envelope.
 * This module is the single definition the two real ends share; neither
 * retypes it.
 *
 * ## The pinned box key is the PAIRING key (CCB's call, 09-16)
 *
 * The ruling says "box key pinned at first session", and the backlog left one
 * delta open: whether the identity the owner already approved at pairing can
 * serve as that pinned key. It can, and it should, for three reasons.
 *
 * 1. **The pairing key is the only one a human ever chose.** `PairStartRequest`
 *    carries the device's {@link PublicIdentity} and says why: *"Pairing is
 *    where the two parties learn each other's identities, because it is the
 *    one moment a human is already deciding to trust: the approval click. A
 *    key exchanged anywhere else would be a key nobody chose."* A fresh
 *    trust-on-first-use pin at the first console session is precisely a key
 *    nobody chose — it trusts whoever answers first, which on a brokered
 *    channel is whoever the broker points at.
 * 2. **Two pins of one box can disagree, and silently.** A console pin
 *    separate from the pairing pin is a second record of the same fact, which
 *    is this project's most-repeated defect. When they diverge, nothing reads
 *    both, so nothing notices.
 * 3. **Alarm-on-change comes free from the split already in `keys.ts`.** The
 *    Ed25519 identity is the pinned half and the X25519 encryption key is
 *    signed by it, so {@link verifyPublicIdentity} lets the box rotate its
 *    encryption key without a new ceremony while an IDENTITY change fails to
 *    verify and alarms — which is what the ruling asks for, and it is already
 *    written.
 *
 * **What this does not claim.** Pinning the pairing key does not make the hub
 * unable to lie about which key that was; the hub is the one telling the
 * browser. The ruling is explicit that we build the operator-ACCOUNTABLE
 * version, not the operator-incapable one, and item 4's session feed is where
 * that accountability is paid. What the pin buys is that a CHANGE is
 * detectable, and that the key being pinned is one an owner approved rather
 * than one a broker supplied.
 */

/** Domain tag for the plaintext inside a console envelope. */
export const CONSOLE_FRAME_VERSION = "byollm/v1/console";

/**
 * The largest `data` payload one frame may carry, before base64.
 *
 * Far below {@link MAX_ENVELOPE_BYTES}, and deliberately: an envelope cap
 * stops a memory attack, while this stops a latency one. A console is
 * interactive, so a peer that batches a megabyte into one frame has made the
 * stream unusable without ever exceeding a limit.
 */
export const CONSOLE_MAX_DATA_BYTES = 64 * 1024;

/**
 * Encode one frame's payload. Canonical, and the only encoder either end may
 * use — see {@link decodeConsoleData} for what retyping it cost.
 */
export function encodeConsoleData(bytes: Uint8Array): string {
  return toBase64Url(bytes);
}

/**
 * Decode one frame's payload, accepting either base64 alphabet.
 *
 * The two alphabets disagree on three characters — `+`, `/`, and the `=`
 * padding — and a box that encoded with Node's standard base64 produced
 * frames that sealed, opened, verified against the pinned identity, and
 * ordered correctly, and then decoded to nothing in a strict base64url
 * reader. Nothing faulted, because a decode that returns nothing is not a
 * fault anywhere in this file. What an operator saw was a console that ate
 * every keystroke and roughly two output chunks in three: one typed character
 * is one byte, which always pads, while a longer chunk survives exactly when
 * its length is a multiple of three and its bytes happen to avoid `+` and `/`.
 *
 * So the tolerance here is deliberate, not lax. A box is software on someone
 * else's machine, and a browser that accepted only the canonical spelling
 * would fix the console for whoever upgraded and for nobody else. Anything
 * that is neither spelling still returns `undefined`, and {@link ConsoleFrame}
 * rejects it at the schema so it fails loudly rather than vanishing.
 */
export function decodeConsoleData(text: string): Uint8Array | undefined {
  /* Base64 pads to a multiple of four with at most two `=`. More than two is
     not a lenient spelling of anything, so it falls through and is refused. */
  const padding = /(={0,2})$/.exec(text)?.[1]?.length ?? 0;
  const body = text.slice(0, text.length - padding);
  return fromBase64Url(body.replace(/\+/g, "-").replace(/\//g, "_"));
}

const data = z
  .string()
  .max(Math.ceil((CONSOLE_MAX_DATA_BYTES * 4) / 3) + 4)
  /* A law with a check. This field spent its whole life described as base64
     and validated as nothing, which is why a box could disagree with a
     browser about what it was sending and no test anywhere could tell. */
  .refine((text) => decodeConsoleData(text) !== undefined, {
    message: "not base64",
  });

/** Terminal geometry. Bounded because a pty rejects absurd sizes anyway. */
const cols = z.number().int().min(1).max(10_000);
const rows = z.number().int().min(1).max(10_000);

/**
 * A frame's position in its direction's stream. Starts at 1, never repeats,
 * never skips — see {@link consoleOrder} for what each of those catches.
 */
const seq = z.number().int().positive();

export const ConsoleHello = z
  .object({
    v: z.literal(CONSOLE_FRAME_VERSION),
    kind: z.literal("hello"),
    seq: z.literal(1),
    /**
     * The browser's EPHEMERAL identity for this session, and the reason hello
     * exists as its own frame.
     *
     * A browser has no long-term key — it is a tab, not a machine — so it
     * generates one per session and the box seals its output to it. That key
     * has to reach the box without the hub being able to substitute one of its
     * own, which is the classic broker attack. So it travels SEALED TO THE
     * BOX'S PINNED IDENTITY like every other frame: the hub cannot read it and
     * cannot replace it, because replacing it means producing a sealed box
     * the box's key opens and the browser's key signed.
     *
     * The box does not pin this. It cannot — it is new every session, and
     * nothing authorises it cryptographically. What authorises the browser is
     * the hub's per-session grant (ruling item 2); what this key does is keep
     * the hub from READING what it authorised.
     */
    browser: PublicIdentity,
    cols,
    rows,
  })
  .strict();
export type ConsoleHello = z.infer<typeof ConsoleHello>;

/**
 * Two schemas rather than one with a `kind: z.enum([...])`, because the union
 * below discriminates on `kind` and a discriminator that is itself a set is
 * how a union quietly stops discriminating.
 */
export const ConsoleStdin = z
  .object({
    v: z.literal(CONSOLE_FRAME_VERSION),
    /** Browser→box only. A `stdin` arriving from the box is `wrong-way`. */
    kind: z.literal("stdin"),
    seq,
    data,
  })
  .strict();
export type ConsoleStdin = z.infer<typeof ConsoleStdin>;

export const ConsoleStdout = z
  .object({
    v: z.literal(CONSOLE_FRAME_VERSION),
    /** Box→browser only. */
    kind: z.literal("stdout"),
    seq,
    data,
  })
  .strict();
export type ConsoleStdout = z.infer<typeof ConsoleStdout>;

export const ConsoleResize = z
  .object({
    v: z.literal(CONSOLE_FRAME_VERSION),
    kind: z.literal("resize"),
    seq,
    cols,
    rows,
  })
  .strict();
export type ConsoleResize = z.infer<typeof ConsoleResize>;

export const ConsoleBye = z
  .object({
    v: z.literal(CONSOLE_FRAME_VERSION),
    kind: z.literal("bye"),
    seq,
    /** Shown to the owner in the session feed, so it is a sentence. */
    reason: z.string().min(1).max(200),
  })
  .strict();
export type ConsoleBye = z.infer<typeof ConsoleBye>;

export const ConsoleFrame = z.discriminatedUnion("kind", [
  ConsoleHello,
  ConsoleStdin,
  ConsoleStdout,
  ConsoleResize,
  ConsoleBye,
]);
export type ConsoleFrame = z.infer<typeof ConsoleFrame>;

/**
 * The envelope context for a console frame.
 *
 * Exported so that neither end computes it: the session id goes in `jobId`
 * and the direction is derived, and if the two ends disagreed about either,
 * every envelope would fail to open with `not-for-us` — a failure that looks
 * exactly like an attack.
 */
export function consoleEnvelope(input: {
  sessionId: string;
  from: "browser" | "box";
  senderKeyId: string;
  recipientKeyId: string;
  deadlineAt: number;
}): EnvelopeContext {
  return {
    jobId: input.sessionId,
    senderKeyId: input.senderKeyId,
    recipientKeyId: input.recipientKeyId,
    deadlineAt: input.deadlineAt,
    direction: input.from === "browser" ? "payload" : "result",
  };
}

/** Why a frame was refused. Each one is a distinct thing a router can do. */
export type ConsoleOrderFault =
  /** Seq went backwards or repeated — the router sent it twice. */
  | "replayed"
  /** Seq skipped — the router dropped what was between. */
  | "gap"
  /** A `hello` that was not the first frame, or a first frame that was not `hello`. */
  | "out-of-turn"
  /** A `stdin` from the box, or a `stdout` from the browser. */
  | "wrong-way"
  /** Anything after `bye`. The stream is over. */
  | "closed";

export type ConsoleOrderResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly fault: ConsoleOrderFault };

/**
 * One direction's ordering rule, which both ends run over what they receive.
 *
 * **Strictly +1, not merely increasing.** Increasing would catch replay and
 * reorder while letting a DROP through silently, and a dropped frame on a
 * terminal is a truncated command that still runs. There is no benign gap
 * here to tolerate: the transport underneath is an ordered, reliable stream,
 * so a gap means something between the ends removed a frame.
 *
 * Every fault is fatal to the session by design. A console has no
 * resynchronisation story that is safe — you cannot ask "what did I miss" of
 * a party that may be the one who took it.
 */
/**
 * One direction's receiver-side ordering state.
 *
 * Named as an interface rather than inferred, so the box's agent and the
 * browser hold the SAME type — an inferred one would let the two ends drift
 * apart without a compiler ever objecting.
 */
export interface ConsoleOrder {
  /** The last sequence accepted. 0 before anything has been. */
  readonly seen: number;
  accept(frame: ConsoleFrame): ConsoleOrderResult;
}

export function consoleOrder(from: "browser" | "box"): ConsoleOrder {
  /**
   * The two directions are NOT symmetric, and reading them as symmetric was
   * this function's first bug: `hello` carries the browser's ephemeral key, so
   * the browser sends exactly one and the box never sends any. A rule that
   * demanded a leading `hello` in both directions would reject every real box
   * stream at its first frame.
   */
  /**
   * What this side is allowed to send AT ALL, rather than a special case per
   * kind. CW's review caught `resize` travelling box→browser unchecked: the
   * rule named stdin and stdout and said nothing about the rest, so every
   * kind added later would have defaulted to "allowed in both directions"
   * and needed somebody to notice. A list of what each side may send has no
   * default to forget.
   */
  const maySend: Readonly<Record<"browser" | "box", readonly string[]>> = {
    // The browser drives: it opens, it types, it sets the size, it leaves.
    browser: ["hello", "stdin", "resize", "bye"],
    // The box answers, and can end a session. Nothing else.
    box: ["stdout", "bye"],
  };
  const allowed = maySend[from];
  const opensWithHello = from === "browser";

  let last = 0;
  let closed = false;

  return {
    /** The last sequence accepted. 0 before anything has been. */
    get seen(): number {
      return last;
    },
    accept(frame: ConsoleFrame): ConsoleOrderResult {
      if (closed) return { ok: false, fault: "closed" };

      if (!allowed.includes(frame.kind)) {
        return { ok: false, fault: "wrong-way" };
      }

      // `hello` opens the browser's stream, appears once, and never opens the
      // box's. Both halves matter: a second `hello` mid-stream would be a new
      // browser key, which is the substitution the sealing exists to stop.
      const isFirst = last === 0;
      const wantsHello = isFirst && opensWithHello;
      if (wantsHello !== (frame.kind === "hello")) {
        return { ok: false, fault: "out-of-turn" };
      }

      if (frame.seq <= last) return { ok: false, fault: "replayed" };
      if (frame.seq !== last + 1) return { ok: false, fault: "gap" };

      last = frame.seq;
      if (frame.kind === "bye") closed = true;
      return { ok: true };
    },
  };
}
