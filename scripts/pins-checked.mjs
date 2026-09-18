#!/usr/bin/env node
/**
 * Do the hosted repositories pin the version this release is about? — B234.
 *
 *   node scripts/pins-checked.mjs 0.1.0-alpha.103 --manifests-only --committed
 *
 * This repository publishes the packages; it is not where their versions are
 * written down a second time. `byollm-cloud` pins them in `hub/package.json`
 * and `byollm-cloud-web` pins them in its pnpm catalog, and three releases in
 * a row (`.95`, `.96`, `.97`) those pins moved because somebody remembered to
 * move them. On `.97` nobody did, and it was caught by a question rather than
 * by a check.
 *
 * So the check lives next to the pins — `byollm-cloud/scripts/pins-agree.mjs`,
 * which reads both repositories and explains itself at length — and this file
 * is the part that belongs here: **finding it, and deciding what its absence
 * means.**
 *
 * ## Absence is a refusal, not a pass
 *
 * A machine without those checkouts cannot answer the question, and "cannot
 * answer" is the one thing this must never render as green — that is the
 * failure mode this repository has shipped more than once, most recently as a
 * console fence nobody was behind. The packages here are published by whoever
 * holds the pins; if you are not that person you are not cutting this release,
 * and if you are, the checkouts are on your machine.
 *
 * `BYOLLM_PINS=skip` opts out, says so in capital letters, and is a sentence
 * somebody typed rather than a step somebody forgot. That difference is the
 * entire subject of this file.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CHECKER = resolve(
  ROOT,
  "..",
  "byollm-cloud",
  "scripts",
  "pins-agree.mjs",
);

if (process.env["BYOLLM_PINS"] === "skip") {
  console.error(
    "\n  BYOLLM_PINS=skip — THE HOSTED PINS ARE NOT CHECKED FOR THIS STEP.\n" +
      "  Whatever passes after this line says nothing about whether the hub\n" +
      "  and the web catalog name this version.\n",
  );
  process.exit(0);
}

if (!existsSync(CHECKER)) {
  console.error(
    `\nrefusing: the hosted pin check is not on this machine.\n\n` +
      `  looked for: ${CHECKER}\n\n` +
      `  The versions published from this repository are pinned again in two\n` +
      `  sibling repositories, and a release is only honest when all three\n` +
      `  agree. This machine cannot see them, so it cannot say they agree —\n` +
      `  and a check that cannot answer must not answer "fine".\n\n` +
      `  If you are not cutting a byollm.cloud release, you are not the one\n` +
      `  publishing these packages: BYOLLM_PINS=skip says so out loud.\n`,
  );
  process.exit(1);
}

/**
 * `spawn` with a fixed argv array, never `spawnSync` — byollm_004 §2 bans the
 * shell-invoking spellings and eslint enforces it, which is the whole reason a
 * script this sequential ends in a promise.
 */
const status = await new Promise((settle) => {
  const child = spawn(process.execPath, [CHECKER, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  child.on("error", () => {
    settle(1);
  });
  child.on("close", (code) => {
    /* A signal is not an exit code, and `null` would become 0 — the pass this
       file exists to refuse. Out of memory, a stray `pkill`, a closed lid:
       none of them is evidence that two repositories agree about a version. */
    settle(code ?? 1);
  });
});
process.exit(status);
