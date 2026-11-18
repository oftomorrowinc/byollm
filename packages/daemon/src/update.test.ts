import { describe, expect, it } from "vitest";
import { exactVersion, offerInbox, update, type UpdateDeps } from "./update.js";

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
    verify: (version) => {
      order.push(`verify:${version}`);
      return Promise.resolve({ verified: true });
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

  it("re-registers, because the unit may have moved", async () => {
    const d = deps();
    await update("0.1.0-alpha.81", "0.1.0-alpha.82", d.deps);
    expect(d.order).toContain("reregister");
  });

  it("re-registers last, after the canary has passed — #9572", async () => {
    /* On launchd, re-registering from inside the daemon boots the daemon out.
       Before this it ran BEFORE the canary, so it was never the last thing a
       daemon did — and on Todd's Mac it was the last thing it did at all. */
    const asked: string[] = [];
    const d = deps({
      installedVersion: () => {
        d.order.push("canary");
        asked.push("?");
        return Promise.resolve("0.1.2");
      },
    });
    const outcome = await update("0.1.1", "0.1.2", d.deps);
    expect(outcome).toEqual({ kind: "updated", to: "0.1.2" });
    expect(d.order).toEqual([
      "drain",
      "install:0.1.2",
      "verify:0.1.2",
      "canary",
      "reregister",
    ]);
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

describe("which direction the updater moves — B360", () => {
  it("refuses a downgrade, before draining anything", async () => {
    /* An offer is a claim about what is newer. A downgrade is how a machine
       is walked back onto a release with a known hole in it. */
    const d = deps();
    const outcome = await update("0.1.1", "0.1.0", d.deps);
    expect(outcome.kind).toBe("refused");
    expect(d.order).toEqual([]);
    expect(d.said.join("")).toContain("never downgrades");
  });

  it("orders prereleases numerically, and a release above its prereleases", async () => {
    /* `alpha.9` sorts after `alpha.83` as a string — the mistake that would
       let the one through as an "upgrade". */
    for (const [from, to] of [
      ["0.1.0-alpha.83", "0.1.0-alpha.9"],
      ["0.1.0", "0.1.0-alpha.120"],
    ] as const) {
      const d = deps();
      expect((await update(from, to, d.deps)).kind, `${from} → ${to}`).toBe(
        "refused",
      );
      expect(d.order).toEqual([]);
    }
  });

  it("refuses the version it is already on, and a build-only difference", async () => {
    for (const to of ["0.1.1", "0.1.1+rebuilt"]) {
      const d = deps();
      expect((await update("0.1.1", to, d.deps)).kind, to).toBe("refused");
      expect(d.order).toEqual([]);
    }
  });

  it("refuses when either side cannot be ordered", async () => {
    /* Unreadable is not permission. The target is caught as not exact and
       the source as nothing to roll back to — neither reaches a drain. */
    for (const [from, to] of [
      ["0.1.1", "0.2"],
      ["0.1", "0.2.0"],
    ] as const) {
      const d = deps();
      expect((await update(from, to, d.deps)).kind, `${from} → ${to}`).toBe(
        "refused",
      );
      expect(d.order).toEqual([]);
    }
  });

  it("still takes a higher version, including a prerelease of the next one", async () => {
    for (const to of ["0.1.2", "0.2.0-rc.1", "1.0.0"]) {
      const d = deps();
      expect(await update("0.1.1", to, d.deps), to).toEqual({
        kind: "updated",
        to,
      });
    }
  });
});

describe("checking provenance before the new binary runs — B360", () => {
  it("verifies after the install and before anything starts the new binary", async () => {
    const d = deps();
    await update("0.1.1", "0.1.2", d.deps);
    expect(d.order.slice(0, 3)).toEqual([
      "drain",
      "install:0.1.2",
      "verify:0.1.2",
    ]);
  });

  it("rolls back without re-registering anything", async () => {
    /* The supervisor never heard of the package that failed, so there is
       nothing to undo there — and re-registering the running daemon from
       inside it is what takes it down on launchd (#9572). */
    const d = deps({
      verify: (version) => {
        d.order.push(`verify:${version}`);
        return Promise.resolve({
          verified: false,
          why: "there is no SLSA provenance for it",
        });
      },
    });
    const outcome = await update("0.1.1", "0.1.2", d.deps);
    expect(outcome).toEqual({
      kind: "rolled-back",
      to: "0.1.1",
      why: "0.1.2 failed its provenance check: there is no SLSA provenance for it",
    });
    expect(d.order).toEqual([
      "drain",
      "install:0.1.2",
      "verify:0.1.2",
      "install:0.1.1",
    ]);
    expect(d.said.join("")).toContain("rolled back to 0.1.1");
  });

  it("is stranded, and says so, when the rollback after a failed check fails", async () => {
    const d = deps({
      install: (version) => Promise.resolve(version === "0.1.2"),
      verify: () => Promise.resolve({ verified: false, why: "HTTP 404" }),
    });
    const outcome = await update("0.1.1", "0.1.2", d.deps);
    expect(outcome.kind).toBe("stranded");
    expect(d.said.join("")).toContain("provenance check: HTTP 404");
    expect(d.said.join("")).toContain("also failed");
  });
});

describe("whose offers count — B360", () => {
  const HUB = "https://hub.byollm.cloud";
  function inbox(pinned: readonly string[] = [HUB]) {
    const said: string[] = [];
    const box = offerInbox({
      authority: HUB,
      hasControlPlane: (origin) => pinned.includes(origin),
      report: (line) => said.push(line),
    });
    return { box, said };
  }

  it("takes the authority's offer", () => {
    const { box, said } = inbox();
    box.receive(HUB, "0.1.2");
    expect(box.current()).toBe("0.1.2");
    expect(said).toEqual([]);
  });

  it("ignores any other paired origin, and says so once", () => {
    /* Before this, the newest offer won whichever site named it — so any
       site somebody paired with could choose what their machine installs. */
    const { box, said } = inbox(["https://app.example", HUB]);
    for (let beat = 0; beat < 5; beat += 1) {
      box.receive("https://app.example", "9.9.9");
    }
    expect(box.current()).toBeUndefined();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("https://app.example");
    expect(said[0]).toContain(`only from ${HUB}`);
  });

  it("does not let another origin replace the authority's offer", () => {
    const { box } = inbox(["https://app.example", HUB]);
    box.receive(HUB, "0.1.2");
    box.receive("https://app.example", "9.9.9");
    expect(box.current()).toBe("0.1.2");
  });

  it("ignores the authority over a direct-mode pairing", () => {
    /* No control plane pinned is the one fact that makes a pairing direct
       (byollm_016 Amendment L), and a direct pairing is one site. */
    const { box, said } = inbox([]);
    box.receive(HUB, "0.1.2");
    expect(box.current()).toBeUndefined();
    expect(said.join("")).toContain("direct-mode");
  });

  it("follows the authority's newest offer", () => {
    const { box } = inbox();
    box.receive(HUB, "0.1.2");
    box.receive(HUB, "0.1.3");
    expect(box.current()).toBe("0.1.3");
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

  it("never re-registers after a failed canary — #9572", async () => {
    /* This once asserted TWO re-registers here, reasoning that a rolled-back
       machine that did not re-register is unsupervised. The re-register is
       what unsupervised it: on launchd it boots the daemon out, killing the
       `start` before its bootstrap. Now nothing is registered until the
       canary passes, so a failed one leaves the supervisor untouched. */
    const d = deps({
      installedVersion: () => Promise.resolve("0.1.0-alpha.81"),
    });
    await update("0.1.0-alpha.81", "0.1.0-alpha.82", d.deps);
    expect(d.order).not.toContain("reregister");
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

  it("stays put, and does not re-register, when the install fails outright", async () => {
    /* npm leaves the previous global in place, so there is nothing to undo.
       Getting back to work after the drain is the watcher's job (it resumes
       claiming on every outcome but `updated`, update-when-offered.test.ts);
       a re-register here would boot the daemon out on launchd — #9572. */
    const d = deps({ install: () => Promise.resolve(false) });
    const outcome = await update("0.1.0-alpha.81", "0.1.0-alpha.82", d.deps);
    expect(outcome.kind).toBe("refused");
    expect(d.order).not.toContain("reregister");
    expect(d.said.join("")).toContain("staying on 0.1.0-alpha.81");
  });
});
