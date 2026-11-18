import { readFile, rm, writeFile } from "node:fs/promises";
import { stripControlChars, type IngressLog } from "./ingress.js";
import { redact } from "./logs.js";

/**
 * Every update writes its own account — #9594.
 *
 * Todd, 11-18: *"100% we should have the device update log itself. It is
 * rare and should capture any useful details."* That morning two Macs took
 * 0.1.5 and ended with no daemon running (#9572), and `grep -n update
 * ~/.byollm/service.log` on the Mac Studio found nothing: the updater said
 * only its failures, so the one event that had just changed the machine had
 * no account anywhere an owner could read.
 *
 * So each step of an update says it happened, in a line that begins
 * `update:` and carries the time, written to two places:
 *
 * - **stderr**, which is the service log on every supervisor we register
 *   with: launchd's `StandardErrorPath`, systemd's `StandardError=append:`,
 *   the Task Scheduler shim's `2>&1`, and the box supervisor's own output.
 *   That is what `grep update ~/.byollm/service.log` finds.
 * - **the ingress log**, as an `update` entry, because that is the file
 *   `byollm logs` reads (#9547) and a hosted box's owner has a console and
 *   no service log.
 *
 * **No key, token or environment value is ever written.** The lines name
 * versions, an origin, durations and npm's own words, and npm's words are
 * somebody else's software: every line goes through `redact` (the same
 * fence `byollm logs` uses) and has its control characters replaced before
 * it is written anywhere.
 */
export interface UpdateJournal {
  /** One step. Written now to stderr; to the ingress log in order. */
  readonly say: (text: string) => void;
  /** Resolves once every line said so far is on disk. Await before exiting. */
  readonly settled: () => Promise<void>;
}

/** `2026-11-18T09:14:03Z` — UTC to the second, the zone on the line. */
function updateClock(at: number): string {
  return `${new Date(at).toISOString().slice(0, 19)}Z`;
}

export function updateJournal(input: {
  readonly err: (text: string) => void;
  readonly ingress?: Pick<IngressLog, "recordUpdate">;
  readonly now?: () => number;
  readonly env?: NodeJS.ProcessEnv;
}): UpdateJournal {
  const now = input.now ?? Date.now;
  let pending: Promise<void> = Promise.resolve();
  return {
    say: (text) => {
      const at = now();
      const line = redact(stripControlChars(text), input.env ?? process.env)
        .replace(/\s+/g, " ")
        .trim();
      input.err(`update: ${updateClock(at)} ${line}\n`);
      const ingress = input.ingress;
      if (ingress === undefined) return;
      /* A log write that fails must not fail the update it describes; the
         stderr copy has already been written. */
      pending = pending.then(() =>
        ingress.recordUpdate({ at, line }).catch(() => undefined),
      );
    },
    settled: () => pending,
  };
}

/**
 * What the outgoing daemon leaves for the one the supervisor starts next.
 *
 * Written once an update is kept, just before the old daemon exits, and
 * consumed by the new one at startup — the only process that can say "now
 * running X", because it is X. Without it the last line of an update's
 * account would be the old daemon saying it was about to exit, which is
 * exactly where Todd's account would have stopped on 11-18.
 */
interface Arrival {
  readonly from: string;
  readonly to: string;
  readonly at: number;
}

export async function rememberUpdate(
  path: string,
  arrival: Arrival,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(arrival)}\n`, { mode: 0o600 });
}

/**
 * Say what the last update left this daemon running, if one did.
 *
 * Read and removed at startup, so it is said once — by the first daemon to
 * start after the update, whichever version that turns out to be. When it
 * is not the version the update installed, that is said too, because it is
 * the line an owner would otherwise have to work out from two others.
 */
export async function announceArrival(input: {
  readonly path: string;
  readonly running: string;
  readonly journal: UpdateJournal;
}): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(input.path, "utf8");
  } catch {
    return;
  }
  await rm(input.path, { force: true });
  let arrival: Partial<Arrival>;
  try {
    arrival = JSON.parse(raw) as Partial<Arrival>;
  } catch {
    return;
  }
  const { from, to, at } = arrival;
  if (
    typeof from !== "string" ||
    typeof to !== "string" ||
    typeof at !== "number"
  ) {
    return;
  }
  const since = ` (the update to it began ${updateClock(at)})`;
  input.journal.say(
    input.running === to
      ? `now running ${to}, was ${from}${since}`
      : `now running ${input.running}, not the ${to} the last update ` +
          `installed over ${from}${since} — the supervisor started a binary ` +
          `other than the one installed; \`byollm start\` re-registers it`,
  );
  await input.journal.settled();
}
