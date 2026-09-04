/**
 * Make one value on a busy screen impossible to skip — walk finding, ux 09-03.
 *
 * The pairing flow prints three numbered steps, and step 2 holds the only
 * thing a person has to carry to another window. Todd watched his own code
 * expire while the terminal sat there: the code was on the screen, in a line
 * that looked exactly like the two lines around it.
 *
 * ## Reverse video rather than a colour
 *
 * The ruling asks for a background. A *chosen* background is a guess about
 * somebody's theme — dark text on a dark terminal is a value that has been
 * highlighted into invisibility — and reverse video asks the terminal to swap
 * whatever its own two colours are. It is the one emphasis that cannot
 * collide with a palette we were never told.
 *
 * ## And it disappears when nobody is watching
 *
 * Escapes are for a person at a terminal. Piped into a log, a file or a CI
 * transcript they are noise at best, and at worst noise *inside a value
 * somebody is about to paste*. So this is off unless stdout is a TTY, off
 * when `NO_COLOR` is set — the convention, honoured because a person who set
 * it has already said this once — and forced on only by `FORCE_COLOR`, which
 * exists for the terminal we failed to detect.
 */
const REVERSE = "\u001b[7m";
const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";

export interface EmphasisContext {
  /** Is anybody looking? */
  readonly tty: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Whether escapes may be written at all, given the terminal and the person. */
export function emphasisAllowed(context: EmphasisContext): boolean {
  // Set to anything, including the empty string — the convention is presence,
  // not value, and reading it as a boolean would ignore `NO_COLOR=`.
  if (context.env["NO_COLOR"] !== undefined) return false;
  /*
   * `FORCE_COLOR` is read by value, and that is not an inconsistency.
   *
   * The two variables are different kinds of statement. `NO_COLOR` exists to
   * be *set*, and its convention is explicitly presence-not-value.
   * `FORCE_COLOR` carries a level, and `FORCE_COLOR=0` means **off** to every
   * tool that reads it — so treating it as presence turned the one variable a
   * person uses to disable colour in a pipeline into a switch that forced it
   * on. That is escapes inside a code somebody is about to paste, produced by
   * the setting they used to prevent exactly that.
   *
   * Anything else set is a level, and any level is on.
   */
  const forced = context.env["FORCE_COLOR"];
  if (forced !== undefined) return forced !== "0" && forced !== "";
  return context.tty;
}

/**
 * The value, wrapped so the eye lands on it — or exactly the value, unchanged.
 *
 * Never the label with it. What somebody carries to the other window is the
 * code, and a highlight that swallowed "Enter code:" would make the block of
 * emphasis bigger than the thing emphasised, which is how emphasis stops
 * meaning anything.
 */
export function emphasise(value: string, context: EmphasisContext): string {
  return emphasisAllowed(context)
    ? `${REVERSE}${BOLD} ${value} ${RESET}`
    : value;
}

/** What the process itself is, for the CLI's own calls. */
export function terminalContext(): EmphasisContext {
  return {
    // `@types/node` declares `isTTY` as `boolean`, and Node sets it to
    // `undefined` when the stream is not a terminal. So this comparison is
    // load-bearing even though the type says it cannot be — the linter is
    // reasoning from a declaration that is wrong about its own runtime, and
    // deleting it puts `undefined` into a field typed `boolean`. The same
    // note stands over `setup.ts`, which met this first.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare
    tty: process.stdout.isTTY === true,
    env: process.env,
  };
}
