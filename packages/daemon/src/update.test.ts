import { describe, expect, it } from "vitest";
import { exactVersion, update, type UpdateDeps } from "./update.js";

/**
 * B053. The ruling's own emphasis: an updater must be able to un-update.
 *
 * So most of this is about the paths where the update does NOT work, and
 * each one is written against a specific way a machine ends up running
 * something nobody chose.
 */
function deps(over: Partial<UpdateDeps> & { installs?: string[] } = {}) {
  const said: string[] = [];
  const order: string[] = [];
  const installs = over.installs ?? [];
  const base: UpdateDeps = {
    drain: () => {
      order.push("drain");
      return Promise.resolve();
    },
    install: (version) => {
      order.push(`install:${version}`);
      installs.push(version);
      return Promise.resolve(true);
    },
    reregister: () => {
      order.push("reregister");
      return Promise.resolve(true);
    },
    installedVersion: () => Promise.resolve(installs.at(-1)),
    report: (line) => {
      said.push(line);
    },
  };
  return { deps: { ...base, ...over } as UpdateDeps, said, order, installs };
}

describe("which versions the updater will install", () => {
  it("takes a literal version", () => {
    expect(exactVersion("0.1.0-alpha.82")).toBe("0.1.0-alpha.82");
    expect(exactVersion("1.2.3")).toBe("1.2.3");
  });

  it("refuses anything that means 'whatever is current'", () => {
    /* The fleet asking for one tag at different minutes is a fleet on
       different builds reporting the same number, and no log would say so. */
    for (const vague of ["latest", "^0.1.0", "0.1.x", "~1.2.3", "", "next"]) {
      expect(exactVersion(vague), vague).toBeUndefined();
    }
  });
});

describe("updating", () => {
  it("drains before it installs anything", async () => {
    const d = deps();
    await update("0.1.0-alpha.81", "0.1.0-alpha.82", d.deps);
    /* An update is elective and a running job is not. Installing first would
       replace the binary under work somebody is waiting on. */
    expect(d.order[0]).toBe("drain");
    expect(d.order).toContain("install:0.1.0-alpha.82");
    expect(d.order.indexOf("drain")).toBeLessThan(
      d.order.indexOf("install:0.1.0-alpha.82"),
    );
  });

  it("re-registers, because the entry point moved", async () => {
    const d = deps();
    await update("0.1.0-alpha.81", "0.1.0-alpha.82", d.deps);
    expect(d.order).toContain("reregister");
  });

  it("reports updated when the binary says what was asked for", async () => {
    const d = deps();
    const outcome = await update("0.1.0-alpha.81", "0.1.0-alpha.82", d.deps);
    expect(outcome).toEqual({ kind: "updated", to: "0.1.0-alpha.82" });
  });

  it("refuses a tag without draining first", async () => {
    /* Refusing after the drain would still have cost this machine the jobs
       it declined to claim, for an update that was never going to happen. */
    const d = deps();
    const outcome = await update("0.1.0-alpha.81", "latest", d.deps);
    expect(outcome.kind).toBe("refused");
    expect(d.order).toEqual([]);
    expect(d.said.join("")).toContain("exact versions only");
  });

  it("refuses when there is no version to roll back to", async () => {
    /* A machine whose current version cannot be named is one the rollback
       cannot return to, so the update is declined rather than attempted. */
    const d = deps();
    const outcome = await update("unknown", "0.1.0-alpha.82", d.deps);
    expect(outcome.kind).toBe("refused");
    expect(d.order).toEqual([]);
  });
});

describe("un-updating", () => {
  it("rolls back when the new binary reports a different version", async () => {
    /**
     * The canary is identity, not liveness. A half-finished install that
     * leaves the old binary in place starts perfectly and answers perfectly
     * — and is exactly the state where the machine is not running what the
     * fleet believes it is running.
     */
    const d = deps({
      installedVersion: () => Promise.resolve("0.1.0-alpha.81"),
    });
    const outcome = await update("0.1.0-alpha.81", "0.1.0-alpha.82", d.deps);
    expect(outcome).toEqual({
      kind: "rolled-back",
      to: "0.1.0-alpha.81",
      why: "installed 0.1.0-alpha.82 but the binary reports 0.1.0-alpha.81",
    });
    expect(d.installs).toEqual(["0.1.0-alpha.82", "0.1.0-alpha.81"]);
    expect(d.said.join("")).toContain("rolled back");
  });

  it("rolls back when the new binary cannot be asked at all", async () => {
    const asked: string[] = [];
    const d = deps({
      installedVersion: () => {
        asked.push("?");
        return Promise.resolve(
          asked.length === 1 ? undefined : "0.1.0-alpha.81",
        );
      },
    });
    const outcome = await update("0.1.0-alpha.81", "0.1.0-alpha.82", d.deps);
    expect(outcome.kind).toBe("rolled-back");
    expect(d.said.join("")).toContain("did not answer");
  });

  it("re-registers after rolling back, not only after updating", async () => {
    /* A machine that rolled back and did not re-register is on the right
       version and unsupervised, which is worse than the state it started in. */
    const d = deps({
      installedVersion: () => Promise.resolve("0.1.0-alpha.81"),
    });
    await update("0.1.0-alpha.81", "0.1.0-alpha.82", d.deps);
    expect(d.order.filter((step) => step === "reregister")).toHaveLength(2);
  });

  it("says so and stops when the rollback itself fails", async () => {
    /**
     * The end of what software can do about this. Not retried — a loop here
     * reinstalls npm packages forever — and not hidden, because the machine
     * is now running something nobody chose and a person has to look at it.
     */
    const installs: string[] = [];
    const d = deps({
      installs,
      install: (version) => {
        installs.push(version);
        return Promise.resolve(version === "0.1.0-alpha.82");
      },
      installedVersion: () => Promise.resolve("0.1.0-alpha.99"),
    });
    const outcome = await update("0.1.0-alpha.81", "0.1.0-alpha.82", d.deps);
    expect(outcome.kind).toBe("stranded");
    expect(d.said.join("")).toContain("also failed");
    /* Once. Not until it works. */
    expect(installs.filter((v) => v === "0.1.0-alpha.81")).toHaveLength(1);
  });

  it("is stranded, not silent, when the rollback installs and does not take", async () => {
    const d = deps({
      installedVersion: () => Promise.resolve("0.1.0-alpha.99"),
    });
    const outcome = await update("0.1.0-alpha.81", "0.1.0-alpha.82", d.deps);
    expect(outcome.kind).toBe("stranded");
    expect(d.said.join("")).toContain("0.1.0-alpha.99");
  });

  it("stays put and re-registers when the install fails outright", async () => {
    /* npm leaves the previous global in place, so there is nothing to undo —
       but the drain already stopped this daemon claiming, and leaving it
       drained is a machine that quietly serves nothing. */
    const d = deps({ install: () => Promise.resolve(false) });
    const outcome = await update("0.1.0-alpha.81", "0.1.0-alpha.82", d.deps);
    expect(outcome.kind).toBe("refused");
    expect(d.order).toContain("reregister");
    expect(d.said.join("")).toContain("staying on 0.1.0-alpha.81");
  });
});
