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

type QuestionId = (typeof QUESTION_IDS)[number];

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
