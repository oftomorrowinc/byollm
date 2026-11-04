import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MUST_IDS, mustsVerifiedBy } from "@byollm/protocol";
import { describe, expect, it } from "vitest";
import {
  isStable,
  mustBlocksIn,
  pendingMustsIn,
  refusal,
} from "./pending-musts-hold-the-cut.mjs";

/**
 * Pending MUSTs hold the cut — #7053, amended by Owl (#55886 point 3).
 *
 * In the shape of `tag-refuses-an-unseen-tree.test.mjs`: what the gate
 * decides is tested as a function, and that `tag.sh` and the rehearsal
 * actually ASK it is tested against their code, because a gate nobody runs
 * passes every cut.
 */

const read = (name) =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
const source = read("../packages/protocol/src/musts.ts");
/** What a shell script RUNS: comments and echoes removed. */
const ran = (text) =>
  text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .filter((line) => !/^\s*echo\b/u.test(line))
    .join("\n");
const jsCode = (text) =>
  text.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/^[ \t]*\/\/.*$/gmu, "");

const tool = (id) => ({ id, tool: true });
const image = (id) => ({ id, tool: false });

describe("what the gate reads", () => {
  it("reads every MUST entry, or it compares nothing", () => {
    expect(mustBlocksIn(source)).toBe(MUST_IDS.length);
  });

  it("reads the same pending set from the source as the registry reports", () => {
    // Two sources: the text the tag gate reads, and the registry as built.
    expect(pendingMustsIn(source).map((m) => m.id)).toEqual(
      [...mustsVerifiedBy("pending")].sort(),
    );
  });

  it("does not mistake a planned record for the entry's own kind", () => {
    const text =
      '\n  X_ONE: must({\n    verifiedBy: "conformance",\n' +
      '    source: "byollm_012 §12",\n' +
      '    planned: { verifiedBy: "pending", checks: [] },\n  }),' +
      '\n  X_TWO: must({\n    verifiedBy: "pending",\n' +
      '    source: "byollm_021 §10",\n' +
      '    planned: { verifiedBy: ["operator", "conformance"], checks: ["C048"] },\n  }),';
    expect(pendingMustsIn(text)).toEqual([image("X_TWO")]);
  });

  it("knows a tool MUST by its byollm_012 source", () => {
    const text =
      '\n  X_TOOL: must({\n    verifiedBy: "pending",\n' +
      '    source: "byollm_012 §12",\n  }),';
    expect(pendingMustsIn(text)).toEqual([tool("X_TOOL")]);
  });
});

describe("what the gate decides", () => {
  it("refuses a stable cut while any MUST is pending", () => {
    expect(refusal("0.1.5", [tool("TOOLS_RUN_AT_SITE")])).toContain(
      "TOOLS_RUN_AT_SITE",
    );
    expect(refusal("0.1.5", [image("BLOBS_SEALED")])).toContain("BLOBS_SEALED");
  });

  it("refuses a beta while an image MUST is pending — the blob path goes live on it", () => {
    const why = refusal("0.1.5-beta.1", [
      tool("TOOLS_RUN_AT_SITE"),
      image("BLOBS_SEALED"),
    ]);
    expect(why).toContain("BLOBS_SEALED");
    expect(why).not.toContain("TOOLS_RUN_AT_SITE");
  });

  it("lets the tool MUSTs ride on a beta, as the cut line allows", () => {
    expect(refusal("0.1.5-beta.1", [tool("TOOLS_RUN_AT_SITE")])).toBeNull();
  });

  it("lets anything through with nothing pending", () => {
    expect(refusal("0.1.5", [])).toBeNull();
    expect(refusal("0.1.5-beta.1", [])).toBeNull();
    expect(isStable("0.1.5")).toBe(true);
    expect(isStable("0.1.5-beta.1")).toBe(false);
  });
});

describe("who asks it", () => {
  it("is run by tag.sh with the version, and its refusal stops the tag", () => {
    expect(ran(read("./tag.sh"))).toMatch(
      /node scripts\/pending-musts-hold-the-cut\.mjs "\$version" \|\| exit 1/u,
    );
  });

  it("is asked by the rehearsal, so the cut has no surprise in it", () => {
    expect(jsCode(read("./rehearse-the-cut.mjs"))).toMatch(
      /ask\("6b\. [^"]+",[\s\S]{0,200}pending-musts-hold-the-cut\.mjs/u,
    );
  });
});
