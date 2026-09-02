import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installService, uninstallService } from "./install.js";
import { servicePlan } from "./service.js";
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
    await installService(target("win32"), () =>
      Promise.resolve({ code: 0, output: "" }),
    );

    const bytes = await readFile(plan.unitPath);
    expect([bytes[0], bytes[1]], "no byte-order mark").toEqual([0xff, 0xfe]);
    // UTF-16LE puts a NUL after every ASCII character. Read as utf8 the file
    // is unreadable, which is exactly what MSXML was telling us.
    expect(bytes.subarray(2, 4)).toEqual(Buffer.from([0x3c, 0x00]));
    expect(bytes.toString("utf16le")).toContain('encoding="UTF-16"');
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
    const result = await installService(target("darwin"), () =>
      Promise.resolve({ code: 0, output: "" }),
    );
    expect(result.ok).toBe(true);
    const written = await readFile(plan.unitPath, "utf8");
    expect(written).toContain("<?xml");
  });
});
