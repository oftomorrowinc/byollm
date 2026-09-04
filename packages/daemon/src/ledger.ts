import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { z } from "zod";

/**
 * What one attempt to read a ledger meant — byollm_016, 2026-09-03.
 *
 * Three states, because the two that used to be one are the whole bug. A
 * ledger that has never been written and a ledger that will not parse both
 * produced "no entries", and every counter above them read that as "nothing
 * has happened yet" — which is true for the first and the opposite of true
 * for the second. A torn write is how a machine manufactures the second from
 * the first, so this was reachable without an attacker: write, lose power,
 * restart, and the brake that had been counting is now counting from zero.
 *
 * **Missing is not none.** `fresh` is an answer. `untrusted` is a refusal to
 * answer, and callers have to treat it as one.
 */
export type LedgerRead<T> =
  | { readonly state: "fresh" }
  | { readonly state: "loaded"; readonly data: T }
  | { readonly state: "untrusted"; readonly why: string };

/**
 * Why a ledger could not be trusted, in words for its owner.
 *
 * Never the file's content. Somebody debugging this is holding a ledger of
 * what their machine did for other people, and a diagnostic that quotes it
 * puts that in a log, a screenshot and a support thread.
 */
function untrusted(why: string): { state: "untrusted"; why: string } {
  return { state: "untrusted", why };
}

function interpret<T>(
  raw: string,
  schema: z.ZodType<T>,
  path: string,
): LedgerRead<T> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return untrusted(`${path} is not valid JSON`);
  }
  const parsed = schema.safeParse(json);
  return parsed.success
    ? { state: "loaded", data: parsed.data }
    : untrusted(`${path} is not a ledger this version can read`);
}

/**
 * ENOENT is the only good reason for a ledger to be absent.
 *
 * Everything else — a permission change, an I/O error, a directory where the
 * file should be — is the disk declining to tell us what it holds, which is
 * not the same as it holding nothing.
 */
function readFailure(
  error: unknown,
  path: string,
): LedgerRead<never> | "fresh" {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return "fresh";
  return untrusted(`${path} could not be read (${code ?? "unknown error"})`);
}

export async function readLedger<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<LedgerRead<T>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const failure = readFailure(error, path);
    return failure === "fresh" ? { state: "fresh" } : failure;
  }
  return interpret(raw, schema, path);
}

/** The same reading, for the one caller that cannot await — see `SpentGrants`. */
export function readLedgerSync<T>(
  path: string,
  schema: z.ZodType<T>,
): LedgerRead<T> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const failure = readFailure(error, path);
    return failure === "fresh" ? { state: "fresh" } : failure;
  }
  return interpret(raw, schema, path);
}

/**
 * Replace a ledger without ever being halfway through replacing it.
 *
 * The pairing file's pattern, with a sync added. Writing to the live path is
 * what let an interrupted write produce the corrupt file the reader above now
 * refuses — the failure and its trigger were the same line, in all three
 * ledgers.
 *
 * A unique temp name per attempt: two writers sharing one is how the identity
 * file's first fix broke its own race test. `fsync` before the rename because
 * what is wanted here is crash durability and not merely atomic visibility —
 * a rename can land while the bytes it names are still in a cache. The
 * directory sync that follows is best-effort: it is what makes the rename
 * itself survive, and Windows has no equivalent to attempt.
 */
export async function writeLedger(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  await syncDirectory(dirname(path));
}

/** The same write, synchronously, for the burn that must precede a job. */
export function writeLedgerSync(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  syncDirectorySync(dirname(path));
}

/* Best-effort by design: a platform that will not let us open a directory has
   nothing to offer here, and failing the write over it would turn a durability
   nicety into an outage. The bytes are already synced and the rename has
   already happened. */
async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Windows, and any filesystem that refuses a directory handle.
  }
}

function syncDirectorySync(path: string): void {
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // As above.
  }
}

/**
 * One writer per ledger, so a slow rename cannot land on a fast one.
 *
 * Found by CW's rolling review, and it reproduces: twenty-five concurrent
 * `record()` calls left twenty-one on disk. Nothing here is thread-unsafe —
 * the loss is in the awaits. Each call serialises its own snapshot and then
 * suspends across `open`, `write`, `sync` and `rename`, so two calls can
 * finish out of order and the *earlier* snapshot wins. The entries between
 * them are gone.
 *
 * That is a brake under-counting what it was built to count, which is the
 * unsafe direction.
 *
 * The body is a thunk rather than a string, and that is the other half: taken
 * after the previous write has landed, so a queued write serialises current
 * state rather than the state its caller saw. A queue of stale snapshots
 * would order the writes and still lose the entries.
 */
export class LedgerWriter {
  readonly #path: string;
  readonly #sink: (path: string, body: string) => Promise<void>;
  #tail: Promise<unknown> = Promise.resolve();

  /**
   * The write itself is injectable, and only the tests pass one.
   *
   * Not decoration: the first test written for this asserted the *symptom* —
   * twenty-five concurrent records, twenty-five entries on disk — and passed
   * with the serialisation removed. It reproduces on a real filesystem and it
   * did not reproduce under the runner, which makes it a test that would have
   * gone green in CI on the broken code. A seam that cannot be driven can
   * only be tested by luck.
   */
  constructor(
    path: string,
    sink: (path: string, body: string) => Promise<void> = writeLedger,
  ) {
    this.#path = path;
    this.#sink = sink;
  }

  write(body: () => string): Promise<void> {
    const next = this.#tail.then(() => this.#sink(this.#path, body()));
    // The chain must survive a failed write, or one rejection stops every
    // later one. Callers still see their own failure through `next`.
    this.#tail = next.catch(() => undefined);
    return next;
  }
}
