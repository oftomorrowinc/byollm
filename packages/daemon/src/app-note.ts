import {
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, posix, win32 } from "node:path";
import type { ServicePlatform } from "./service.js";

/**
 * A daemon the BYOLLM app installed stops itself when the app is gone —
 * #11051, ruled on #10663: "C, with A built first. The daemon removes its
 * start-at-login entry before it stops itself."
 *
 * The app installs its own Node and a byollm under it, and registers the same
 * start-at-login entry `byollm start` does. Dragging the app to the Trash, or
 * deleting its folder by hand on Windows, removes none of that: the private
 * Node lives outside the app, so the daemon would go on starting at every
 * login for a person who believes they removed it. This file is how the
 * daemon finds out.
 *
 * ## The note
 *
 * `~/.byollm/app.json`, written by the app when it installs or is opened.
 * This module defines it and reads it; it never writes it.
 *
 *     {"format":1,"app":"/Applications/BYOLLM.app",
 *      "node":"/Users/lis/.byollm/node/bin/node",
 *      "program":"/Users/lis/.byollm/node/lib/node_modules/byollm/dist/bin.js"}
 *
 * ## Whose note it is — Owl's point 2 on #10663
 *
 * There is one `~/.byollm` per person, whichever install wrote it, so the
 * note is in the same directory as an npm daemon's config on a machine that
 * has both. A daemon acts on the note only when it is itself running from
 * the Node and the program the note names. Every other daemon ignores it
 * entirely: an npm daemon never stops itself because of the app.
 *
 * ## The check
 *
 * At each daemon start, and once a day while it runs, look for the app at
 * the path in the note. A path on purpose: an app dragged to the Trash is no
 * longer at its path, so it reads as gone at once, and so does a moved app
 * (accepted on #10663; the app writes the note again when it is next opened).
 *
 * Gone means gone twice — Owl's point 5. An app replaced by its own updater
 * is missing for a moment, so a missing app is looked for again a minute
 * later before anything is done.
 *
 * Never on Linux: the app ships for macOS and Windows, and a Linux machine
 * behaves exactly as it did before this file existed, note or no note.
 */

/** The note's shape number. A note with any other number is not read. */
const APP_NOTE_FORMAT = 1;

export interface AppNote {
  readonly format: typeof APP_NOTE_FORMAT;
  /** Where the app is: `BYOLLM.app` on a Mac, its folder on Windows. */
  readonly app: string;
  /** The Node the app installed. */
  readonly node: string;
  /** The byollm program under that Node, the script it runs. */
  readonly program: string;
}

/** A read note, or why there is none to act on. */
export type AppNoteRead =
  | { readonly kind: "note"; readonly note: AppNote }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly why: string };

function absolute(path: string): boolean {
  return posix.isAbsolute(path) || win32.isAbsolute(path);
}

/**
 * Parse the note, refusing anything that is not exactly its shape.
 *
 * A malformed note is never acted on. The cost of reading one wrong is a
 * daemon that stops serving on a machine whose owner removed nothing, so
 * anything but three absolute paths and the right format is "unreadable".
 */
export function parseAppNote(raw: string): AppNoteRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unreadable", why: "it is not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "unreadable", why: "it is not an object" };
  }
  const record = parsed as Record<string, unknown>;
  if (record["format"] !== APP_NOTE_FORMAT) {
    return {
      kind: "unreadable",
      why: `its format is ${record["format"] === undefined ? "missing" : JSON.stringify(record["format"])}, and this daemon reads ${String(APP_NOTE_FORMAT)}`,
    };
  }
  const fields = ["app", "node", "program"] as const;
  for (const field of fields) {
    const value = record[field];
    if (typeof value !== "string" || value === "" || !absolute(value)) {
      return {
        kind: "unreadable",
        why: `its "${field}" is not an absolute path`,
      };
    }
  }
  return {
    kind: "note",
    note: {
      format: APP_NOTE_FORMAT,
      app: record["app"] as string,
      node: record["node"] as string,
      program: record["program"] as string,
    },
  };
}

export async function readAppNote(path: string): Promise<AppNoteRead> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "unreadable", why: "it could not be read" };
  }
  return parseAppNote(raw);
}

/** Which program this process is: the Node running it and its script. */
export interface ThisProgram {
  readonly execPath: string;
  readonly scriptPath: string;
}

/**
 * Is this daemon the one the note names? Both paths, resolved.
 *
 * Resolved because the same file has more than one name: `byollm` on a PATH
 * is a link to the script, and a Mac's `/var` is `/private/var`. A path that
 * cannot be resolved — the note names a Node that is not there — is not a
 * match, so the answer is wrong only toward "not mine", which costs a daemon
 * that keeps running, never one that stops.
 */
export async function noteNamesThisProgram(
  note: AppNote,
  self: ThisProgram,
  platform: ServicePlatform,
  resolve: (path: string) => Promise<string> = realpath,
): Promise<boolean> {
  const same = async (a: string, b: string): Promise<boolean> => {
    try {
      const [x, y] = await Promise.all([resolve(a), resolve(b)]);
      return platform === "win32"
        ? x.toLowerCase() === y.toLowerCase()
        : x === y;
    } catch {
      return false;
    }
  };
  return (
    (await same(note.node, self.execPath)) &&
    (await same(note.program, self.scriptPath))
  );
}

/** How long between looks while the app is there. */
export const APP_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
/** How long to wait before believing a missing app is gone. */
export const APP_LOOK_AGAIN_MS = 60 * 1000;

/** Call `fn` after `ms`; returns what cancels it. The daemon's one clock. */
export type After = (ms: number, fn: () => void) => () => void;

const realAfter: After = (ms, fn) => {
  const timer = setTimeout(fn, ms);
  return () => {
    clearTimeout(timer);
  };
};

export interface AppWatch {
  /** `~/.byollm/app.json`. */
  readonly notePath: string;
  readonly platform: ServicePlatform;
  readonly self: ThisProgram;
  /** Where the lines go: the service log, through the daemon's stderr. */
  readonly say: (line: string) => void;
  /**
   * Remove the start-at-login entry and record why — the caller ends the
   * process afterwards. `true` when the entry is gone; `false` keeps the
   * daemon running and the daily check going, because a daemon that stopped
   * with its entry still there would only be started again at the next
   * login.
   */
  readonly removeEntry: (note: AppNote) => Promise<boolean>;
  /** Ends the watch, with no further look and no timer left behind. */
  readonly signal: AbortSignal;
  readonly after?: After;
  readonly exists?: (path: string) => Promise<boolean>;
  readonly resolve?: (path: string) => Promise<string>;
}

/** What a watch ended as. */
export type AppWatchOutcome =
  /** Linux, no note, a malformed note, or a note naming another program. */
  | "not-watching"
  /** The run ended first. */
  | "ended"
  /** The app was gone twice and the start-at-login entry was removed. */
  | "removed";

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Watch for the app's removal, for as long as the run lasts.
 *
 * Nothing is scheduled unless the note belongs to this daemon: with no note
 * there is no timer at all, which is what "an npm install behaves exactly as
 * today" means at the level of the event loop.
 *
 * The note is read again before each look, because the app rewrites it when
 * it is opened — a person who moved it and opened it again has a note with
 * the new path, and the next look uses that one.
 */
export async function watchForTheApp(
  watch: AppWatch,
): Promise<AppWatchOutcome> {
  if (watch.platform === "linux") return "not-watching";
  const after = watch.after ?? realAfter;
  const exists = watch.exists ?? pathExists;

  /** The note, if it is readable and this daemon's; says why once if not. */
  const ours = async (first: boolean): Promise<AppNote | undefined> => {
    const read = await readAppNote(watch.notePath);
    if (read.kind === "absent") return undefined;
    if (read.kind === "unreadable") {
      watch.say(
        `app note: ${watch.notePath} was ignored, because ${read.why} — ` +
          `this daemon will not stop itself on what it says`,
      );
      return undefined;
    }
    const mine = await noteNamesThisProgram(
      read.note,
      watch.self,
      watch.platform,
      watch.resolve,
    );
    if (!mine) {
      if (first) {
        watch.say(
          `app note: ${watch.notePath} belongs to the byollm the BYOLLM app ` +
            `installed (${read.note.program}), not to this one ` +
            `(${watch.self.scriptPath}) — this daemon ignores it`,
        );
      }
      return undefined;
    }
    return read.note;
  };

  /** Resolves `false` when the run ended before `ms` had passed. */
  const sleep = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (watch.signal.aborted) {
        resolve(false);
        return;
      }
      const onAbort = (): void => {
        cancel();
        resolve(false);
      };
      const cancel = after(ms, () => {
        watch.signal.removeEventListener("abort", onAbort);
        resolve(true);
      });
      watch.signal.addEventListener("abort", onAbort, { once: true });
    });

  let note = await ours(true);
  if (note === undefined) return "not-watching";

  for (;;) {
    if (watch.signal.aborted) return "ended";
    if (!(await exists(note.app))) {
      watch.say(
        `app note: the BYOLLM app is not at ${note.app} — looking again in a ` +
          `minute before doing anything, in case it is being updated`,
      );
      if (!(await sleep(APP_LOOK_AGAIN_MS))) return "ended";
      note = await ours(false);
      if (note === undefined) return "not-watching";
      if (!(await exists(note.app))) {
        watch.say(
          `app note: the BYOLLM app is still not at ${note.app}, so it was ` +
            `removed — removing this daemon's start-at-login entry, then stopping`,
        );
        if (await watch.removeEntry(note)) return "removed";
        watch.say(
          `app note: the start-at-login entry could not be removed, so this ` +
            `daemon keeps running and will look again tomorrow`,
        );
      } else {
        watch.say(`app note: the BYOLLM app is back at ${note.app}`);
      }
    }
    if (!(await sleep(APP_CHECK_EVERY_MS))) return "ended";
    note = await ours(false);
    if (note === undefined) return "not-watching";
  }
}

/**
 * Why the daemon stopped, for `byollm status` — another process, later.
 *
 * Written once the start-at-login entry is gone, removed by the next daemon
 * that starts. Without it, status would read a dead heartbeat and an absent
 * service and say "NOT RUNNING", which sends the owner to a log about a
 * device that did exactly what it should.
 */
export interface AppRemovedMark {
  readonly format: 1;
  /** Where the app was. */
  readonly app: string;
  /** When the daemon stopped, epoch ms. */
  readonly at: number;
}

export async function writeAppRemoved(
  path: string,
  mark: AppRemovedMark,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(mark)}\n`, { mode: 0o600 });
}

export async function readAppRemoved(
  path: string,
): Promise<AppRemovedMark | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<
      Record<keyof AppRemovedMark, unknown>
    >;
    if (
      parsed.format === 1 &&
      typeof parsed.app === "string" &&
      typeof parsed.at === "number"
    ) {
      return { format: 1, app: parsed.app, at: parsed.at };
    }
  } catch {
    // Unreadable is no mark: status says what it would have said without one.
  }
  return undefined;
}

export async function clearAppRemoved(path: string): Promise<void> {
  await rm(path, { force: true });
}
