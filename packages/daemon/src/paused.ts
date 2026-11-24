import type { PausedService } from "@byollm/protocol";

/**
 * The heartbeat's `paused` list, from the runner's blocked services —
 * byollm_019 §3.4, #10825.
 *
 * A word and a time. The block's own report keeps the CLI's sentence for
 * `byollm status`; nothing from it is read here, because that sentence quotes
 * paths, usernames and account emails and this list leaves the machine.
 *
 * `until` only when the CLI gave one. A block without a time is released on
 * the next detection pass (019 §3.2), and the tick runs that pass before it
 * heartbeats — so in the runner today such an entry is gone before any beat
 * carries it. The shape still says it honestly, for the day that changes.
 */
export function pausedOf(
  blocked: ReadonlyMap<string, number | undefined>,
): PausedService[] {
  return [...blocked].map(([service, until]) => ({
    service,
    why: "allowance",
    ...(until === undefined ? {} : { until }),
  }));
}
