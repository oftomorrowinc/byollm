import { readFile, writeFile } from "node:fs/promises";
import type { BackendId } from "@byollm/protocol";
import { knownModelsFor } from "./known-models.js";

/**
 * `byollm model` — byollm_017 Phase 1.
 *
 * ## The config on the device is the truth (ruling 1)
 *
 * Every path to a model change ends here: the daemon writes
 * `services.<name>.model` and re-announces. There is no hub-side "desired
 * model" column that a device may or may not honour, because a cloud row that
 * disagrees with the machine is two truths and the machine is the one that
 * runs the job.
 *
 * ## Found is not works (ruling 2)
 *
 * A candidate is probed with one real call before it is written, and the
 * CLI's own first line comes back on refusal — "model not found", "not
 * available on your plan", "needs sign-in". A model that cannot answer is
 * never stored, which is what makes free text safe: the promise is that a
 * model released this morning works this morning, and the check that keeps
 * that honest is a probe rather than a list.
 *
 * On refusal the config is byte-identical afterwards. Not "restored" —
 * untouched, because nothing is written until the probe answers.
 */

export interface ModelIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** What the caller needs to know without this module owning the process. */
export interface ModelResult {
  readonly changed: boolean;
  readonly code: 0 | 1 | 2;
}

interface ConfigShape {
  services?: Record<string, { type?: string; model?: string }>;
}

async function readConfig(path: string): Promise<ConfigShape | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as ConfigShape;
  } catch {
    return undefined;
  }
}

/**
 * Every service and the model it runs — `byollm models`.
 *
 * The plural verb exists because the singular one needs a service name, and
 * somebody who has just been told to run `byollm model <service> <model>` may
 * not know what this machine calls its services. A command whose first
 * argument you have to guess is a command with a prerequisite nobody
 * mentioned.
 */
export async function listModels(
  configPath: string,
  io: ModelIo,
): Promise<ModelResult> {
  const config = await readConfig(configPath);
  const services = config?.services ?? {};
  const names = Object.keys(services);
  if (names.length === 0) {
    io.err(
      `No services in ${configPath}.\n` +
        "Run `byollm setup` to find what this computer already has.\n",
    );
    return { changed: false, code: 1 };
  }
  for (const name of names) {
    const entry = services[name];
    io.out(`  ${name.padEnd(16)} ${entry?.model ?? "(no model set)"}\n`);
  }
  return { changed: false, code: 0 };
}

/**
 * One service's model, and what its CLI is known to accept.
 *
 * The suggestions are printed as suggestions. Free text is the promise
 * (ruling 3), so this must not read as a menu — the sentence says "known to
 * this build", which is both true and a hint that a newer name is fine.
 */
export async function showModel(
  configPath: string,
  service: string,
  io: ModelIo,
): Promise<ModelResult> {
  const config = await readConfig(configPath);
  const entry = config?.services?.[service];
  if (entry === undefined) {
    io.err(
      `No service called ${JSON.stringify(service)} in ${configPath}.\n` +
        "Run `byollm models` to see what this device has.\n",
    );
    return { changed: false, code: 1 };
  }
  io.out(`  ${service}: ${entry.model ?? "(no model set)"}\n`);
  const known = knownModelsFor((entry.type ?? "") as BackendId);
  if (known.length > 0) {
    io.out(
      `\n  Known to this build: ${known.join(", ")}\n` +
        "  Any name its CLI accepts works — this checks before it saves.\n",
    );
  }
  return { changed: false, code: 0 };
}

/**
 * The probe, as a function rather than as a closure in the router.
 *
 * It lived inline in `commandModel`, where it could only be exercised by
 * running the real backend — which for a local server means a network call
 * whose answer depends on whether Ollama happens to be running on the machine
 * executing the tests. "Hard to test" was the signal that it was in the wrong
 * file.
 *
 * One definition of "answers", shared with `setup`: health first, then the
 * cheapest true call the backend has. A backend with no canary returns
 * `undefined` — not asked, which is not no.
 */
export function backendVerifier(
  make: (id: BackendId) => {
    canary?: (model: string) => Promise<{ healthy: boolean; detail?: string }>;
  },
) {
  return async (
    id: BackendId,
    candidate: string,
  ): Promise<{ answers: boolean | undefined; detail?: string | undefined }> => {
    const backend = make(id);
    if (backend.canary === undefined) return { answers: undefined };
    const proof = await backend.canary(candidate);
    return {
      answers: proof.healthy,
      ...(proof.detail === undefined ? {} : { detail: proof.detail }),
    };
  };
}

/**
 * Set it, having proved it answers.
 *
 * `verify` is injected because the real one spawns the vendor CLI, and
 * because this is the one function whose whole contract is "what happens when
 * the probe says no".
 */
export async function setModel(
  input: {
    readonly configPath: string;
    readonly service: string;
    readonly model: string;
  },
  io: ModelIo,
  verify: (
    id: BackendId,
    model: string,
  ) => Promise<{ answers: boolean | undefined; detail?: string | undefined }>,
): Promise<ModelResult> {
  const raw = await readFile(input.configPath, "utf8").catch(() => undefined);
  if (raw === undefined) {
    io.err(`No config at ${input.configPath}. Run \`byollm setup\` first.\n`);
    return { changed: false, code: 1 };
  }
  const config = JSON.parse(raw) as ConfigShape;
  const entry = config.services?.[input.service];
  if (entry === undefined) {
    io.err(
      `No service called ${JSON.stringify(input.service)}.\n` +
        "Run `byollm models` to see what this device has.\n",
    );
    return { changed: false, code: 1 };
  }
  if (entry.model === input.model) {
    // Not an error and not a write. Saying so is cheaper than a probe, and a
    // no-op that reported success would be indistinguishable from one that
    // had actually checked.
    io.out(`  ${input.service} is already on ${input.model}.\n`);
    return { changed: false, code: 0 };
  }

  io.out(`  Checking ${input.model} answers on ${input.service}…\n`);
  const proof = await verify((entry.type ?? "") as BackendId, input.model);
  if (proof.answers === false) {
    io.err(
      `\n  ${input.service} refused ${input.model}:\n` +
        (proof.detail === undefined ? "" : `    ${proof.detail}\n`) +
        `\n  Nothing was changed — ${input.service} is still on ` +
        `${entry.model ?? "its previous model"}.\n`,
    );
    return { changed: false, code: 1 };
  }

  /**
   * `undefined` is not a refusal.
   *
   * A backend with no canary cannot be asked, and reading "not asked" as
   * "does not work" would make this command impossible for every local model
   * server — the same third state that had to be defended in `setup`. It is
   * written, and the daemon's own health reporting says the rest.
   */
  if (proof.answers === undefined) {
    io.out(
      `  ${input.service} has no way to check a model before use — ` +
        "saving it.\n",
    );
  }

  entry.model = input.model;
  await writeFile(input.configPath, `${JSON.stringify(config, null, 2)}\n`);
  io.out(
    `\n  ${input.service} is now on ${input.model}.\n` +
      "  Restart the daemon to pick it up: `byollm install` if it runs in " +
      "the\n  background, or Ctrl-C and `byollm run` if it is in a " +
      "terminal.\n",
  );
  return { changed: true, code: 0 };
}
