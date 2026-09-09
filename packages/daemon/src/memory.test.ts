import { describe, expect, it } from "vitest";
import {
  parseMemInfo,
  parsePressureLevel,
  parsePsi,
  readPressure,
  parseSwapUsage,
  parseVmStat,
  readMemory,
} from "./memory.js";

/**
 * The memory reader — byollm_022, B080.
 *
 * Driven by CAPTURED output, never by the machine running the test. The
 * argument is `quota.ts`': a reader that asks the real machine proves nothing
 * on every machine that happens to have room, which is most of them, so the
 * test goes green having tested nothing — on a schedule.
 *
 * The macOS fixture is this Mac's real `vm_stat`, and the numbers it yields
 * were confirmed against the live reader: available 7.51 GB where
 * `os.freemem()` said 0.68 GB.
 */
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    40044.
Pages active:                                 444611.
Pages inactive:                               444751.
Pages speculative:                              1547.
Pages throttled:                                   0.
Pages wired down:                             314074.
Pages purgeable:                                4547.
`;

/** A live Linux box, per the spec's confirmed capture. */
const MEMINFO = `MemTotal:       16116684 kB
MemFree:         3381836 kB
MemAvailable:    3707608 kB
SwapTotal:       2097148 kB
SwapFree:        2097148 kB
`;

const GB = 1024 ** 3;

describe("reading what a machine can actually give", () => {
  it("reads available, not free — the whole reason this exists", () => {
    /**
     * On this Mac the two differ by eleven times. A gate on `free` is not
     * conservative, it is broken closed: it refuses every job forever on a
     * machine that is working perfectly, and that reads as the product
     * deciding it can never serve.
     */
    const reading = parseVmStat(VM_STAT, 36 * GB);
    expect(reading.kind).toBe("read");
    if (reading.kind !== "read") return;
    /* free alone is 40044 pages = 0.61 GB; available is ~7.5. */
    const freeAlone = (40044 * 16384) / GB;
    expect(freeAlone).toBeLessThan(1);
    expect(reading.availableBytes / GB).toBeGreaterThan(7);
    expect(reading.availableBytes / GB).toBeLessThan(8);
  });

  it("takes the page size from vm_stat rather than assuming 4096", () => {
    /* This machine reports 16384. Assuming 4096 understates available memory
       fourfold — the broken-closed failure arriving through a constant. */
    const assumed4k = parseVmStat(
      VM_STAT.replace("16384 bytes", "4096 bytes"),
      36 * GB,
    );
    const real = parseVmStat(VM_STAT, 36 * GB);
    expect(real.kind === "read" && assumed4k.kind === "read").toBe(true);
    if (real.kind !== "read" || assumed4k.kind !== "read") return;
    expect(real.availableBytes).toBe(assumed4k.availableBytes * 4);
  });

  it("reads MemAvailable on Linux, which is the kernel's own answer", () => {
    const reading = parseMemInfo(MEMINFO);
    expect(reading.kind).toBe("read");
    if (reading.kind !== "read") return;
    expect(reading.availableBytes).toBe(3707608 * 1024);
    /* And NOT MemFree, which is the number `os.freemem()` agrees with. */
    expect(reading.availableBytes).not.toBe(3381836 * 1024);
    expect(reading.swapFreeBytes).toBe(2097148 * 1024);
  });

  it("reads macOS swap, because memory alone did not distinguish that night", () => {
    /* The machine that wedged looked survivable on memory with swap at 97%. */
    const swap = parseSwapUsage(
      "vm.swapusage: total = 15360.00M  used = 14259.19M  free = 1100.81M  (encrypted)",
    );
    expect(swap.swapTotalBytes).toBe(15360 * 1024 * 1024);
    expect(swap.swapFreeBytes).toBeCloseTo(1100.81 * 1024 * 1024, -3);
  });
});

describe("when it cannot answer", () => {
  /**
   * Unknown is a third state and it is not silence. Refusing everywhere we
   * cannot measure bricks the daemon on a platform nobody has visited;
   * allowing silently means the guard does not exist and nobody knows.
   */
  it("says so rather than guessing a number", () => {
    expect(parseVmStat("nonsense", 36 * GB).kind).toBe("unknown");
    expect(parseMemInfo("MemFree: 100 kB\n").kind).toBe("unknown");
  });

  it("says so for a platform with no reader", async () => {
    const reading = await readMemory(
      () => Promise.resolve(undefined),
      () => Promise.resolve(undefined),
      "freebsd",
    );
    expect(reading.kind).toBe("unknown");
    if (reading.kind === "unknown") expect(reading.why).toContain("freebsd");
  });

  it("says so when vm_stat will not run", async () => {
    const reading = await readMemory(
      () => Promise.resolve(undefined),
      () => Promise.resolve(undefined),
      "darwin",
    );
    expect(reading.kind).toBe("unknown");
  });

  it("names WHY, because the owner surface prints it", async () => {
    /* "We looked and there is nothing" has to reach a person as a sentence,
       or an absent guard reads as a passing one. */
    const reading = await readMemory(
      () => Promise.resolve(undefined),
      () => Promise.resolve(undefined),
      "linux",
    );
    expect(reading.kind).toBe("unknown");
    if (reading.kind === "unknown")
      expect(reading.why.length).toBeGreaterThan(15);
  });
});

describe("per platform, because one call means different things", () => {
  it("spawns nothing on Linux", async () => {
    const spawned: string[][] = [];
    const reading = await readMemory(
      (cmd) => {
        spawned.push([...cmd]);
        return Promise.resolve(undefined);
      },
      () => Promise.resolve(MEMINFO),
      "linux",
    );
    expect(reading.kind).toBe("read");
    expect(spawned, "Linux is one file read").toEqual([]);
  });

  it("spawns a fixed argv on macOS, with nothing derived from anything", async () => {
    const spawned: string[][] = [];
    await readMemory(
      (cmd) => {
        spawned.push([...cmd]);
        return Promise.resolve(cmd[0] === "vm_stat" ? VM_STAT : "");
      },
      () => Promise.resolve(undefined),
      "darwin",
    );
    expect(spawned).toEqual([["vm_stat"], ["sysctl", "vm.swapusage"]]);
    for (const argv of spawned) {
      for (const part of argv) {
        expect(part).not.toContain(" ");
        expect(part).not.toContain(";");
      }
    }
  });

  it("uses os.freemem on Windows, where it already means available", async () => {
    /* Not the macOS mistake repeated: on Windows that call reports available
       physical memory rather than a near-zero free count. Same function,
       different meaning, which is why this is a table and not one call. */
    const reading = await readMemory(
      () => Promise.resolve(undefined),
      () => Promise.resolve(undefined),
      "win32",
    );
    expect(reading.kind).toBe("read");
  });
});

describe("what the OS says about pressure", () => {
  /**
   * Separate from how many bytes are free, because on this Mac the two
   * disagree in the direction that decides the design: it reads `warn` while
   * holding 6.6 GB and serving jobs perfectly.
   */
  it("maps the kernel's own levels", () => {
    expect(parsePressureLevel("1")).toBe("normal");
    expect(parsePressureLevel("2")).toBe("warn");
    expect(parsePressureLevel("4")).toBe("critical");
  });

  it("reads the value this Mac actually reports", () => {
    /* Verified live and stable across samples. The spec expected `normal`
       here; it is `warn`, which is precisely why the gate refuses only at
       critical — refusing at warn would refuse tonight. */
    expect(parsePressureLevel("kern.memorystatus_vm_pressure_level: 2")).toBe(
      "warn",
    );
  });

  it("says unknown for a level it does not recognise", () => {
    /* 3 is not one of the documented levels. Guessing which side of the line
       it falls on is guessing whether to refuse somebody's job. */
    expect(parsePressureLevel("3")).toBe("unknown");
    expect(parsePressureLevel("nothing numeric")).toBe("unknown");
  });

  it("reads Linux PSI, and calls a quiet machine normal", () => {
    /* `full avg10` is the share of the last ten seconds in which EVERY task
       was stalled. A live box reads 0.00. */
    const quiet =
      "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n";
    expect(parsePsi(quiet)).toBe("normal");
  });

  it("calls a thrashing machine critical", () => {
    const stalled =
      "some avg10=52.00 avg60=40.00 avg300=9.00 total=1\nfull avg10=31.00 avg60=20.00 avg300=4.00 total=1\n";
    expect(parsePsi(stalled)).toBe("critical");
  });

  it("says unknown when PSI is absent, rather than assuming quiet", () => {
    /* PSI needs a kernel built for it. Absent is not calm. */
    expect(parsePsi("some avg10=0.00\n")).toBe("unknown");
  });

  it("asks each platform the way that platform answers", async () => {
    const asked: string[][] = [];
    const mac = await readPressure(
      (cmd) => {
        asked.push([...cmd]);
        return Promise.resolve("2");
      },
      () => Promise.resolve(undefined),
      "darwin",
    );
    expect(mac).toBe("warn");
    expect(asked).toEqual([
      ["sysctl", "-n", "kern.memorystatus_vm_pressure_level"],
    ]);

    const linux = await readPressure(
      () => Promise.resolve(undefined),
      () => Promise.resolve("full avg10=0.00\n"),
      "linux",
    );
    expect(linux).toBe("normal");

    /* And a platform with no pressure signal says so rather than guessing. */
    expect(
      await readPressure(
        () => Promise.resolve(undefined),
        () => Promise.resolve(undefined),
        "win32",
      ),
    ).toBe("unknown");
  });

  it("says unknown when the command will not run", async () => {
    expect(
      await readPressure(
        () => Promise.resolve(undefined),
        () => Promise.resolve(undefined),
        "darwin",
      ),
    ).toBe("unknown");
  });
});

describe("swap, where it is reported at all", () => {
  it("carries neither number when sysctl says nothing useful", () => {
    /* Absent is not zero — a missing reading must not become "no swap free",
       which is the landmine the gate is built around. */
    expect(parseSwapUsage("vm.swapusage: nonsense")).toEqual({});
  });
});
