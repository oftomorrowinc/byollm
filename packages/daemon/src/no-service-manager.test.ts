import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installService } from "./install.js";
import { servicePlan } from "./service.js";

/**
 * "I asked and was told no" is not "there was nobody to ask" — B184.
 *
 * Todd, on the first real box, ran `byollm start` and was told:
 *
 *     systemd (user) refused the task, and the fallback could not be
 *     written either. Nothing is starting byollm at login.
 *       To get past this, run `byollm start` once from a terminal opened
 *       with "Run as administrator".
 *       systemctl --user daemon-reload — exit 127
 *
 * **Three defects, and the exit code is printed right there in the message
 * that contradicts it.** 127 is "no such command" — a container with no
 * `systemctl` at all, which `spawnCommand`'s own docstring names as one of the
 * two failure modes that matter and `service.test.ts` asserts explicitly. The
 * code has always distinguished them; only the sentence collapsed them.
 *
 * This is B173's two-valued collapse in the other repository. "Refused" sends
 * somebody looking for a permission they do not have, on a systemd that is not
 * there.
 */

const home = mkdtempSync(join(tmpdir(), "byollm-b184-"));
const linux = () => ({
  platform: "linux" as const,
  execPath: "/usr/local/bin/node",
  scriptPath: "/opt/byollm/dist/bin.js",
  home,
  root: join(home, ".byollm"),
  appData: join(home, "AppData", "Roaming"),
});

/** A machine with no service manager: every activate command is 127. */
const noSystemctl = () => Promise.resolve({ code: 127, output: "" });

describe("a machine with no service manager", () => {
  it("does not say the supervisor refused anything", async () => {
    const said = (
      await installService(linux(), noSystemctl, () => Promise.resolve())
    ).lines.join("\n");
    expect(said).not.toContain("refused");
    expect(said).toContain("no service manager");
  });

  it("does not offer a Windows remedy on Linux", async () => {
    /**
     * The second defect, and the one that cost the most. *"a terminal opened
     * with 'Run as administrator'"* is Kevin's Windows line and it printed
     * unconditionally. On a box there is **no other terminal, no
     * administrator and no elevation** — the console runs four commands.
     *
     * A remedy that does not exist on the machine is worse than none, because
     * it ends the search.
     */
    const said = (
      await installService(linux(), noSystemctl, () => Promise.resolve())
    ).lines.join("\n");
    expect(said).not.toContain("Run as administrator");
    expect(said).not.toMatch(/administrator/i);
  });

  it("still shows the exit code, because that is the evidence", async () => {
    /* B049's rider: the reading goes first and the raw line stays under it.
       Removing the number would make the next report unfalsifiable. */
    const said = (
      await installService(linux(), noSystemctl, () => Promise.resolve())
    ).lines.join("\n");
    expect(said).toContain("exit 127");
  });

  it("removes the unit file it wrote before asking", async () => {
    /**
     * The third defect. The unit is written before the supervisor is asked,
     * so a machine with no supervisor is left holding a file that describes a
     * service nothing can start — Todd found exactly that at
     * `~/.config/systemd/user/cloud.byollm.daemon.service`, on the PVC, where
     * it survives for the life of the box.
     *
     * A leftover that describes a service nobody can start is something the
     * next reader has to disprove.
     */
    const plan = servicePlan(linux());
    await installService(linux(), noSystemctl, () => Promise.resolve());
    expect(existsSync(plan.unitPath), plan.unitPath).toBe(false);
  });

  it("reports failure rather than a success nobody can rely on", async () => {
    const result = await installService(linux(), noSystemctl, () =>
      Promise.resolve(),
    );
    expect(result.ok).toBe(false);
  });

  it("does not promise that `byollm run` keeps a device online", async () => {
    /**
     * B185 is unruled and this must not pre-empt it. The old sentence —
     * *"`byollm run` still works in a terminal, and is the way to keep
     * serving until this is sorted"* — is true on a laptop and misleading on
     * a hosted box, where the console IS pid 1 and `exit` ends the daemon
     * with it.
     *
     * So it says what is true of `byollm run` everywhere and stops: it serves
     * while it runs, which is not the same as a device that stays online.
     */
    const said = (
      await installService(linux(), noSystemctl, () => Promise.resolve())
    ).lines.join("\n");
    expect(said).toContain("for as long as it is running");
    expect(said).toContain("needs");
  });
});

describe("a supervisor that is there and says no", () => {
  it("still reads as a refusal, which is the control", async () => {
    /**
     * Without this, a message that said "no service manager" for every
     * failure would pass every case above — and would tell somebody whose
     * systemd genuinely refused that they have no systemd.
     */
    const said = (
      await installService(
        linux(),
        () => Promise.resolve({ code: 1, output: "Failed to connect to bus" }),
        () => Promise.resolve(),
      )
    ).lines.join("\n");
    expect(said).toContain("refused");
    expect(said).not.toContain("no service manager");
    expect(said).toContain("Failed to connect to bus");
  });

  it("is still not told to open an administrator terminal, on Linux", async () => {
    /**
     * The case the mutation testing demanded, and it was a real gap.
     *
     * Every other case here drives exit 127, which takes the `absent` branch
     * and never reaches the Windows remedy at all — so making that remedy
     * unconditional again passed 7/7. **The guard was untested by tests
     * written specifically to test it.**
     *
     * Todd's second defect lives on THIS path too: a Linux supervisor that is
     * present and refuses must not be handed Kevin's Windows line either.
     */
    const said = (
      await installService(
        linux(),
        () => Promise.resolve({ code: 1, output: "Failed to connect to bus" }),
        () => Promise.resolve(),
      )
    ).lines.join("\n");
    expect(said).not.toMatch(/administrator/i);
  });
});
