import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DAEMON_VERSION } from "./index.js";

describe("DAEMON_VERSION", () => {
  it("matches the published package version", async () => {
    // The daemon reports this on pairing and on every heartbeat, and an app's
    // runner list shows it. A stale constant is a lie told to every user, so
    // the two are pinned together here rather than by convention.
    const manifest = JSON.parse(
      await readFile(
        fileURLToPath(new URL("../package.json", import.meta.url)),
        "utf8",
      ),
    ) as { version: string };
    expect(DAEMON_VERSION).toBe(manifest.version);
  });
});
