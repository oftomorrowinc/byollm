#!/usr/bin/env node
/**
 * What does this operating system put into a spawned child that we did not?
 *
 * byollm_010 §3 asks a question nobody has answered: the adversarial suite
 * shows Windows injecting variables into every child regardless of the
 * environment handed to `spawn`, the way macOS injects
 * `__CF_USER_TEXT_ENCODING`. Before that can be asserted it has to be
 * measured, and it has to be measured on a real runner.
 *
 * This measures it and prints. It asserts nothing and fails on nothing —
 * turning the answer into an assertion is a deliberate act that comes after
 * reading the answer, because an assertion written to match whatever was
 * observed has stopped testing anything.
 *
 * Run: `pnpm --filter byollm run env-report`
 */
import { spawn } from "node:child_process";
import { childEnv } from "../dist/index.js";

const passed = childEnv();
const probe = "process.stdout.write(JSON.stringify(process.env))";

const received = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["-e", probe], {
    env: passed,
    stdio: ["ignore", "pipe", "inherit"],
    shell: false,
  });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.on("error", reject);
  child.on("close", (code) => {
    if (code !== 0) reject(new Error(`probe exited ${String(code)}`));
    else resolve(JSON.parse(out));
  });
});

const injected = Object.keys(received)
  .filter((name) => !(name in passed))
  .sort();
const dropped = Object.keys(passed).filter((name) => !(name in received));

console.log(`platform: ${process.platform} (${process.arch})`);
console.log(`node:     ${process.version}`);
console.log("");
console.log(
  `we passed ${String(Object.keys(passed).length)}: ${Object.keys(passed).sort().join(", ")}`,
);
console.log("");

if (injected.length === 0) {
  console.log("the OS injected nothing — the child saw exactly the allowlist");
} else {
  console.log(`the OS injected ${String(injected.length)}:`);
  for (const name of injected) {
    // Values matter as much as names: the question is whether any of these
    // carries something a hostile job should not see.
    const value = received[name] ?? "";
    const shown = value.length > 120 ? `${value.slice(0, 120)}…` : value;
    console.log(`  ${name} = ${shown}`);
  }
}

if (dropped.length > 0) {
  console.log("");
  console.log(`dropped in transit (unexpected): ${dropped.join(", ")}`);
}

// Can we take them back? If an injected variable can be overridden by naming
// it explicitly, the two that carry something new could be blanked rather
// than merely documented. On macOS the OS wins — `__CF_USER_TEXT_ENCODING`
// keeps its value even when we pass our own — which suggests injection below
// the process level rather than a merge Node performs. Windows may differ,
// and the difference decides whether the leak is closable or only statable.
if (injected.length > 0) {
  const SENTINEL = "byollm-override-probe";
  const withOverrides = await new Promise((resolve, reject) => {
    const env = { ...passed };
    for (const name of injected) env[name] = SENTINEL;
    const child = spawn(process.execPath, ["-e", probe], {
      env,
      stdio: ["ignore", "pipe", "inherit"],
      shell: false,
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("close", () => {
      resolve(JSON.parse(out));
    });
  });

  const held = injected.filter((name) => withOverrides[name] === SENTINEL);
  console.log("");
  console.log(
    held.length === injected.length
      ? `all ${String(injected.length)} are overridable — we can blank them`
      : held.length === 0
        ? "none are overridable — the OS wins, these can only be documented"
        : `overridable: ${held.join(", ")}; OS wins for the rest`,
  );
}
