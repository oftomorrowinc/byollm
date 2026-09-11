import { type BackendId, resolveCost } from "@byollm/protocol";
import type { MemoryPressure, MemoryReading } from "./memory.js";

/**
 * Whether this machine should take a job that loads a model — B080.
 *
 * Kevin's Qwen on one local server, an 18 GB Gemma on another, a 36 GB Mac
 * with swap at 97%, and about thirty system daemons restarting at once.
 * Ollama loaded 17 GB into 5.2 GiB free because nothing asked whether there
 * was room — not Ollama, and not us.
 *
 * ## It gates on the RESOLVED cost, and it must ASK
 *
 * Only a service that resolves `free` serves a model out of local memory.
 * Everything `metered` or `subscription` is a proxy to somebody else's
 * hardware, and there is nothing for a memory gate to protect.
 *
 * **Which service is free is a question, not a field.** The first draft of
 * this gate read `BACKENDS[id].cost` — and `openai-http` declares `null`,
 * because its cost is classified from where the request goes rather than
 * declared by the registry. So `cost !== "free"` was true, and the gate
 * admitted the generic backend without ever looking at memory: 100 MB
 * available, `{"admit": true, "why": "openai-http is a proxy (detected)"}`.
 *
 * That is precisely the backend this row exists for. `openai-http` at a
 * loopback address is the documented way to reach a local model server — the
 * site says *"Not listed? openai-http reaches anything OpenAI-compatible"* —
 * and it is what Todd's own MLX server on port 6999 is configured as. The
 * gate called his local model a proxy and skipped the check.
 *
 * The law was already written, in the function being bypassed:
 * {@link resolveCost}'s signature was hardened after `byollm offer` passed
 * two of three arguments, and its comment records that *"the
 * no-re-derivation law was breached through the gap rather than by anybody
 * copying the logic."* Then it was the wrong arguments; here it was reading
 * the raw field instead of asking. Same law, same shape, one turn later —
 * so this asks, and takes the same no-partial-askers discipline: `baseUrl`
 * and `model` are required keys that may hold `undefined`, never optional
 * ones a caller can forget.
 *
 * Hosted boxes stay inert by construction, since 018 forbids local serving
 * on one and every service there resolves to a proxy.
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
  /**
   * The service's configured address and model — required keys, so that
   * omitting either is a decision at the call site rather than a default
   * nobody notices. See {@link resolveCost}, whose signature this mirrors and
   * whose classification this defers to.
   */
  readonly baseUrl: string | undefined;
  readonly model: string | undefined;
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

/**
 * Does this route hold a model on this machine at all?
 *
 * Exported so the caller can decide whether reading memory is worth a
 * `vm_stat` spawn per job, and defined here so that decision is the SAME
 * decision the gate makes rather than a second one that agrees today. That
 * is the whole lesson of B085, which arrived because a second place answered
 * a question this file already answers.
 */
export function guardApplies(input: {
  readonly backendId: BackendId;
  readonly baseUrl: string | undefined;
  readonly model: string | undefined;
}): boolean {
  return resolveCost(input.backendId, input.baseUrl, input.model) === "free";
}

export function memoryGate(input: GateInput): GateDecision {
  /**
   * Ask, never read the field.
   *
   * The one unknown-shaped answer this can return — `metered` because the
   * address is absent or unreadable — would make the gate skip a check it
   * should run, which is the wrong failure direction for a guard even though
   * it is the right one for a bill. It is unreachable rather than handled:
   * `validateConfig` refuses an HTTP-class service whose `baseUrl` is missing
   * or unparseable, so no such service is ever dispatched. That reachability
   * claim is a prediction, so it ships with the test that catches it — see
   * "an unreachable premise" in the suite.
   */
  if (!guardApplies(input)) {
    return {
      admit: true,
      why:
        `${input.backendId} resolves to ` +
        `${resolveCost(input.backendId, input.baseUrl, input.model)}, ` +
        `so it holds no model here`,
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
  const { swapTotalBytes, swapFreeBytes, swapGrows } = input.memory;
  if (
    swapTotalBytes !== undefined &&
    swapTotalBytes > 0 &&
    /* A store that grows on demand cannot be exhausted by being full. macOS
       enlarges its swap file as it needs to — Todd's read 15 GB one night
       and 24 GB the next morning — so "free near zero" there is the current
       file filling, not the machine running out. Second landmine in the same
       three lines: absent is not empty, and full is not exhausted. */
    swapGrows !== true &&
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

/**
 * Memory, in GB, rounded DOWN — B167, and the direction is the whole point.
 *
 * Four copies of this lived in the daemon and `cli.ts` held the same three
 * lines twice, in two functions. That is B072's shape on a different quantity,
 * and it is a different quantity in the way that matters: **the rounding goes
 * the other way.**
 *
 * `describeBytes` in the protocol rounds UP, because it answers *"how much do
 * I have to lose"* and an answer smaller than the truth sends somebody to trim
 * a hundred bytes off something that needs to lose a megabyte.
 *
 * Everything here answers *"how much do I have"*, and **an answer larger than
 * the truth is the dangerous one**: 2147483647 bytes available against a 2 GB
 * floor is a refusal, and `toFixed` prints it as `2.0 GB` — a screen saying a
 * device has exactly the memory it was just refused for. Floor, not nearest,
 * so the number shown is never more than the number measured.
 *
 * All four call sites render available or total memory, which is why one
 * helper is right here and would not have been if one of them rendered a
 * requirement.
 */
export function gigabytes(n: number): string {
  return `${(Math.floor((n / 1024 ** 3) * 10) / 10).toFixed(1)} GB`;
}

function bytes(n: number): string {
  return gigabytes(n);
}
