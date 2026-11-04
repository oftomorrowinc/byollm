import type { ClaimedJob, JobKind } from "@byollm/protocol";

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
    /* Not served by this build. Each was once composed as chat by a
       fall-through: an image job crashed on `messages`, a vision job sent the
       model "[object Object]", and a tools job ran with no digest checked
       against its grant (TOOLS_MATCH_CONSENT). A route for one cannot exist
       ({@link SERVED_KINDS}), so reaching here is a bug — and it throws
       rather than guessing. */
    case "llm.tools":
    case "llm.vision":
    case "llm.image":
      throw new Error(`this daemon does not compose ${kind} jobs`);
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
