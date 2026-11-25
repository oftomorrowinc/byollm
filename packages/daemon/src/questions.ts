/**
 * Setup's questions, as records — cloud_016 §2, phase 1, ask 2.
 *
 * Until this file the conversation was free text both ways: `ask(question)`
 * took a paragraph and returned a line. A window cannot turn a paragraph into
 * buttons, and a flag cannot know a question's default without reading the
 * paragraph. So each question is now a record — what it is, what it offers,
 * what it falls back to, and what must be shown beside it — and a **face**
 * is given the record and returns the answer.
 *
 * There is still one conversation and one implementation (Todd, 09-10, quoted
 * in setup.ts): `manageServices` and `runSetup` decide what to ask and what an
 * answer means; a face decides only how a question looks. After this card
 * there is one face, the terminal, and it prints the same bytes as before —
 * `setup-transcript.test.ts` holds it to goldens recorded from the code that
 * preceded it.
 *
 * **The answer is still a line.** A face returns what a person would have
 * typed (`"1 3"`, `"y"`, `""` for the default), and the conversation parses it
 * exactly as it always did. Typed answers per kind are a later face's
 * business; changing the parse here would have been changing behaviour in a
 * card whose promise is that nothing changes.
 */

/**
 * Every question setup or `byollm services manage` can ask.
 *
 * A closed list on purpose: the terminal's layout table below is keyed by it,
 * so a new id does not compile until it has a layout, and the transcript test
 * fails until some scenario reaches it. A question added as bare text has no
 * door to come in by — the conversation holds a {@link Face}, which has no
 * `ask`.
 */
export const QUESTION_IDS = [
  "setup.set-up-empty-config",
  "setup.device-name",
  "services.model",
  "services.pick",
  "services.sign-in",
  "services.sign-in-elsewhere",
  "services.team",
  "services.share",
  "services.cap",
  "services.default",
  "setup.connect",
  "setup.start",
] as const;

export type QuestionId = (typeof QUESTION_IDS)[number];

/**
 * What sort of answer a question wants.
 *
 * The spec names four — choose one, yes or no, text, wait — and the picker is
 * a fifth: it toggles any number of rows, and calling it "choose one" would
 * hand a window radio buttons for a checklist.
 */
type QuestionKind = "choose" | "choose-many" | "yes-no" | "text" | "wait";

export interface QuestionOption {
  /** What answering with this option sends back: the number on the row. */
  readonly value: string;
  /** The option's name. */
  readonly label: string;
  /** Where it runs, when the question says so. */
  readonly detail?: string;
  /** The line beneath or beside it: its cost, or why it cannot serve. */
  readonly note?: string;
  /** The heading it sits under, when the question groups its options. */
  readonly group?: string;
  /** `choose-many` only: whether it is marked right now. */
  readonly on?: boolean;
}

export interface Question {
  readonly id: QuestionId;
  readonly kind: QuestionKind;
  /** The question, in the words the terminal has always printed. */
  readonly words: string;
  readonly options?: readonly QuestionOption[];
  /**
   * What an empty answer means. `"yes"`/`"no"` for a yes-or-no, the offered
   * text or option value otherwise; absent where an empty answer finishes or
   * skips rather than picking something.
   */
  readonly default?: string;
  /**
   * A sentence that must be shown with this question, by every face — the
   * subscription sentence is the one that is law (byollm_015).
   */
  readonly mustShow?: string;
  /**
   * The same question again after an answer that did not finish it — a
   * picker's next round. A face may redraw rather than re-introduce it.
   */
  readonly again?: boolean;
}

/** Where a conversation speaks, and who answers its questions. */
export interface Face {
  out(text: string): void;
  err(text: string): void;
  /** Whether a question may be asked at all. */
  readonly interactive: boolean;
  /** Shows the record and returns the answer, as a typed line. */
  answer(question: Question): Promise<string>;
  /**
   * The only rows this face can turn on, when it knows them before it is
   * asked — #10374, rule 34. `--yes` knows: it marks exactly its `--service`
   * names, and nothing for a bare `--yes`.
   *
   * A subscription is checked with a real call on the person's plan, and
   * that call is spent before the picker is asked. So a face that will never
   * mark a row says so here, and `manageServices` does not spend a call
   * checking it. The row is still listed as found.
   *
   * Absent for a person and for `--json`: they choose at the picker, and
   * the row's state is part of what they choose from.
   */
  readonly named?: readonly string[];
}

/**
 * The line terminal a face is drawn on: print, and read a line after a
 * prompt. Injected so tests are not a TTY.
 */
export interface LineIo {
  out(text: string): void;
  err(text: string): void;
  /** Writes the prompt, and returns the raw line typed after it. */
  ask(prompt: string): Promise<string>;
  /** Whether we may ask at all. */
  interactive: boolean;
}

/**
 * How the terminal lays out one record: what is printed before the prompt,
 * and the prompt the line is typed after.
 *
 * Split in two because that is how the terminal always printed it — the
 * picker's rows and the default's list went out as text and only the last
 * line was the prompt — and a test that reads the prompts alone should see
 * the same prompts it saw before.
 */
interface Layout {
  readonly before: string;
  readonly prompt: string;
}

const yesNoHint = (question: Question): string =>
  question.default === "no" ? "[y/N]" : "[Y/n]";

const shown = (question: Question): string =>
  question.mustShow === undefined ? "" : `\n${question.mustShow}\n`;

const options = (question: Question): readonly QuestionOption[] =>
  question.options ?? [];

/**
 * One layout per question, keyed by the closed list — so a new id is a
 * compile error here until somebody decides how it looks.
 *
 * The words come from the record and nowhere else. What lives here is only
 * the terminal's own furniture: indents, blank lines, `[Y/n]`, and the
 * instructions that make sense only with a keyboard ("Type a number…").
 */
const TERMINAL: Readonly<Record<QuestionId, (q: Question) => Layout>> = {
  "setup.set-up-empty-config": (q) => ({
    before: "",
    prompt: `  ${q.words} ${yesNoHint(q)} `,
  }),
  "setup.device-name": (q) => ({
    before: "",
    prompt: `${q.words} [${q.default ?? ""}] `,
  }),
  "services.model": (q) => {
    const menu = options(q);
    return {
      before: "",
      prompt:
        `\n  ${q.words}\n` +
        (menu.length === 0
          ? ""
          : `\n${menu
              .map(
                (o) =>
                  `    ${o.value}  ${o.label}${o.note === undefined ? "" : ` — ${o.note}`}`,
              )
              .join("\n")}\n`) +
        (menu.length === 0
          ? `  (press enter to skip — it will not be offered) `
          : `  (a number, or type a model name; enter skips — it will not be offered) `),
    };
  },
  "services.pick": (q) => ({
    before:
      (q.again === true
        ? ""
        : `\n${q.words}\n` +
          "  Type a number to turn one on or off, `a` for all, Enter when done.\n\n") +
      grouped(options(q))
        .map((line) => `${line}\n`)
        .join(""),
    prompt: "  > ",
  }),
  "services.sign-in": (q) => ({
    before: "",
    prompt: `  ${q.words} ${yesNoHint(q)} `,
  }),
  "services.sign-in-elsewhere": (q) => ({
    before: "",
    prompt: `  ${q.words} `,
  }),
  "services.team": (q) => ({
    before: shown(q),
    prompt: `\n${q.words} ${yesNoHint(q)} `,
  }),
  "services.share": (q) => ({
    before:
      (q.again === true
        ? ""
        : `\n${q.words}\n` +
          "  Same list: a number turns one on or off, `a` for all, Enter when done.\n\n" +
          (q.mustShow === undefined ? "" : `  ${q.mustShow}\n\n`)) +
      options(q)
        .map(
          (o) =>
            `   ${o.value.padStart(2)}. [${o.on === true ? "x" : " "}] ` +
            `${o.label.padEnd(24)} ${o.note ?? ""}\n`,
        )
        .join(""),
    prompt: "  > ",
  }),
  "services.cap": (q) => ({
    before: "",
    prompt: `\n${q.words
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n")} [${q.default ?? ""}] `,
  }),
  "services.default": (q) => ({
    before:
      shown(q) +
      `\n${q.words}\n` +
      options(q)
        .map(
          (o) =>
            `  ${o.value}. ${o.label}${o.note === undefined ? "" : `  (${o.note})`}\n`,
        )
        .join(""),
    prompt: `  [${q.default ?? ""}] `,
  }),
  "setup.connect": (q) => ({
    before: "",
    prompt: `\n  ${q.words} ${yesNoHint(q)} `,
  }),
  "setup.start": (q) => ({
    before: "",
    prompt: `\n  ${q.words} ${yesNoHint(q)} `,
  }),
};

/**
 * The picker's rows under their headings.
 *
 * Numbered from the array, and the heading follows the rows. The first
 * version walked the groups and numbered inside each one, which made the
 * number on screen a function of the grouping and the number the toggle reads
 * a function of the array — two numbering schemes that agree only while the
 * array happens to be sorted. **A mutation that deleted the sort changed
 * nothing that any test could see, and would have moved every mark to the
 * wrong row on a machine whose probe answered in a different order.** So the
 * number is the option's value, always, and the group is a heading printed
 * when it changes.
 */
function grouped(rows: readonly QuestionOption[]): string[] {
  const lines: string[] = [];
  let heading: string | undefined;
  for (const row of rows) {
    if (row.group !== heading) {
      if (heading !== undefined) lines.push("");
      heading = row.group;
      lines.push(`  ${heading ?? "other"}`);
    }
    const mark = row.on === true ? "x" : " ";
    lines.push(
      `   ${row.value.padStart(2)}. [${mark}] ${row.label.padEnd(24)} ${row.detail ?? ""}`,
    );
    lines.push(`${" ".repeat(31)}${row.note ?? ""}`);
  }
  lines.push("");
  return lines;
}

/**
 * The terminal face: prints each record as setup always printed it, reads
 * the line typed after it.
 */
export function terminalFace(io: LineIo): Face {
  return {
    out: (text) => {
      io.out(text);
    },
    err: (text) => {
      io.err(text);
    },
    get interactive() {
      return io.interactive;
    },
    answer(question) {
      const layout = TERMINAL[question.id](question);
      if (layout.before !== "") io.out(layout.before);
      return io.ask(layout.prompt);
    },
  };
}

/**
 * A face, whichever was given.
 *
 * The two entry points take either, so a caller holding a line terminal —
 * every test written before records, and the CLI's `terminalIo` — reaches the
 * one conversation through the terminal face rather than a second path.
 */
export function faceOf(io: LineIo | Face): Face {
  return "answer" in io ? io : terminalFace(io);
}

/**
 * A question `--yes` will not answer by itself, and the flag that does — an
 * error, because the run stops there.
 *
 * Its own class for the reason `InputEnded` is one: the CLI catches it and
 * says it once, and a command that matched on a message would be matching on
 * words somebody may yet edit.
 */
export class NeedsFlag extends Error {
  constructor(
    readonly question: QuestionId,
    readonly flag: string,
    why: string,
  ) {
    super(why);
    this.name = "NeedsFlag";
  }
}

/** What a command line said about the questions `--yes` may not take alone. */
export interface YesFlags {
  /** `--service <name>`, each time it was given: the rows left marked. */
  readonly services?: readonly string[];
  /** `--default <name>`: the service that answers a job naming none. */
  readonly defaultService?: string;
}

const ENTER = (): string => "";

const labels = (q: Question): string =>
  options(q)
    .map((o) => o.label)
    .join(", ");

/**
 * What `--yes` types at each question — cloud_016 §2.
 *
 * Keyed by the closed list, like the terminal's layouts, so a new question
 * does not compile until somebody has decided whether `--yes` may answer it.
 *
 * **Enter, nearly everywhere, and Enter is the default.** The record's
 * `default` is what an empty answer means; where a record has none and the
 * prompt offers Enter (a model nobody knows: "enter skips"; a sign-in done
 * elsewhere: "press Enter to re-check"; the sharing list: "Enter when
 * done"), Enter is what the prompt itself proposes. So `--yes` is a person
 * pressing Enter — nothing more.
 *
 * Two questions have no safe default, and stop the run unless a flag
 * answers them. Both are asked inside `manageServices`, before setup writes
 * a byte or pairs anything:
 *
 * - **What this machine runs** (`--service`). The picker's record carries no
 *   default: its Enter finishes with the marks as they stand, and on a fresh
 *   machine nothing is marked (B219 — a row starts marked only when its
 *   model was typed this run, and `--yes` types none). Taking that would end
 *   with "Nothing selected." and say nothing of how to choose, so the stop
 *   names the flag. **A bare `--yes` therefore enables nothing**: every
 *   service it turns on was named on its command line.
 * - **The default service** (`--default`). Two services answer one kind and
 *   the daemon will not pick between them for the owner; the record's
 *   offered row is an offer to a person, not a choice `--yes` may make.
 */
const UNATTENDED: Readonly<
  Record<QuestionId, (q: Question, flags: YesFlags) => string>
> = {
  "setup.set-up-empty-config": ENTER,
  "setup.device-name": ENTER,
  "services.model": ENTER,
  "services.pick": (q, flags) => {
    if (flags.services === undefined) {
      throw new NeedsFlag(
        q.id,
        "--service",
        "--yes will not choose what this machine runs.\n" +
          `  Name each one with --service <name>: ${labels(q)}`,
      );
    }
    return marking(q, flags.services);
  },
  "services.sign-in": ENTER,
  "services.sign-in-elsewhere": ENTER,
  "services.team": ENTER,
  "services.share": ENTER,
  "services.cap": ENTER,
  "services.default": (q, flags) => {
    if (flags.defaultService === undefined) {
      throw new NeedsFlag(
        q.id,
        "--default",
        "--yes will not choose your default service: more than one service\n" +
          "  answers the same jobs, and byollm does not pick between them for you.\n" +
          `  Name it with --default <name>: ${labels(q)}`,
      );
    }
    const named = options(q).find((o) => o.label === flags.defaultService);
    if (named === undefined) {
      throw new NeedsFlag(
        q.id,
        "--default",
        `--default ${flags.defaultService} is not one of the services being written.\n` +
          `  Name one of: ${labels(q)}`,
      );
    }
    return named.value;
  },
  "setup.connect": ENTER,
  "setup.start": ENTER,
};

/**
 * The toggles that leave exactly the named rows marked.
 *
 * On the first round, the rows whose mark differs from the list; on the round
 * after, Enter — and a check that the marks did move, because a picker that
 * redrew something else would otherwise be finished with the wrong rows.
 *
 * A name not on the list stops the run rather than being dropped: an agent
 * that asked for `codex` and got a config without it would report success.
 * The usual cause is a CLI whose model this build does not know — `--yes`
 * skips the question that asks it, so the CLI never becomes a row.
 */
function marking(q: Question, names: readonly string[]): string {
  const rows = options(q);
  const unknown = names.filter((name) => !rows.some((o) => o.label === name));
  if (unknown.length > 0) {
    throw new NeedsFlag(
      q.id,
      "--service",
      `--service ${unknown.join(", ")}: not on this machine's list.\n` +
        `  It has: ${labels(q)}`,
    );
  }
  const wrong = rows.filter((o) => (o.on === true) !== names.includes(o.label));
  if (wrong.length === 0) return "";
  if (q.again === true) {
    throw new NeedsFlag(
      q.id,
      "--service",
      "the list did not end as --service named it: " +
        wrong.map((o) => o.label).join(", "),
    );
  }
  return wrong.map((o) => o.value).join(" ");
}

/**
 * `byollm setup --yes`: the terminal's words, and Enter typed at each one.
 *
 * Drawn with the terminal's own layouts, so everything a person would have
 * been shown is printed — every question, and the subscription sentence where
 * it rides — and each prompt is followed by the line `--yes` typed, the way a
 * terminal echoes typing. Somebody reading the output afterwards reads the
 * same transcript a person would have left.
 *
 * It never reads input. That is the whole of B114 here: there is no stdin
 * whose end could be taken for a yes, because the yes is the flag.
 */
export function yesFace(
  io: { out(text: string): void; err(text: string): void },
  flags: YesFlags = {},
): Face {
  return {
    out: (text) => {
      io.out(text);
    },
    err: (text) => {
      io.err(text);
    },
    interactive: true,
    named: flags.services ?? [],
    answer(question) {
      const layout = TERMINAL[question.id](question);
      if (layout.before !== "") io.out(layout.before);
      io.out(layout.prompt);
      let typed: string;
      try {
        typed = UNATTENDED[question.id](question, flags);
      } catch (error) {
        io.out("\n");
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      io.out(`${typed}\n`);
      return Promise.resolve(typed);
    },
  };
}

/**
 * The number on `byollm setup --json`'s lines — cloud_016 §2.
 *
 * The same rule as `status --json`'s: fields are only added, and a reader
 * ignores what it does not know. It moves when a field is removed, renamed or
 * changes meaning, so a window built against one release knows not to guess
 * at a daemon that has updated itself since.
 */
export const SETUP_JSON_FORMAT = 1;

/**
 * One line of `byollm setup --json`'s stdout: a question to answer, or
 * something setup said.
 *
 * Every line is one of these and nothing else is written there — a parent
 * reading line by line never meets text it has to skip.
 */
export type SetupJsonLine =
  | { readonly format: typeof SETUP_JSON_FORMAT; readonly question: Question }
  | { readonly format: typeof SETUP_JSON_FORMAT; readonly say: string };

/** An answer line that was not an answer. */
export class NotAnAnswer extends Error {
  constructor(
    readonly question: QuestionId,
    readonly line: string,
  ) {
    super(
      `the answer to ${question} was not a JSON string on one line: ` +
        JSON.stringify(line.length > 80 ? `${line.slice(0, 80)}…` : line),
    );
    this.name = "NotAnAnswer";
  }
}

/**
 * `byollm setup --json`: each record as one line on stdout, each answer as
 * one line on stdin. The parent process is the other end; nothing listens.
 *
 * **The record is written whole and unchanged** — its words, options, default
 * and the sentence that must be shown — so a window draws what the terminal
 * draws from, and rewords nothing.
 *
 * **An answer is a JSON string**, the line a person would have typed: `""`
 * for the default, `"1 3"` to toggle two rows, `"yes"`, a device name. JSON
 * rather than the bare line so a blank line is not an answer: a parent that
 * writes a stray newline has made an error, not pressed Enter on a question
 * whose default pairs the device. Anything else stops the run, and so does
 * input that ends (`InputEnded`, from whichever reader is given).
 */
export function jsonFace(io: {
  /** Writes one line of stdout; the newline is added here. */
  line(text: string): void;
  err(text: string): void;
  /** The next line of stdin. Rejects when the input has ended. */
  read(): Promise<string>;
}): Face {
  const emit = (value: SetupJsonLine): void => {
    io.line(JSON.stringify(value));
  };
  return {
    out: (text) => {
      emit({ format: SETUP_JSON_FORMAT, say: text });
    },
    err: (text) => {
      io.err(text);
    },
    interactive: true,
    async answer(question) {
      emit({ format: SETUP_JSON_FORMAT, question });
      const line = await io.read();
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new NotAnAnswer(question.id, line);
      }
      if (typeof parsed !== "string") throw new NotAnAnswer(question.id, line);
      return parsed;
    },
  };
}
