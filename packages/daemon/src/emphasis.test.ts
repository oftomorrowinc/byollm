import { describe, expect, it } from "vitest";
import { emphasise, emphasisAllowed } from "./emphasis.js";

/**
 * The pairing code, made impossible to skip - walk finding, ux 09-03.
 *
 * The flow prints three numbered steps and step 2 holds the only thing a
 * person has to carry to another window. Numbering was not enough: Todd
 * watched his own code expire while the terminal sat there, because the line
 * holding it looked exactly like the two around it.
 *
 * The tests that matter most here are the ones about *not* emphasising.
 * Escapes inside a value somebody is about to paste are worse than no
 * emphasis at all, and the places that value is read back from - a log, a CI
 * transcript, a piped command - are exactly the places nobody is watching a
 * terminal.
 */
const TERMINAL = { tty: true, env: {} };
const PIPE = { tty: false, env: {} };
/** Built rather than typed, so no source file here carries a raw escape. */
const ESC = String.fromCharCode(27);

describe("when emphasis is allowed", () => {
  it("is on at a terminal and off down a pipe", () => {
    expect(emphasisAllowed(TERMINAL)).toBe(true);
    expect(emphasisAllowed(PIPE)).toBe(false);
  });

  it("obeys NO_COLOR even at a terminal", () => {
    /* Presence, not value. Reading it as a boolean would ignore `NO_COLOR=`,
       which is how the convention is most often written - and somebody who
       set it has already answered this question once. */
    expect(emphasisAllowed({ tty: true, env: { NO_COLOR: "" } })).toBe(false);
    expect(emphasisAllowed({ tty: true, env: { NO_COLOR: "1" } })).toBe(false);
  });

  it("lets FORCE_COLOR override a terminal we failed to detect", () => {
    expect(emphasisAllowed({ tty: false, env: { FORCE_COLOR: "1" } })).toBe(
      true,
    );
    expect(emphasisAllowed({ tty: false, env: { FORCE_COLOR: "3" } })).toBe(
      true,
    );
  });

  it("treats FORCE_COLOR=0 as off, because that is what it means", () => {
    /**
     * The two variables are different kinds of statement, and reading both as
     * presence broke the one that carries a level.
     *
     * `FORCE_COLOR=0` means off to every tool that reads it. Read as mere
     * presence it forced emphasis *on* — so the setting a person uses to keep
     * escapes out of a pipeline produced escapes inside the code they were
     * about to paste. The empty string goes the same way: `FORCE_COLOR=` is
     * how a shell unsets-by-emptying, and nobody means "force" by it.
     */
    expect(emphasisAllowed({ tty: true, env: { FORCE_COLOR: "0" } })).toBe(
      false,
    );
    expect(emphasisAllowed({ tty: false, env: { FORCE_COLOR: "0" } })).toBe(
      false,
    );
    expect(emphasisAllowed({ tty: true, env: { FORCE_COLOR: "" } })).toBe(
      false,
    );
  });

  it("drives the real output, not just the predicate", () => {
    /* The predicate and the wrapper are two functions, and only one of them
       is what a person pastes. A rule proved on the first and assumed on the
       second is a rule with a gap exactly where it matters. */
    const off = { tty: true, env: { FORCE_COLOR: "0" } };
    expect(emphasise("P7ZT-BR2S", off)).toBe("P7ZT-BR2S");
    expect(emphasise("P7ZT-BR2S", { tty: true, env: { NO_COLOR: "1" } })).toBe(
      "P7ZT-BR2S",
    );
  });

  it("puts NO_COLOR ahead of FORCE_COLOR", () => {
    /* Both set is somebody's shell config meeting somebody's CI, and the
       refusal is the one to honour: a person who asked for no escapes gets
       none, and being wrong that way costs a duller screen rather than a
       broken paste. */
    expect(
      emphasisAllowed({ tty: true, env: { NO_COLOR: "1", FORCE_COLOR: "1" } }),
    ).toBe(false);
  });
});

describe("the value itself", () => {
  it("survives the wrapping intact", () => {
    /* The whole point is a code somebody copies. Emphasis that changed a
       character of it would be worse than none. */
    const wrapped = emphasise("P7ZT-BR2S", TERMINAL);
    expect(wrapped).toContain("P7ZT-BR2S");
    expect(
      wrapped
        .split(ESC)
        .join("")
        .replace(/\[\d+m/gu, "")
        .trim(),
    ).toBe("P7ZT-BR2S");
  });

  it("is returned byte-identical when nobody is watching", () => {
    /* Not "close enough": a transcript is where somebody reads a code back
       out, and an escape inside it is a code that will not paste. */
    expect(emphasise("P7ZT-BR2S", PIPE)).toBe("P7ZT-BR2S");
    expect(emphasise("P7ZT-BR2S", PIPE)).not.toContain(ESC);
  });

  it("actually emphasises when it should", () => {
    /* The positive control. Every assertion above is satisfied by a function
       that never emphasises anything at all. */
    expect(emphasise("P7ZT-BR2S", TERMINAL)).toContain(ESC);
  });
});
