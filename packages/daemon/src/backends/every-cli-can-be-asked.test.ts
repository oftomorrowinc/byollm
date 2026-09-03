import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { BACKENDS, type BackendId } from "@byollm/protocol";
import { createBackend } from "./index.js";
import { ClaudeCliBackend } from "./claude-cli.js";
import { CodexCliBackend } from "./codex-cli.js";

/**
 * Every subscription CLI can be asked whether it can answer.
 *
 * `health()` runs `--version`: it says the binary is there, which was never
 * the question. `canary()` is the question — one real call — and without it
 * the detector returns `answers: undefined`, which means *not asked* and is
 * deliberately not `false` everywhere it is read.
 *
 * So a signed-out codex passed `byollm setup`, passed `connect`, passed
 * `byollm model`, and failed every job it was given. The gate that stops a
 * logged-out Claude has named codex in its own copy since the day it shipped.
 *
 * ## Keyed on the property, not on a list of two
 *
 * A backend whose cost is a subscription is one whose credentials can expire
 * while the binary stays exactly where it was. That is the class the canary
 * exists for, and the check reads it out of the registry — so a third CLI
 * added next year is covered without anybody remembering this file.
 */
describe("a backend that runs on somebody's subscription", () => {
  /**
   * The subscription-cost backends, with their ids still typed.
   *
   * `BACKENDS` is a record keyed by id — a lookup first and an enumeration
   * second — and `Object.values` throws the key type away, so `createBackend`
   * refuses the widened `string`. Taking the entries keeps it, which is worth
   * more than a cast: the id being a member of the union is the thing that
   * makes this check cover the registry rather than a list of guesses.
   */
  const subscriptions = (
    Object.entries(BACKENDS) as [BackendId, (typeof BACKENDS)[BackendId]][]
  ).filter(([, backend]) => backend.cost === "subscription");

  it("there are some, or this file is asserting nothing", () => {
    // The control. Reading a registry that yields no matches passes the loop
    // below perfectly — which is how a check comes to cover nothing.
    expect(subscriptions.length).toBeGreaterThan(1);
  });

  it("can be asked whether it can answer, not merely whether it exists", () => {
    const mute = subscriptions
      .filter(([id]) => createBackend(id, {}).canary === undefined)
      .map(([id]) => id);
    expect(
      mute,
      "these run on credentials that expire and cannot be asked about them, " +
        "so a signed-out one passes setup and fails every job",
    ).toEqual([]);
  });

  it("does not confuse a version string for an answer", () => {
    /**
     * Both methods exist and are different questions. A backend that aliased
     * one to the other would pass the check above while re-creating the bug —
     * `--version` answers "is the binary here", which was never it.
     *
     * Compared by name rather than by holding the references: reading two
     * methods off an object to compare them is the unbound-method shape the
     * linter refuses, and it is right to — a detached method is exactly how
     * `this` goes missing at the one call that matters.
     */
    for (const [id] of subscriptions) {
      const names = Object.getOwnPropertyNames(
        Object.getPrototypeOf(createBackend(id, {})) as object,
      );
      expect(names, id).toContain("health");
      expect(names, id).toContain("canary");
    }
  });
});

/**
 * And what the answer looks like — both ways, through a real child process.
 *
 * The registry check above is structural: it proves a `canary` exists. It
 * would pass just as happily against one that returned `{ healthy: true }`
 * without asking anybody anything, which is the bug wearing the fix's clothes.
 *
 * `signed-out-backend.test.ts` states the gap this closes: `--version`
 * succeeds without credentials, so `health()` reports **healthy** on a machine
 * that cannot answer a single job. These are the same two stand-in binaries
 * pointed at the method that was added to notice.
 */
const SIGNED_OUT = `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("1.2.3"); process.exit(0); }
process.stdout.write("Not logged in \\u00b7 Please run /login\\n");
process.exit(1);
`;

const SIGNED_IN = `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("1.2.3"); process.exit(0); }
process.stdout.write("ok\\n");
process.exit(0);
`;

async function standIn(behaviour: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "byollm-canary-"));
  const binary = join(dir, "fake-cli.mjs");
  await writeFile(binary, behaviour, "utf8");
  await chmod(binary, 0o755);
  return binary;
}

/* Both CLIs, one table. The canary is meant to be one definition of "can it
   answer" rather than two that drift, so it is asserted as one. */
const CLIS = [
  ["claude-cli", (binary: string) => new ClaudeCliBackend(binary)],
  ["codex-cli", (binary: string) => new CodexCliBackend(binary)],
] as const;

describe.each(CLIS)("%s, asked whether it can answer", (id, construct) => {
  it("says no when nobody is signed in, and says why", async () => {
    const backend = construct(await standIn(SIGNED_OUT));

    // The gap this exists for, restated at the point of the fix: the probe
    // that runs `--version` is perfectly happy here.
    expect((await backend.health()).healthy, `${id} health`).toBe(true);

    const asked = await backend.canary("some-model");
    expect(asked.healthy, `${id} canary`).toBe(false);
    // Carries the reason: an unhealthy verdict with nothing to show is one
    // the setup wizard cannot turn into a sentence anybody can act on.
    expect(asked.detail ?? "").not.toBe("");
  }, 30_000);

  it("says yes when it can", async () => {
    /* The control. Without it a canary hard-wired to `false` would pass the
       test above — and would refuse every correctly signed-in machine, which
       is a worse outage than the one being fixed. */
    const asked = await construct(await standIn(SIGNED_IN)).canary(
      "some-model",
    );
    expect(asked.healthy, `${id} canary`).toBe(true);
  }, 30_000);
});
