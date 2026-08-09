import type { ClaimedJob } from "@byollm/protocol";

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
  if (job.kind === "llm.generate") {
    const payload = job.payload as { prompt: string; system?: string };
    return joinSections([systemSection(payload.system), payload.prompt]);
  }

  const payload = job.payload as {
    messages: { role: string; content: string }[];
    system?: string;
  };
  const turns = payload.messages
    .map((message) => `${roleLabel(message.role)}: ${message.content}`)
    .join("\n\n");
  return joinSections([systemSection(payload.system), turns]);
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
