import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installService, uninstallService } from "./install.js";
import { servicePlan } from "./service.js";
import { installedProgram } from "./install.js";
import { removeTemp } from "./test-support.js";

/**
 * Windows supervision, which has never actually worked.
 *
 * The task XML declares `encoding="UTF-16"` on its first line and every unit
 * file was written `utf8`. MSXML refuses the mismatch, so `schtasks /create
 * /xml` failed on **every** Windows machine — administrator or not — and each
 * one fell to the Startup folder, which cannot restart a crashed daemon.
 * Restart-on-failure has never shipped to a Windows user, and the fallback
 * looked enough like success that nobody noticed for months.
 *
 * ## What these can and cannot prove
 *
 * Not that `schtasks` accepts the file — that needs Windows, and Kevin. What
 * they prove is that the bytes on disk are what the file says they are, which
 * is the thing that was false. Asserting the outcome would mean asserting a
 * stub's return value.
 */

let home: string;

/** The same shape `service.test.ts` uses — a real target, not a cast. */
const target = (platform: "win32" | "darwin") => ({
  platform,
  execPath: "/usr/local/bin/node",
  scriptPath: "/usr/local/lib/node_modules/@byollm/daemon/dist/bin.js",
  home,
  root: join(home, ".byollm"),
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "byollm-win-"));
});

afterEach(async () => {
  await removeTemp(home);
});

describe("the task file says what it is", () => {
  it("declares UTF-16 and is written as UTF-16", () => {
    const plan = servicePlan(target("win32"));
    expect(plan.unitContents).toContain('encoding="UTF-16"');
    expect(plan.unitEncoding).toBe("utf16le");
  });

  it("keeps the batch fallback as plain bytes", () => {
    // A `.cmd` declares no encoding and `cmd` reads it as bytes. This is part
    // of why the fallback quietly worked while the task never did.
    const plan = servicePlan(target("win32"));
    expect(plan.fallback?.unitEncoding).toBe("utf8");
  });

  it("is written to disk as UTF-16LE, with the mark", async () => {
    /**
     * The assertion that is about the bug rather than about the plan.
     *
     * Two of the cases above read fields; this reads bytes. The declaration
     * and the write disagreeing is what broke, so a test that only checked
     * the declaration would have passed for the whole time it was broken.
     *
     * The BOM is not decoration — `schtasks` identifies the encoding from it,
     * and UTF-16LE without one is refused as firmly as the mismatch was. Node
     * writes code units and no mark, so it is prepended deliberately.
     */
    const plan = servicePlan(target("win32"));
    /* The liveness answer and an instant wait: since 2026-09-03 install
       probes for a *running* daemon before it claims success, and this case
       is about the bytes on disk rather than that gate. */
    await installService(
      target("win32"),
      (command) =>
        Promise.resolve({
          code: 0,
          output: command.includes("/query") ? "byollm  Running" : "",
        }),
      () => Promise.resolve(),
    );

    const bytes = await readFile(plan.unitPath);
    expect([bytes[0], bytes[1]], "no byte-order mark").toEqual([0xff, 0xfe]);
    // UTF-16LE puts a NUL after every ASCII character. Read as utf8 the file
    // is unreadable, which is exactly what MSXML was telling us.
    expect(bytes.subarray(2, 4)).toEqual(Buffer.from([0x3c, 0x00]));
    expect(bytes.toString("utf16le")).toContain('encoding="UTF-16"');
  });
});

describe("when Windows refuses the task anyway", () => {
  it("says what to do, not only what happened", async () => {
    /**
     * B036, the half that is a sentence rather than a schema.
     *
     * `install` told two people "no administrator rights, or IT policy" and
     * stopped there. That is a diagnosis, and neither of them was told that
     * an elevated shell gets past it — so both read it as a dead end.
     *
     * It should also be rarer now: the task names its user and runs at least
     * privilege, so it asks for no elevation. An Access-denied here means the
     * machine refuses task creation outright, and elevation is the thing left
     * to try.
     */
    const said = await installService(
      target("win32"),
      (command) =>
        Promise.resolve(
          command.includes("/create")
            ? { code: 1, output: "ERROR: Access is denied." }
            : { code: 0, output: command.includes("/query") ? "" : "" },
        ),
      () => Promise.resolve(),
    );

    const text = said.lines.join("\n");
    /* Our reading of the refusal AND the words it was read from — B049's
       rider reversed the old "in our words rather than schtasks'" choice,
       which cost us the only line that could tell the hypotheses apart. */
    expect(text).toContain("would not register the scheduled task");
    expect(text).toContain("ERROR: Access is denied.");
    expect(text, "a diagnosis with no next step is a dead end").toContain(
      "Run as administrator",
    );
    /* `byollm run` is deliberately NOT here any more. This is the branch
       where the Startup fallback succeeded, so something already starts
       byollm at login, and offering a third path re-buries the one remedy
       Kevin said should lead. It is named in the branch that needs it —
       below, where nothing supervises at all. */
    expect(text).not.toContain("byollm run");
  });

  it("still names a way to serve when even the fallback fails", async () => {
    /**
     * The other side of moving the remedy: this branch has less than the
     * fallback branch, not more, and it must not lose what that one gained.
     * A person here has nothing starting byollm at all.
     */
    /* A real filesystem refusal rather than an injected one: a FILE where
       the Startup folder's parent directory has to be, so the recursive
       mkdir fails the way a locked-down profile would. There is no seam to
       stub here, and adding one to test the branch would be testing the
       seam. */
    const plan = servicePlan(target("win32"));
    const blocked = plan.fallback?.unitPath;
    expect(blocked).toBeDefined();
    await mkdir(dirname(dirname(dirname(dirname(blocked!)))), {
      recursive: true,
    });
    await writeFile(dirname(dirname(dirname(blocked!))), "not a directory");

    const said = await installService(
      target("win32"),
      (command) =>
        Promise.resolve(
          command.includes("/create")
            ? { code: 1, output: "ERROR: Access is denied." }
            : { code: 0, output: "" },
        ),
      () => Promise.resolve(),
    );

    const text = said.lines.join("\n");
    expect(said.ok).toBe(false);
    expect(text).toContain("Run as administrator");
    expect(text).toContain("byollm run");
    expect(text).toContain("ERROR: Access is denied.");
  });
});

describe("uninstall removes what was actually installed", () => {
  it("deletes the Startup fallback, not only the task file", async () => {
    /**
     * The consent failure. Every Windows install had fallen to the Startup
     * folder, and uninstall removed a task XML that had never registered —
     * printed "Removed", left the thing that starts the daemon in place, and
     * next logon it came back.
     *
     * Somebody's machine doing work they told it to stop doing, and being
     * told it had stopped.
     */
    const plan = servicePlan(target("win32"));
    const fallback = plan.fallback;
    expect(fallback).toBeDefined();
    if (!fallback) return;

    /**
     * Created for real, and checked before as well as after.
     *
     * The first version of this wrote with `.catch(() => undefined)` into a
     * directory that does not exist, so the file was never created and "it is
     * gone afterwards" was trivially true — it passed with the fix removed.
     * A setup whose failure is swallowed is a test that asserts nothing.
     */
    await mkdir(dirname(fallback.unitPath), { recursive: true });
    await writeFile(fallback.unitPath, "startup", "utf8");
    await expect(readFile(fallback.unitPath, "utf8")).resolves.toBe("startup");

    await uninstallService(target("win32"), () =>
      Promise.resolve({ code: 0, output: "" }),
    );

    await expect(readFile(fallback.unitPath, "utf8")).rejects.toThrow();
  });
});

describe("installing on a platform that writes a plain unit", () => {
  it("still writes utf8, unchanged", async () => {
    // The control. A change that made every unit UTF-16 would pass the
    // Windows cases above and corrupt launchd and systemd.
    const plan = servicePlan(target("darwin"));
    expect(plan.unitEncoding).toBe("utf8");
    const result = await installService(
      target("darwin"),
      (command) =>
        Promise.resolve({
          code: 0,
          output: command[1] === "print" ? "state = running\n\tpid = 7" : "",
        }),
      () => Promise.resolve(),
    );
    expect(result.ok).toBe(true);
    const written = await readFile(plan.unitPath, "utf8");
    expect(written).toContain("<?xml");
  });
});

/**
 * The task file is read back in the encoding it was written in.
 *
 * `installedProgram` exists to say "the program this service runs is gone" —
 * the failure a version manager produces on an ordinary node upgrade, and the
 * one that turns "(last exit 2)" into an answer.
 *
 * Its first version looked for the first `/`-prefixed token in the unit. That
 * reads a plist and a systemd unit correctly, and on Windows reads the
 * doctype URL instead of `<Command>` — so it reported a missing program on the
 * one platform where it had not looked at the program at all. It also read the
 * file as utf8, and this one is UTF-16LE: every character separated by a NUL,
 * matching nothing, returning `null`, saying nothing. Quieter than a bug and
 * still a bug.
 */
describe("reading back what the Windows task file points at", () => {
  it("finds the command, through the byte-order mark and the NULs", async () => {
    const plan = servicePlan(target("win32"));
    await installService(
      target("win32"),
      (command) =>
        Promise.resolve({
          code: 0,
          output: command.includes("/query") ? "byollm  Running" : "",
        }),
      () => Promise.resolve(),
    );

    const program = await installedProgram(plan);
    expect(program, "the task file was unreadable").not.toBeNull();
    // The interpreter the unit actually names — not the doctype URL, which is
    // what the first version returned.
    expect(program?.path).toBe(target("win32").execPath);
    expect(program?.path.startsWith("http")).toBe(false);
  });
});
