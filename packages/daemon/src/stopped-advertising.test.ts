import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeys, signRequest } from "@byollm/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Backend,
  BackendRequest,
  BackendResult,
} from "./backends/index.js";
import { Budgets } from "./budgets.js";
import { ProtocolClient } from "./client.js";
import { DaemonConfig, resolveConfig } from "./config.js";
import { IngressLog } from "./ingress.js";
import { Runner } from "./runner.js";
import { serviceLine } from "./service-line.js";
import { SpendLedger } from "./spend.js";
import { removeTemp } from "./test-support.js";

/**
 * A stopped server may only be advertised if something will start it — B087.
 *
 * B056 ruled that a configured-but-stopped local server advertises, "because
 * it is available one spawn away and B050 starts it when a job arrives." The
 * second half was not true: the starter is behind a seam nothing passes. So
 * `.86` advertises a service whose port has nothing listening, which is the
 * claimed-then-failed outcome B056's own comment forbids.
 *
 * Every test here asks the question from the outside — does this device offer
 * the capability — rather than checking the flag that decides it.
 */
const KEYS = generateKeys(1_800_000_000_000);
const SIGNER = {
  runnerId: "runner_1",
  sign: (input: {
    endpoint: string;
    runnerId: string;
    issuedAt: number;
    body: string;
  }) => signRequest(KEYS, input).signature,
};

/** A server that is installed and NOT running: health says no. */
class StoppedBackend implements Backend {
  readonly stopReasons = {
    kind: "unavailable" as const,
    why: "a test double reads no vendor signal",
  };
  readonly id = "ollama" as const;
  readonly class = "http" as const;
  healthy = false;
  health(): Promise<{ healthy: boolean; models: string[] }> {
    return Promise.resolve({
      healthy: this.healthy,
      models: this.healthy ? ["llama3.2"] : [],
    });
  }
  execute(_request: BackendRequest): Promise<BackendResult> {
    return Promise.resolve({
      ok: true,
      text: "x",
      durationMs: 1,
      stop: "end" as const,
    });
  }
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-b087-"));
});
afterEach(async () => {
  await removeTemp(dir);
});

async function detect(options: {
  backend: Backend;
  spawnServer?: (command: readonly string[]) => void;
}) {
  const loaded = resolveConfig(
    DaemonConfig.parse({
      services: {
        local: {
          model: "llama3.2",
          kinds: ["llm.generate"],
          type: "ollama",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
      },
    }),
  );
  const budgets = new Budgets(join(dir, "b.json"), loaded.config.community);
  await budgets.load(Date.now());
  const spend = new SpendLedger(join(dir, "spend.json"));
  await spend.load(Date.now());
  const runner = new Runner({
    client: new ProtocolClient({
      origin: "https://app.test",
      identity: SIGNER,
      fetch: () =>
        Promise.resolve(
          new Response("{}", {
            headers: { "content-type": "application/json" },
          }),
        ),
    }),
    runnerId: "runner_1",
    identity: {
      keys: () => Promise.resolve(KEYS),
      sites: new Map(),
    },
    owner: "me",
    daemonVersion: "0.0.0",
    loaded,
    budgets,
    spend,
    ingress: new IngressLog({
      path: join(dir, "ingress.log"),
      communityPromptDays: 7,
      keepSelfPrompts: true,
    }),
    /* The binary IS installed — that is the whole point. Injected so the
       verdict does not depend on whether this machine happens to have
       ollama, which is how a sibling test passed here and failed on CI. */
    onPath: () => Promise.resolve(true),
    ...(options.spawnServer === undefined
      ? {}
      : { spawnServer: options.spawnServer }),
    backendFactory: () => options.backend,
  });
  const capabilities = await runner.detectCapabilities();
  return { capabilities, states: runner.serviceStates };
}

describe("advertising a stopped server", () => {
  it("does not offer it while nothing will start it", async () => {
    /* The shipped defect. Installed, stopped, no starter: a site that routes
       here reaches a port with nothing listening. */
    const { capabilities } = await detect({ backend: new StoppedBackend() });
    expect(
      capabilities,
      "a stopped server was advertised with no starter behind it",
    ).toEqual([]);
  });

  it("offers it as soon as a starter exists", async () => {
    /**
     * The control, and it is what makes the fix a rule rather than an off
     * switch. Advertising is tied to the starter EXISTING — so wiring
     * `spawnServer` restores B056's ruling on its own, and the two facts
     * cannot drift apart the way they did.
     */
    const { capabilities } = await detect({
      backend: new StoppedBackend(),
      spawnServer: () => {
        /* Presence is the whole point; it never has to do anything here. */
      },
    });
    expect(capabilities.length).toBeGreaterThan(0);
  });

  it("still offers a server that is actually running", async () => {
    /* The other control. Without it, "advertise nothing" passes the first
       case — and a device that offers nothing is a worse bug than this one. */
    const backend = new StoppedBackend();
    backend.healthy = true;
    const { capabilities } = await detect({ backend });
    expect(capabilities.length).toBeGreaterThan(0);
  });

  it("tells the owner the truth about what will happen", async () => {
    /**
     * The same untruth on the other surface. `byollm status` printed
     * "not running (starts when a job needs it)" unconditionally, which is a
     * promise the device could not keep — on the one screen an owner checks
     * to find out what their device is doing.
     */
    const { states } = await detect({ backend: new StoppedBackend() });
    const state = states.get("local")?.state;
    expect(state).toMatchObject({ kind: "stopped", starts: false });

    const withStarter = await detect({
      backend: new StoppedBackend(),
      spawnServer: () => {
        /* Presence is the whole point; it never has to do anything here. */
      },
    });
    expect(withStarter.states.get("local")?.state).toMatchObject({
      kind: "stopped",
      starts: true,
    });
  });

  it("does not print a promise it cannot keep", async () => {
    /**
     * The sentence itself, not the flag behind it. Asserting the state alone
     * let a mutation that ignored the flag and printed the promise anyway
     * pass every other test in this file — the renderer is a separate
     * decision and needs its own reader.
     */
    const { states } = await detect({ backend: new StoppedBackend() });
    const state = states.get("local")?.state;
    expect(state).toBeDefined();
    if (state === undefined) return;
    const line = serviceLine({
      service: "local",
      device: "this device",
      state,
    }).line;
    expect(line).toContain("not running");
    expect(
      line,
      "the owner is promised a start that nothing will perform",
    ).not.toContain("starts when a job needs it");

    /* The control: with a starter, the promise is true and is kept. */
    const withStarter = await detect({
      backend: new StoppedBackend(),
      spawnServer: () => {
        /* Presence is the whole point; it never has to do anything here. */
      },
    });
    const startedState = withStarter.states.get("local")?.state;
    expect(startedState).toBeDefined();
    if (startedState === undefined) return;
    expect(
      serviceLine({
        service: "local",
        device: "this device",
        state: startedState,
      }).line,
    ).toContain("starts when a job needs it");
  });
});
