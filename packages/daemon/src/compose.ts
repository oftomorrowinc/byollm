import type {
  ClaimedJob,
  ImagePayload,
  JobKind,
  VisionPayload,
} from "@byollm/protocol";
import type { VisionTurn } from "./backends/types.js";
import type { OpenedImage } from "./images.js";

/**
 * The kinds this daemon can turn into a backend call — its one list (#7053).
 *
 * The protocol's `JobKind` names every kind any party may speak; this names
 * the ones THIS build has a handler for. They stopped being the same set when
 * 0.1.5's card 1 widened the enum ahead of the handlers, and the config schema
 * parses kinds with that enum — so without this list a service listing
 * `llm.image` resolved to a route and advertised a kind nothing here could
 * run. {@link resolveConfig} withholds every configured kind not on it, loudly.
 *
 * Cards 2–6 of #6933 each add their kind here in the commit that adds its
 * case to {@link composePrompt}; `served-kinds.test.ts` holds the two in step.
 */
export const SERVED_KINDS = Object.freeze([
  "llm.generate",
  "llm.chat",
  "llm.tools",
  "llm.vision",
  "llm.image",
] as const satisfies readonly JobKind[]);
export type ServedKind = (typeof SERVED_KINDS)[number];

export function isServedKind(kind: JobKind): kind is ServedKind {
  return (SERVED_KINDS as readonly JobKind[]).includes(kind);
}

/**
 * Reduce a job's payload to the single string a backend receives.
 *
 * This is the narrowest point in the daemon: everything upstream deals in a
 * job, everything downstream deals in text and an owner-chosen model. By
 * construction there is nothing left for a payload to influence.
 *
 * **On `system`.** byollm_004 §2 forbids payload text on a command line, and
 * the `claude` CLI's only system-prompt input is the argv flag
 * `--system-prompt` — so a payload's `system` can never be passed that way.
 * It is folded into the stdin text instead, under a plain delimiter. That
 * costs a little role fidelity on process-class backends and is documented
 * rather than papered over; HTTP-class backends could carry the role natively
 * but use the same composition so a job produces identical text on either
 * class, which is what makes results comparable across runners.
 */
export function composePrompt(job: ClaimedJob): string {
  const kind: JobKind = job.kind;
  switch (kind) {
    case "llm.generate": {
      const payload = job.payload as { prompt: string; system?: string };
      return joinSections([systemSection(payload.system), payload.prompt]);
    }
    /* `llm.tools` opens as chat does — byollm_012 §3: its payload IS chat's,
       plus the declarations, which travel to the model as functions and
       never as prompt text (the tool loop, `tool-loop.ts`). Composed the same
       way so the ingress log records the same prompt for either kind. */
    case "llm.tools":
    case "llm.chat": {
      const payload = job.payload as {
        messages: { role: string; content: string }[];
        system?: string;
      };
      const turns = payload.messages
        .map((message) => `${roleLabel(message.role)}: ${message.content}`)
        .join("\n\n");
      return joinSections([systemSection(payload.system), turns]);
    }
    /* `llm.vision` — byollm_021 §1. This is the TEXT of the job, for the
       ingress log and the spend estimate: each image is a marker, never its
       bytes or its key. The backend is sent the parts themselves
       (`visionTurns`), because a vision model has to see where each image
       sits among the words. */
    case "llm.vision": {
      const payload = job.payload as VisionPayload;
      const turns = payload.messages
        .map(
          (message) =>
            `${roleLabel(message.role)}: ${
              typeof message.content === "string"
                ? message.content
                : message.content
                    .map((part) =>
                      part.type === "text"
                        ? part.text
                        : `[image ${part.image.mediaType}, ${String(part.image.width)}×${String(part.image.height)}]`,
                    )
                    .join("\n")
            }`,
        )
        .join("\n\n");
      return joinSections([systemSection(payload.system), turns]);
    }
    /* `llm.image` — the prompt, as the model is sent it. `aspect` and
       `count` work inside the call and never route it (§1). */
    case "llm.image":
      return (job.payload as ImagePayload).prompt;
    default: {
      const unknown: never = kind;
      throw new Error(`this daemon does not compose ${String(unknown)} jobs`);
    }
  }
}

function systemSection(system: string | undefined): string | undefined {
  if (system === undefined || system.trim() === "") return undefined;
  return `System instructions:\n${system}`;
}

function roleLabel(role: string): string {
  switch (role) {
    case "assistant":
      return "Assistant";
    case "system":
      return "System";
    default:
      return "User";
  }
}

function joinSections(sections: readonly (string | undefined)[]): string {
  return sections.filter((section) => section !== undefined).join("\n\n");
}

/**
 * An `llm.vision` payload as the backend is sent it — byollm_021 §1.
 *
 * Turns in order, each image part replaced by the bytes opened for it, in the
 * order {@link visionImages} lists the references. `system` leads as a system
 * turn, which an HTTP backend carries natively; only `http` serves this kind.
 */
export function visionTurns(
  payload: VisionPayload,
  images: readonly OpenedImage[],
): VisionTurn[] {
  let next = 0;
  const turns: VisionTurn[] = [];
  if (payload.system !== undefined && payload.system.trim() !== "") {
    turns.push({ role: "system", content: payload.system });
  }
  for (const message of payload.messages) {
    if (typeof message.content === "string") {
      turns.push({ role: message.role, content: message.content });
      continue;
    }
    turns.push({
      role: "user",
      content: message.content.map((part) => {
        if (part.type === "text") return { type: "text", text: part.text };
        const image = images[next];
        next += 1;
        if (image === undefined) {
          throw new Error("an image part has no opened image beside it");
        }
        return {
          type: "image",
          mediaType: image.mediaType,
          bytes: image.bytes,
        };
      }),
    });
  }
  if (next !== images.length) {
    throw new Error("opened images and image parts do not line up");
  }
  return turns;
}
