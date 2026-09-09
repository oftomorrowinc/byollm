import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { totalmem, freemem, platform as hostPlatform } from "node:os";
import { promisify } from "node:util";

/**
 * How much memory this machine can actually give a job — byollm_022, B080.
 *
 * Built because nothing in this daemon reads memory at all, and neither does
 * Ollama: its own scheduler logged 17 GB into 5.2 GiB free with zero swap and
 * loaded anyway. On a 36 GB machine that was a wedge, about thirty daemons
 * restarting at once, and a person watching their laptop stop.
 *
 * ## `available`, not `free`, and the difference is the whole reader
 *
 * `os.freemem()` on macOS reports pages that are free *right now* — 0.28 GB
 * on a machine with 6.41 GB it could hand over on demand. A gate built on it
 * is not conservative, it is **broken closed**: it refuses every job forever
 * on a machine that is working perfectly, and that failure looks exactly like
 * the product deciding it can never serve. Available is free plus what the
 * kernel can reclaim without asking anybody.
 *
 * ## Zero dependencies, and the macOS spawn named rather than skipped
 *
 * `systeminformation` computes exactly this and would be one import. It is
 * also large, per-platform, and shells out — into a daemon whose security
 * story is a small fixed audited spawn surface, against a `docs/deps.md` that
 * says dependency minimalism and means it.
 *
 * So the method is taken and the package is not. **The dependency would not
 * avoid the `vm_stat` spawn; it would hide it behind a code path per
 * platform.** Doing it here means one known command, with fixed argv, no
 * shell, and nothing derived from a job, a payload or a config — the same
 * discipline as the process backends, and the same shape as B056's PATH check
 * that looks rather than executes.
 */
/**
 * The OS's own answer to "is memory tight right now" — byollm_022.
 *
 * Separate from how many bytes are available, because the two disagree in the
 * direction that matters. This Mac reads `warn` while holding 6.6 GB
 * available and serving jobs perfectly, so a gate that refused on pressure
 * alone would refuse on an ordinary evening.
 */
export type MemoryPressure = "normal" | "warn" | "critical" | "unknown";

export type MemoryReading =
  | {
      readonly kind: "read";
      /** Free plus reclaimable, in bytes. */
      readonly availableBytes: number;
      readonly totalBytes: number;
      /** Absent where the platform does not report it — Windows, for now. */
      readonly swapFreeBytes?: number;
      readonly swapTotalBytes?: number;
      /**
       * Whether the swap store grows on demand — and it decides whether
       * "free" here is a headroom figure at all.
       *
       * On Linux swap is a partition or a file of fixed size, so `SwapFree`
       * near zero means the machine has nowhere left to page: a real signal.
       * **On macOS the swap file is grown by the kernel as it is needed**, so
       * `vm.swapusage` free near zero means the CURRENT file is full and
       * about to be enlarged — not that the machine is out of room.
       *
       * Measured, not assumed. Todd's Mac read a 15.0 GB swap total one
       * night and 24.0 GB the next morning: the same machine, the file
       * grown, no reinstall. A refusal rule reading that as "headroom gone"
       * would fire on a laptop that is fine — `os.freemem()`'s mistake with
       * a different number, which is the failure this whole row exists to
       * avoid.
       *
       * byollm_022 rules it directly: keep `SwapFree` on Linux, "drop swap
       * as a refusal condition on macOS entirely". This is how — as a
       * property of the reading, so the gate stays platform-agnostic and
       * cannot grow a `process.platform` branch of its own.
       */
      readonly swapGrows?: boolean;
    }
  | {
      /**
       * We could not measure, which is not the same as "there is no room".
       *
       * `stopReasons`' `unavailable` one layer down: we looked, there is
       * nothing readable, and the honest move is to say so rather than let an
       * absence read as a pass — or as a refusal. The gate admits normally
       * here and `byollm status` says the guard is not active on this
       * machine, because a guard nobody knows is off is worse than no guard.
       */
      readonly kind: "unknown";
      readonly why: string;
    };

/** Runs a fixed argv and returns its stdout, or undefined. */
export type ReadCommand = (
  command: readonly [string, ...string[]],
) => Promise<string | undefined>;

/**
 * Linux: one file read, no spawn.
 *
 * `MemAvailable` is the kernel's own answer to this exact question, which is
 * why it exists — confirmed on a live box at 3,707,608 kB against a `MemFree`
 * of 3,381,836 kB, with `os.freemem()` agreeing with the latter.
 */
export function parseMemInfo(text: string): MemoryReading {
  const kb = (key: string): number | undefined => {
    const found = new RegExp(`^${key}:\\s+(\\d+) kB$`, "m").exec(text);
    return found === null ? undefined : Number(found[1]) * 1024;
  };
  const available = kb("MemAvailable");
  const total = kb("MemTotal");
  if (available === undefined || total === undefined) {
    return { kind: "unknown", why: "/proc/meminfo carried no MemAvailable" };
  }
  const swapTotal = kb("SwapTotal");
  const swapFree = kb("SwapFree");
  return {
    kind: "read",
    availableBytes: available,
    totalBytes: total,
    ...(swapFree === undefined ? {} : { swapFreeBytes: swapFree }),
    ...(swapTotal === undefined ? {} : { swapTotalBytes: swapTotal }),
  };
}

/**
 * macOS: `vm_stat`, because no Node API exposes inactive and purgeable pages.
 *
 * Available is free + inactive + speculative + purgeable — the pages the
 * kernel will hand over without anybody being asked. The page size is read
 * from `vm_stat`'s own header rather than assumed 4096: this machine reports
 * 16384, and assuming would have understated available memory fourfold, which
 * is the broken-closed failure arriving through a constant instead.
 */
export function parseVmStat(text: string, total: number): MemoryReading {
  const page = /page size of (\d+) bytes/.exec(text);
  if (page === null) {
    return { kind: "unknown", why: "vm_stat did not report its page size" };
  }
  const pageSize = Number(page[1]);
  const pages = (label: string): number | undefined => {
    const found = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.`, "m").exec(text);
    return found === null ? undefined : Number(found[1]);
  };
  const free = pages("free");
  const inactive = pages("inactive");
  if (free === undefined || inactive === undefined) {
    return {
      kind: "unknown",
      why: "vm_stat carried no free or inactive count",
    };
  }
  const reclaimable =
    free + inactive + (pages("speculative") ?? 0) + (pages("purgeable") ?? 0);
  return {
    kind: "read",
    availableBytes: reclaimable * pageSize,
    totalBytes: total,
  };
}

/** macOS swap, from `sysctl vm.swapusage`. */
export function parseSwapUsage(text: string): {
  swapFreeBytes?: number;
  swapTotalBytes?: number;
} {
  const mb = (key: string): number | undefined => {
    const found = new RegExp(`${key} = ([\\d.]+)M`).exec(text);
    return found === null ? undefined : Number(found[1]) * 1024 * 1024;
  };
  const free = mb("free");
  const total = mb("total");
  return {
    ...(free === undefined ? {} : { swapFreeBytes: free }),
    ...(total === undefined ? {} : { swapTotalBytes: total }),
  };
}

/**
 * What this machine can give, per platform.
 *
 * Windows is `os.freemem()` and that is not the macOS mistake repeated: on
 * Windows that call already reports available physical memory rather than a
 * near-zero free count. Same function, different meaning, and the difference
 * is exactly why this is a per-platform table rather than one call.
 */
export async function readMemory(
  run: ReadCommand,
  readFile: (path: string) => Promise<string | undefined>,
  platform: NodeJS.Platform = hostPlatform(),
): Promise<MemoryReading> {
  if (platform === "linux") {
    const text = await readFile("/proc/meminfo");
    return text === undefined
      ? { kind: "unknown", why: "/proc/meminfo could not be read" }
      : parseMemInfo(text);
  }
  if (platform === "darwin") {
    const text = await run(["vm_stat"]);
    if (text === undefined) {
      return { kind: "unknown", why: "vm_stat could not be run" };
    }
    const reading = parseVmStat(text, totalmem());
    if (reading.kind !== "read") return reading;
    const swap = await run(["sysctl", "vm.swapusage"]);
    /* Read and reported, but flagged as growable — it belongs in the log
       where a person is tuning a default, and not in a refusal. */
    return {
      ...reading,
      ...(swap === undefined
        ? {}
        : { ...parseSwapUsage(swap), swapGrows: true }),
    };
  }
  if (platform === "win32") {
    return { kind: "read", availableBytes: freemem(), totalBytes: totalmem() };
  }
  return { kind: "unknown", why: `no memory reader for ${platform}` };
}

/**
 * macOS pressure, from the kernel's own level.
 *
 * `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical — the
 * number Activity Monitor's pressure graph draws.
 *
 * **Verified on the Mac, and it corrects the assumption this was designed
 * on.** The spec expected `normal` here; it reads **2, warn**, stably across
 * samples, on a machine with 6.6 GB available that is serving jobs fine. That
 * is not a problem with the signal — it is the reason the threshold is
 * CRITICAL and not warn. Refusing at warn would refuse tonight, on a laptop
 * whose owner would rightly call that broken.
 */
export function parsePressureLevel(text: string): MemoryPressure {
  const found = /(\d+)\s*$/.exec(text.trim());
  if (found === null) return "unknown";
  const levels: Readonly<Record<number, MemoryPressure>> = {
    1: "normal",
    2: "warn",
    4: "critical",
  };
  return levels[Number(found[1])] ?? "unknown";
}

/**
 * Linux pressure, from PSI.
 *
 * `full avg10` is the share of the last ten seconds in which EVERY task was
 * stalled on memory. Anything sustained there is a machine already thrashing,
 * which is the same "already in trouble" the macOS critical level means.
 */
export function parsePsi(text: string): MemoryPressure {
  const full = /^full .*avg10=([\d.]+)/m.exec(text);
  if (full === null) return "unknown";
  return Number(full[1]) >= 10 ? "critical" : "normal";
}

/** What the OS says about pressure, per platform. */
export async function readPressure(
  run: ReadCommand,
  readFile: (path: string) => Promise<string | undefined>,
  platform: NodeJS.Platform = hostPlatform(),
): Promise<MemoryPressure> {
  if (platform === "darwin") {
    const text = await run([
      "sysctl",
      "-n",
      "kern.memorystatus_vm_pressure_level",
    ]);
    return text === undefined ? "unknown" : parsePressureLevel(text);
  }
  if (platform === "linux") {
    const text = await readFile("/proc/pressure/memory");
    return text === undefined ? "unknown" : parsePsi(text);
  }
  return "unknown";
}

/**
 * The reader the daemon actually runs — B080.
 *
 * Everything above this line is injected and tested against captured output.
 * This is the one place that touches the host, and it exists so that the
 * injection point has something to inject: a guard nobody wires is dead code
 * wearing an API, which is a thing this codebase has already shipped once.
 *
 * Failures are swallowed into `unknown` rather than thrown. A machine where
 * `vm_stat` is missing is a machine where the guard cannot run, and that is
 * the third state the reader already models — it must not be a crashed
 * daemon, and it must not be silence either. {@link readMemory} says which,
 * and `byollm status` says it out loud.
 */
export async function readHostMemory(): Promise<{
  memory: MemoryReading;
  pressure: MemoryPressure;
}> {
  const run: ReadCommand = async ([command, ...args]) => {
    try {
      const { stdout } = await promisify(execFile)(command, args, {
        // Fixed argv, no shell — the security caveat byollm_022 names for
        // spawning at all, answered rather than skipped.
        shell: false,
        timeout: 2000,
      });
      return stdout;
    } catch {
      return undefined;
    }
  };
  const read = async (path: string): Promise<string | undefined> => {
    try {
      return await readFile(path, "utf8");
    } catch {
      return undefined;
    }
  };
  return {
    memory: await readMemory(run, read),
    pressure: await readPressure(run, read),
  };
}
