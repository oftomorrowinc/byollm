import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APP_CHECK_EVERY_MS,
  APP_LOOK_AGAIN_MS,
  noteNamesThisProgram,
  parseAppNote,
  watchForTheApp,
  type After,
  type AppNote,
  type AppWatch,
} from "./app-note.js";
import { removeTemp } from "./test-support.js";

/**
 * The note and the check — #11051, ruled on #10663.
 *
 * The clock is the double here and nothing else: the note, the app and the
 * program are real files in a temporary directory, so "is it there" and
 * "is this the program the note names" are answered by the file system the
 * daemon would ask.
 */

/** A clock a test fires by hand. Every pending timer is visible. */
function handClock(): {
  after: After;
  pending: { ms: number; fire: () => void; cancelled: boolean }[];
  next: () => { ms: number; fire: () => void };
} {
  const pending: { ms: number; fire: () => void; cancelled: boolean }[] = [];
  return {
    pending,
    after: (ms, fn) => {
      const entry = { ms, fire: fn, cancelled: false };
      pending.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    next: () => {
      const live = pending.filter((entry) => !entry.cancelled);
      const last = live.at(-1);
      if (last === undefined) throw new Error("no timer is set");
      last.cancelled = true;
      return last;
    },
  };
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let dir: string;
let note: AppNote;
let notePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-app-note-"));
  note = {
    format: 1,
    app: join(dir, "BYOLLM.app"),
    node: join(dir, "node", "bin", "node"),
    program: join(dir, "node", "lib", "byollm", "bin.js"),
  };
  notePath = join(dir, "app.json");
  await mkdir(note.app, { recursive: true });
  await mkdir(join(dir, "node", "bin"), { recursive: true });
  await mkdir(join(dir, "node", "lib", "byollm"), { recursive: true });
  await writeFile(note.node, "");
  await writeFile(note.program, "");
});

afterEach(async () => {
  await removeTemp(dir);
});

function watch(
  over: Partial<AppWatch> & { signal: AbortSignal },
  lines: string[],
  removals: AppNote[],
): AppWatch {
  return {
    notePath,
    platform: "darwin",
    self: { execPath: note.node, scriptPath: note.program },
    say: (line) => lines.push(line),
    removeEntry: (seen) => {
      removals.push(seen);
      return Promise.resolve(true);
    },
    ...over,
  };
}

describe("the note", () => {
  it("parses: a format, and three absolute paths", () => {
    expect(parseAppNote(JSON.stringify(note))).toEqual({ kind: "note", note });
    /* Windows' paths are absolute too, on any machine reading them. */
    expect(
      parseAppNote(
        JSON.stringify({
          format: 1,
          app: "C:\\Users\\lis\\AppData\\Local\\BYOLLM",
          node: "C:\\Users\\lis\\.byollm\\node\\node.exe",
          program:
            "C:\\Users\\lis\\.byollm\\node\\node_modules\\byollm\\dist\\bin.js",
        }),
      ).kind,
    ).toBe("note");
  });

  it.each([
    ["not JSON", "{format: 1"],
    ["an array", "[]"],
    ["no format", JSON.stringify({ ...note, format: undefined })],
    ["a format it was not built for", JSON.stringify({ ...note, format: 2 })],
    ["a relative app", JSON.stringify({ ...note, app: "BYOLLM.app" })],
    ["an empty node", JSON.stringify({ ...note, node: "" })],
    ["a missing program", JSON.stringify({ ...note, program: undefined })],
    ["a number for a path", JSON.stringify({ ...note, app: 7 })],
  ])("is unreadable when it is %s", (_what, raw) => {
    expect(parseAppNote(raw).kind).toBe("unreadable");
  });

  it("names this program only when both the Node and the program match", async () => {
    const self = { execPath: note.node, scriptPath: note.program };
    expect(await noteNamesThisProgram(note, self, "darwin")).toBe(true);
    /* An npm daemon: another Node, another program. */
    const other = join(dir, "other.js");
    await writeFile(other, "");
    expect(
      await noteNamesThisProgram(
        note,
        { ...self, scriptPath: other },
        "darwin",
      ),
    ).toBe(false);
    expect(
      await noteNamesThisProgram(note, { ...self, execPath: other }, "darwin"),
    ).toBe(false);
    /* A note naming a Node that is not there is nobody's. */
    expect(
      await noteNamesThisProgram(
        { ...note, node: join(dir, "gone") },
        self,
        "darwin",
      ),
    ).toBe(false);
  });
});

describe("the check", () => {
  it("never acts on a malformed note, and sets no timer for it", async () => {
    await writeFile(notePath, JSON.stringify({ ...note, format: 2 }));
    await rm(note.app, { recursive: true });
    const clock = handClock();
    const lines: string[] = [];
    const removals: AppNote[] = [];
    const outcome = await watchForTheApp(
      watch(
        { after: clock.after, signal: new AbortController().signal },
        lines,
        removals,
      ),
    );
    expect(outcome).toBe("not-watching");
    expect(clock.pending).toEqual([]);
    expect(removals).toEqual([]);
    expect(lines.join("\n")).toContain("was ignored");
  });

  it("with no note, sets no timer at all", async () => {
    const clock = handClock();
    const outcome = await watchForTheApp(
      watch(
        { after: clock.after, signal: new AbortController().signal },
        [],
        [],
      ),
    );
    expect(outcome).toBe("not-watching");
    expect(clock.pending).toEqual([]);
  });

  it("a daemon the note does not name never checks", async () => {
    await writeFile(notePath, JSON.stringify(note));
    await rm(note.app, { recursive: true });
    const npm = join(dir, "npm-byollm.js");
    await writeFile(npm, "");
    const clock = handClock();
    const looked: string[] = [];
    const removals: AppNote[] = [];
    const lines: string[] = [];
    const outcome = await watchForTheApp(
      watch(
        {
          self: { execPath: note.node, scriptPath: npm },
          after: clock.after,
          exists: (path) => {
            looked.push(path);
            return Promise.resolve(false);
          },
          signal: new AbortController().signal,
        },
        lines,
        removals,
      ),
    );
    expect(outcome).toBe("not-watching");
    expect(looked).toEqual([]);
    expect(clock.pending).toEqual([]);
    expect(removals).toEqual([]);
    expect(lines.join("\n")).toContain("ignores it");
  });

  it("on Linux, never reads the note at all", async () => {
    await writeFile(notePath, JSON.stringify(note));
    await rm(note.app, { recursive: true });
    const clock = handClock();
    const removals: AppNote[] = [];
    const outcome = await watchForTheApp(
      watch(
        {
          platform: "linux",
          after: clock.after,
          signal: new AbortController().signal,
        },
        [],
        removals,
      ),
    );
    expect(outcome).toBe("not-watching");
    expect(clock.pending).toEqual([]);
    expect(removals).toEqual([]);
  });

  it("missing once and present a minute later does nothing", async () => {
    await writeFile(notePath, JSON.stringify(note));
    await rm(note.app, { recursive: true });
    const clock = handClock();
    const removals: AppNote[] = [];
    const lines: string[] = [];
    const stop = new AbortController();
    const watching = watchForTheApp(
      watch({ after: clock.after, signal: stop.signal }, lines, removals),
    );
    await until(() => clock.pending.length === 1, "the second look");
    expect(clock.pending[0]?.ms).toBe(APP_LOOK_AGAIN_MS);
    /* The updater puts the new bundle in place. */
    await mkdir(note.app);
    clock.next().fire();
    await until(() => clock.pending.length === 2, "the daily look");
    expect(clock.pending[1]?.ms).toBe(APP_CHECK_EVERY_MS);
    expect(removals).toEqual([]);
    expect(lines.join("\n")).toContain("is back at");
    stop.abort();
    expect(await watching).toBe("ended");
    expect(removals).toEqual([]);
  });

  it("missing twice a minute apart removes the entry", async () => {
    await writeFile(notePath, JSON.stringify(note));
    await rm(note.app, { recursive: true });
    const clock = handClock();
    const removals: AppNote[] = [];
    const watching = watchForTheApp(
      watch(
        { after: clock.after, signal: new AbortController().signal },
        [],
        removals,
      ),
    );
    await until(() => clock.pending.length === 1, "the second look");
    expect(removals).toEqual([]);
    clock.next().fire();
    expect(await watching).toBe("removed");
    expect(removals).toEqual([note]);
  });

  it("looks once a day by the clock, and acts on the day the app is gone", async () => {
    await writeFile(notePath, JSON.stringify(note));
    const clock = handClock();
    const removals: AppNote[] = [];
    const watching = watchForTheApp(
      watch(
        { after: clock.after, signal: new AbortController().signal },
        [],
        removals,
      ),
    );
    /* Present at start: the next look is a day away, and only a day. */
    await until(() => clock.pending.length === 1, "the first daily timer");
    expect(clock.pending.map((entry) => entry.ms)).toEqual([
      APP_CHECK_EVERY_MS,
    ]);
    clock.next().fire();
    await until(() => clock.pending.length === 2, "the second daily timer");
    expect(clock.pending[1]?.ms).toBe(APP_CHECK_EVERY_MS);
    expect(removals).toEqual([]);

    /* Lis drags it to the Trash; the next day's look finds the path empty. */
    await rm(note.app, { recursive: true });
    clock.next().fire();
    await until(() => clock.pending.length === 3, "the look a minute later");
    expect(clock.pending[2]?.ms).toBe(APP_LOOK_AGAIN_MS);
    clock.next().fire();
    expect(await watching).toBe("removed");
    expect(removals).toHaveLength(1);
  });

  it("keeps running, and looks again tomorrow, when the entry could not be removed", async () => {
    await writeFile(notePath, JSON.stringify(note));
    await rm(note.app, { recursive: true });
    const clock = handClock();
    const lines: string[] = [];
    const stop = new AbortController();
    const watching = watchForTheApp(
      watch(
        {
          after: clock.after,
          signal: stop.signal,
          removeEntry: () => Promise.resolve(false),
        },
        lines,
        [],
      ),
    );
    await until(() => clock.pending.length === 1, "the second look");
    clock.next().fire();
    await until(() => clock.pending.length === 2, "tomorrow's look");
    expect(clock.pending[1]?.ms).toBe(APP_CHECK_EVERY_MS);
    expect(lines.join("\n")).toContain("keeps running");
    stop.abort();
    expect(await watching).toBe("ended");
  });

  it("leaves no timer behind when the run ends", async () => {
    await writeFile(notePath, JSON.stringify(note));
    const clock = handClock();
    const stop = new AbortController();
    const watching = watchForTheApp(
      watch({ after: clock.after, signal: stop.signal }, [], []),
    );
    await until(() => clock.pending.length === 1, "the daily timer");
    stop.abort();
    expect(await watching).toBe("ended");
    expect(clock.pending.every((entry) => entry.cancelled)).toBe(true);
  });
});
