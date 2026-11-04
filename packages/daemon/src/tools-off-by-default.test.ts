import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Budgets } from "./budgets.js";
import { runCli } from "./cli.js";
import { ProtocolClient } from "./client.js";
import { DaemonConfig, resolveConfig } from "./config.js";
import { IngressLog } from "./ingress.js";
import { daemonPaths } from "./paths.js";
import { Runner } from "./runner.js";
import { SpendLedger } from "./spend.js";
import { noSupervisor, removeTemp } from "./test-support.js";
import { fakeModel } from "./tools.test.support.js";

/**
 * C044 off by default, and the probe that decides "on" — byollm_012 §7,
 * byollm_021 §R2 guard (a).
 *
 * A plain upgrade advertises nothing new: `llm.tools` is advertised only by a
 * service that lists it, and only once its model has passed the probe. The
 * owner learns how to turn it on, and why it is not on, from `byollm services`
 * — the command 012 §7 calls `byollm backends`, renamed since.
 */

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

async function advertised(kinds: string[], probe: "answers" | "refuses") {
  const model = await fakeModel(() => ({ text: "unused" }), { probe });
  const dir = await mkdtemp(join(tmpdir(), "byollm-tools-off-"));
  cleanup.push(
    () => model.close(),
    () => removeTemp(dir),
  );
  const loaded = resolveConfig(
    DaemonConfig.parse({
      services: {
        local: {
          model: "m",
          kinds,
          type: "openai-http",
          baseUrl: model.baseUrl,
        },
      },
    }),
  );
  const budgets = new Budgets(join(dir, "b.json"), loaded.config.community);
  const spend = new SpendLedger(join(dir, "s.json"));
  const runner = new Runner({
    client: new ProtocolClient({ origin: "https://unused.invalid" }),
    runnerId: "local",
    owner: "me",
    daemonVersion: "0.0.0",
    loaded,
    budgets,
    spend,
    ingress: new IngressLog({
      path: join(dir, "i.log"),
      communityPromptDays: 7,
      keepSelfPrompts: true,
    }),
  });
  const capabilities = await runner.detectCapabilities();
  return { kinds: capabilities.map((c) => c.kind), runner, model };
}

async function services(kinds: string[], probe: "answers" | "refuses") {
  const model = await fakeModel(() => ({ text: "unused" }), { probe });
  const home = await mkdtemp(join(tmpdir(), "byollm-tools-cli-"));
  cleanup.push(
    () => model.close(),
    () => removeTemp(home),
  );
  const paths = daemonPaths(home);
  await writeFile(
    paths.config,
    JSON.stringify({
      services: {
        local: {
          model: "m",
          kinds,
          type: "openai-http",
          baseUrl: model.baseUrl,
        },
      },
    }),
  );
  let out = "";
  await runCli(["services"], {
    paths,
    io: {
      out: (text) => {
        out += text;
      },
      err: () => undefined,
    },
    service: noSupervisor(),
  });
  return out;
}

describe("C044 off by default", () => {
  it("does not advertise llm.tools for a service with no tools setting", async () => {
    const { kinds } = await advertised(["llm.chat"], "answers");
    expect(kinds).toEqual(["llm.chat"]);
  });

  it("has `byollm services` say how to turn them on", async () => {
    const out = await services(["llm.chat"], "answers");
    expect(out).toContain("local does not use sites' tools (off by default)");
    expect(out).toContain('add "llm.tools" to services.local.kinds');
  });

  it("says nothing about turning on what is already on", async () => {
    const out = await services(["llm.chat", "llm.tools"], "answers");
    expect(out).not.toContain("off by default");
  });
});

describe("the probe — echo_number, 7, and the answer used (byollm_012 §7)", () => {
  it("advertises llm.tools when the model calls echo_number with 7 and uses the result", async () => {
    const { kinds } = await advertised(["llm.chat", "llm.tools"], "answers");
    expect(kinds).toEqual(["llm.chat", "llm.tools"]);
  });

  it("does not advertise it for a model that cannot call functions, and says why", async () => {
    const { kinds, runner } = await advertised(
      ["llm.chat", "llm.tools"],
      "refuses",
    );
    expect(kinds).toEqual(["llm.chat"]);
    expect(runner.toolsProbes.get("local")).toMatchObject({ kind: "cannot" });

    const out = await services(["llm.chat", "llm.tools"], "refuses");
    expect(out).toContain("✗ llm.tools");
    expect(out).toContain("answered without calling echo_number");
  });

  it("asks once a session, not once a pass", async () => {
    const { runner, model } = await advertised(["llm.tools"], "answers");
    await runner.detectCapabilities();
    await runner.detectCapabilities();
    // The probe's two turns, once: a hosted model bills for each.
    expect(runner.toolsProbes.get("local")).toEqual({ kind: "calls-tools" });
    expect(model.probes()).toBe(2);
  });
});
