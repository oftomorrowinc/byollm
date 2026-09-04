import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { ServiceReport } from "./service-line.js";

/**
 * The last thing the probe learned, on disk, for the process that did not run it.
 *
 * `byollm status` is a separate process from the daemon. It cannot run the
 * canary itself — that is a real model call, and on a metered backend it is
 * real money, on a command people run several times a minute while something
 * is wrong. So the daemon writes what it found and `status` reads it.
 *
 * **Latest only, never a history.** This answers "where does this stand now".
 * A log of every probe would be a record of the day somebody's subscription
 * lapsed and the days it stayed lapsed, which is nobody's business, ours
 * included. Same reason the hub will hold only the latest when this reaches
 * Your Devices.
 *
 * A missing or unreadable file is not an error and not a state: it is
 * "nothing has probed yet", and `status` renders health as it always did.
 * Absent is not signed-out — the same distinction the tri-state is built on.
 */

const Stored = z.record(
  z.string(),
  z.object({
    state: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("answers"), model: z.string() }),
      z.object({
        kind: z.literal("signed-out"),
        detail: z.string().optional(),
      }),
      z.object({ kind: z.literal("missing") }),
      z.object({
        kind: z.literal("blocked"),
        detail: z.string().optional(),
        until: z.number().int().positive().optional(),
      }),
      z.object({ kind: z.literal("unknown"), model: z.string() }),
    ]),
    signIn: z.string().optional(),
  }),
);

export async function writeServiceStates(
  path: string,
  states: ReadonlyMap<string, ServiceReport>,
): Promise<void> {
  const out: Record<string, ServiceReport> = {};
  for (const [service, report] of states) out[service] = report;
  try {
    await writeFile(path, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  } catch {
    // A probe that cannot write its notes has still probed. Refusing to run
    // because a status file is unwritable would trade the thing that matters
    // for the thing that reports on it.
  }
}

export async function readServiceStates(
  path: string,
): Promise<Map<string, ServiceReport>> {
  try {
    const parsed = Stored.safeParse(
      JSON.parse(await readFile(path, "utf8")) as unknown,
    );
    if (!parsed.success) return new Map();
    return new Map(Object.entries(parsed.data));
  } catch {
    return new Map();
  }
}
