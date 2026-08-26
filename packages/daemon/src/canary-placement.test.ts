import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Where a canary may be spent — ruled 2026-08-25.
 *
 * A canary is a real call against the owner's subscription. It closes
 * healthy-but-every-job-fails before anybody's work is refused, and it is
 * affordable for exactly one reason: it runs at daemon start and enablement,
 * never on the polling loop.
 *
 * That distinction is one word at one call site. The runner's own tests prove
 * the mechanism — default spends nothing, `{canary: true}` spends once — and a
 * mutation showed they say nothing about whether the *start path* still asks.
 * Deleting `{ canary: true }` from `cli.ts` left every test passing.
 *
 * So this reads the source. It is a lint, and it is the honest tool for the
 * job: the property is about which line calls what, and no unit test of the
 * runner can see the caller.
 */
const src = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

describe("the canary's call sites", () => {
  it("is asked for exactly once, from the start path", () => {
    const cli = src("./cli.ts");
    const asks = [
      ...cli.matchAll(/detectCapabilities\(\{[^)]*canary:\s*true/g),
    ];
    expect(
      asks.length,
      "cli.ts must ask for a canary at daemon start — deleting it is silent",
    ).toBe(1);
  });

  it("is never asked for by the polling loop", () => {
    const runner = src("./runner.ts");
    // `#tick` runs on every heartbeat. It must call the bare form.
    const tick = runner.slice(runner.indexOf("async #tick()"));
    const call = tick.slice(
      tick.indexOf("detectCapabilities"),
      tick.indexOf("detectCapabilities") + 40,
    );
    expect(call, "#tick must not spend a subscription call").not.toContain(
      "canary",
    );
  });

  it("has no other caller quietly spending one", () => {
    // Every place in the package that asks, counted. A third call site is not
    // forbidden — enablement is a legitimate second one — but it must be
    // added here deliberately rather than appearing.
    const files = ["./cli.ts", "./runner.ts", "./setup.ts"];
    const total = files
      .map((f) => [...src(f).matchAll(/canary:\s*true/g)].length)
      .reduce((a, b) => a + b, 0);
    expect(total).toBe(1);
  });
});
