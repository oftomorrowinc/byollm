import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const fixture = readFileSync(
  new URL("./fixtures/bump-version/readme.md", import.meta.url),
  "utf8",
);
const script = fileURLToPath(new URL("./bump-version.mjs", import.meta.url));

describe("the version bump preserves README history", () => {
  let root;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("changes the live banner and leaves marked and unmarked history alone", () => {
    root = mkdtempSync(join(tmpdir(), "byollm-bump-version-"));
    mkdirSync(join(root, "packages/protocol"), { recursive: true });
    mkdirSync(join(root, "packages/daemon/src"), { recursive: true });
    mkdirSync(join(root, "site"), { recursive: true });

    writeFileSync(
      join(root, "packages/protocol/package.json"),
      '{\n  "version": "0.1.0-alpha.21"\n}\n',
    );
    writeFileSync(join(root, "packages/protocol/README.md"), fixture);
    writeFileSync(
      join(root, "packages/daemon/package.json"),
      '{\n  "version": "0.1.0-alpha.21"\n}\n',
    );
    writeFileSync(join(root, "README.md"), fixture);
    writeFileSync(
      join(root, "site/index.html"),
      "<b>Alpha (0.1.0-alpha.21) — active</b>\n",
    );
    writeFileSync(
      join(root, "packages/daemon/src/index.ts"),
      'export const DAEMON_VERSION = "0.1.0-alpha.21";\n',
    );

    execFileSync(process.execPath, [script, "0.1.0-alpha.22"], { cwd: root });

    const after = readFileSync(
      join(root, "packages/protocol/README.md"),
      "utf8",
    );

    expect(after).toContain("**Alpha (`0.1.0-alpha.22`) ");
    expect(after).toContain("<!-- release-note 0.1.0-alpha.21 -->");
    expect(after).toContain("so `0.1.0-alpha.21` is that release, whole.");
    expect(after).toContain("`0.1.0-alpha.8`.");
    expect(after).toContain("Breaking in `0.1.0-alpha.12`");
    expect(after.match(/0\.1\.0-alpha\.22/g)).toHaveLength(1);

    expect(
      readFileSync(join(root, "packages/protocol/package.json"), "utf8"),
    ).toContain('"version": "0.1.0-alpha.22"');
    expect(readFileSync(join(root, "site/index.html"), "utf8")).toContain(
      "Alpha (0.1.0-alpha.22)",
    );
    expect(
      readFileSync(join(root, "packages/daemon/src/index.ts"), "utf8"),
    ).toContain('DAEMON_VERSION = "0.1.0-alpha.22"');
  });
});
