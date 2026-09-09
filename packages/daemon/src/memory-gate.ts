import { BACKENDS, type BackendId } from "@byollm/protocol";
import type { MemoryPressure, MemoryReading } from "./memory.js";

/**
 * Whether this machine should take a job that loads a model — B080.
 *
 * Kevin's Qwen on one local server, an 18 GB Gemma on another, a 36 GB Mac
 * with swap at 97%, and about thirty system daemons restarting at once.
 * Ollama loaded 17 GB into 5.2 GiB free because nothing asked whether there
 * was room — not Ollama, and not us.
 *
 * ## It gates on the BACKEND, not on the deployment
 *
 * The registry already carries the fact that matters: only `cost: "free"`
 * backends serve a model out of local memory. Everything `metered` or
 * `subscription` is a proxy to somebody else's hardware, and there is nothing
 * for a memory gate to protect.
 *
 * That one rule does three things at once. Hosted boxes are inert by
 * construction rather than by luck, since 018 forbids local serving on one
 * and every service there is a proxy. Three of Todd's four configured
 * services are exempt with no special case — `glm-5.2:cloud` is
 * cloud-proxied, `claude` and `codex` are subscriptions. And it is one more
 * fact derived from `BACKENDS` rather than a list somebody maintains.
 *
 * ## It refuses rarely, on purpose
 *
 * The owner already consented by configuring the service, and Todd's ruling
 * is that this consent is enough: a memory floor is second-guessing somebody
 * about their own machine. So this exists for the fleet nobody is watching,
 * not for the laptop whose owner is in the room — and the acceptance test is
 * his: **none of his four authorised services is ever refused in ordinary
 * use.** If it fires there, the default is wrong, not his machine.
 */
export interface GateInput {
  readonly backendId: BackendId;
  readonly memory: MemoryReading;
  readonly pressure: MemoryPressure;
  /** Bytes. Deliberately low — see {@link DEFAULT_FLOOR_BYTES}. */
  readonly floorBytes?: number;
}

/**
 * 2 GB, and low on purpose.
 *
 * An 8 GB floor would refuse on the machine that prompted this row, tonight,
 * while it holds 6.6 GB and serves jobs perfectly. That is the `os.freemem()`
 * failure wearing a different number: broken closed on a machine that is
 * fine. Below 2 GB is dire by any reading and does not happen in ordinary
 * use — which is the point, because this is a backstop under the pressure
 * signal rather than the primary judgement.
 */
export const DEFAULT_FLOOR_BYTES = 2 * 1024 * 1024 * 1024;

export type GateDecision =
  | { readonly admit: true; readonly why: string }
  | { readonly admit: false; readonly why: string };

export function memoryGate(input: GateInput): GateDecision {
  const cost = BACKENDS[input.backendId].cost;
  if (cost !== "free") {
    return {
      admit: true,
      why: `${input.backendId} is a proxy (${cost ?? "detected"}), so it holds no model here`,
    };
  }

  /**
   * Unknown admits, and says so somewhere a person will read it.
   *
   * Refusing where we cannot measure bricks the daemon on a platform nobody
   * has visited; admitting silently means the guard does not exist and
   * nobody knows. This is `stopReasons`' `unavailable` one layer down.
   */
  if (input.memory.kind !== "read") {
    return {
      admit: true,
      why: `memory could not be read (${input.memory.why}), so the guard is not active here`,
    };
  }

  /**
   * Critical only, never warn — verified rather than assumed.
   *
   * `kern.memorystatus_vm_pressure_level` reads **2, warn** on the machine
   * this row exists for, stably, while it holds 6.6 GB available and serves
   * jobs. Critical is the state where the kernel is already killing things,
   * which is the only state where refusing a job is the kinder answer.
   */
  if (input.pressure === "critical") {
    return { admit: false, why: "the kernel reports critical memory pressure" };
  }

  const floor = input.floorBytes ?? DEFAULT_FLOOR_BYTES;
  if (input.memory.availableBytes < floor) {
    return {
      admit: false,
      why:
        `${bytes(input.memory.availableBytes)} available, under the ` +
        `${bytes(floor)} floor`,
    };
  }

  /**
   * Swap, and the landmine that lives here.
   *
   * **`swapTotalBytes === 0` means "no swap is configured", never "swap
   * headroom is exhausted."** A ratio would be 0/0. Kubernetes nodes run
   * with swap disabled, so every hosted box reads zero — and a careless
   * "refuse when swap headroom is gone" refuses every job on every box
   * forever, which is broken-closed again on machines that are fine.
   *
   * Third time this week the same distinction decided a design: absent is
   * not empty, the way `unavailable` is not `unverified` and `"unknown"` is
   * not `"end"`.
   */
  const { swapTotalBytes, swapFreeBytes } = input.memory;
  if (
    swapTotalBytes !== undefined &&
    swapTotalBytes > 0 &&
    swapFreeBytes !== undefined &&
    swapFreeBytes < 64 * 1024 * 1024
  ) {
    return {
      admit: false,
      why: `swap is configured and effectively exhausted (${bytes(swapFreeBytes)} free)`,
    };
  }

  return {
    admit: true,
    why: `${bytes(input.memory.availableBytes)} available, pressure ${input.pressure}`,
  };
}

function bytes(n: number): string {
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
