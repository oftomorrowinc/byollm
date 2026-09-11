import type { BackendId } from "@byollm/protocol";
import { memoryGate, gigabytes } from "./memory-gate.js";
import type { MemoryPressure, MemoryReading } from "./memory.js";

/**
 * Whether loading a model from the owner's own command needs asking — B106.
 *
 * The guard was wired into the job path and nowhere else, so `byollm model
 * <svc> <name>` was a documented model load with nothing in front of it. The
 * canary that command runs is "the cheapest true call the backend has", and
 * for a local server a true call loads the model — H2, from the help text.
 *
 * ## It asks, it does not refuse
 *
 * An owner typing the command is consent; a remote job is not. Refusing here
 * would be second-guessing somebody about their own machine, which is the
 * ruling B080 already took. But the failure mode does not care who asked, so
 * below the floor they are told what is about to happen and asked.
 *
 * ## The same gate, not a second opinion
 *
 * {@link memoryGate} decides, with the owner's configured floor, exactly as
 * it does for a job. Re-deriving "is there room" beside it is the shape B085
 * arrived as — one question answered in two places, agreeing right up until
 * the day they did not. The only thing this adds is what to do with the
 * answer: a job is refused, a person is asked.
 */
export function modelLoadQuestion(input: {
  readonly backendId: BackendId;
  readonly baseUrl: string | undefined;
  readonly model: string;
  readonly memory: MemoryReading;
  readonly pressure: MemoryPressure;
  readonly floorBytes: number;
}):
  { readonly ask: false } | { readonly ask: true; readonly question: string } {
  /**
   * One question, asked once — and the proxy case comes free.
   *
   * A first draft checked {@link guardApplies} here before consulting the
   * gate, which reads as belt and braces and is neither: the gate's own
   * first act is to ask that same function and admit anything that holds no
   * model on this machine. Deleting the early return changed no answer,
   * which a mutation proved — so it was a second decision point that could
   * only ever agree, and the kind that stops agreeing the day somebody edits
   * one of them.
   */
  const decision = memoryGate({
    backendId: input.backendId,
    baseUrl: input.baseUrl,
    model: input.model,
    memory: input.memory,
    pressure: input.pressure,
    floorBytes: input.floorBytes,
  });
  /**
   * Silent above the floor, and that is a decision rather than an omission.
   *
   * A guard that narrates on the happy path teaches people to skip reading
   * it, and then it is furniture on the day it matters. `byollm status` is
   * where somebody goes to see the reading when nothing is wrong.
   */
  if (decision.admit) return { ask: false };

  const gb = gigabytes;
  const room =
    input.memory.kind === "read"
      ? `${gb(input.memory.availableBytes)} available of ${gb(input.memory.totalBytes)}`
      : "memory could not be read";
  return {
    ask: true,
    /* What is about to be loaded and what is left, then the question. The
       reason comes from the gate rather than being restated here, so the
       sentence cannot describe a different rule from the one that fired. */
    question:
      `Loading ${input.model} on ${input.backendId} will use this machine's ` +
      `memory, and ${decision.why} (${room}). Load it anyway?`,
  };
}
