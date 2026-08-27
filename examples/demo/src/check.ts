/**
 * Executes the demo in CI so it cannot rot.
 *
 * The standards rule is that every example in the docs runs in CI. This boots
 * the real demo server as a subprocess and drives the pages a person would:
 * the landing page with no runner, the pairing page, and the enqueue form.
 * It does not pair a daemon — the conformance kit already certifies that path
 * exhaustively — it proves the example itself still works.
 */
import { SERVED_PROTOCOL_VERSION } from "@byollm/server";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = 8799;
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;
const SERVER = fileURLToPath(new URL("./server.ts", import.meta.url));

const child = spawn(process.execPath, ["--experimental-strip-types", SERVER], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  process.stdout.write(`  ${condition ? "✓" : "✗"} ${name}\n`);
  if (!condition) {
    failures += 1;
    if (detail !== "") process.stdout.write(`      ${detail}\n`);
  }
}

try {
  await waitForServer();
  process.stdout.write("\ndemo example\n");

  const home = await (await fetch(ORIGIN)).text();
  check("landing page renders", home.includes("BYOLLM demo"));
  check(
    "says plainly that no runner is online",
    home.includes("No runner online"),
    "the no-runner state must be visible, not a silent empty page",
  );

  const pair = await (await fetch(`${ORIGIN}/pair`)).text();
  check("pairing page renders", pair.includes("Connect a machine"));
  check(
    "pairing page shows the connect command",
    pair.includes("npx byollm@alpha connect"),
  );

  const badPair = await fetch(`${ORIGIN}/pair`, {
    method: "POST",
    body: new URLSearchParams({ code: "ZZZZ-ZZZZ" }),
  });
  check(
    "an unknown pairing code fails with a reason",
    (await badPair.text()).includes("Could not pair"),
  );

  const enqueue = await fetch(ORIGIN, {
    method: "POST",
    body: new URLSearchParams({ prompt: "hello" }),
  });
  const enqueued = await enqueue.text();
  check(
    "enqueueing with no runner reports it rather than hanging",
    enqueued.includes("No runner"),
    "job.result() must reject with noRunnerAvailable, not wait forever",
  );

  /**
   * The version comes from the package, not from a literal.
   *
   * This sent `"0"`, and when `PROTOCOL_VERSION` became `"1"` the mount
   * answered `400 unsupported-protocol-version` instead of `401` — a correct
   * refusal for the wrong question. The version fence runs *before*
   * authentication, which is the right order: a server cannot meaningfully
   * decide who you are over a protocol it does not speak.
   *
   * So this asks the real question — a caller speaking the current protocol
   * and offering no identity — and `SERVED_PROTOCOL_VERSION` is what the
   * server itself answers with, so a future bump moves both ends at once.
   */
  const protocolProbe = await fetch(`${ORIGIN}/byollm/claim`, {
    method: "POST",
    body: JSON.stringify({ protocolVersion: SERVED_PROTOCOL_VERSION }),
  });
  check(
    "the protocol mount refuses an unauthenticated claim",
    protocolProbe.status === 401,
    `got ${String(protocolProbe.status)}`,
  );

  const staleProbe = await fetch(`${ORIGIN}/byollm/claim`, {
    method: "POST",
    body: JSON.stringify({ protocolVersion: "0" }),
  });
  check(
    "and tells an out-of-date client to upgrade, rather than 'bad request'",
    staleProbe.status === 400 &&
      (await staleProbe.text()).includes("Upgrade the daemon"),
    `got ${String(staleProbe.status)}`,
  );
} finally {
  child.kill("SIGTERM");
}

process.stdout.write(
  failures === 0
    ? "\n  demo example works\n"
    : `\n  ${String(failures)} demo check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await fetch(ORIGIN, { signal: AbortSignal.timeout(500) });
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error("demo server did not start");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
