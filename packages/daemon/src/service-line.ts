/**
 * One sentence about a service, for the three surfaces its owner reads.
 *
 * Your Devices, `byollm status`, and the daemon's own output all answer the
 * same question — can this thing do its job, and if not what do I run — so
 * they say it in one string rather than three that drift.
 *
 * The person this is for is the owner, and only the owner. A site gets a class
 * and a fixed sentence and never this; the CLI's own words quote paths,
 * usernames and account emails, and they name which backend answered, which
 * is what the disclosure fence exists to prevent.
 */

/** What asking the backend produced. */
export type ServiceState =
  /** Ran a real call and answered. */
  | { readonly kind: "answers"; readonly model: string }
  /** The binary is there; the credentials are not. */
  | { readonly kind: "signed-out"; readonly detail?: string | undefined }
  /** The config names a binary this machine does not have. */
  | { readonly kind: "missing" }
  /**
   * Nobody asked, because there was nothing to ask with.
   *
   * Not a failure and not a success. A backend with no canary — an HTTP model
   * server, say — has no credentials of its own to check, and rendering this
   * as "cannot answer" would tell every local-server owner their model was
   * broken. Not asked is not no, the same way an empty variable is not a
   * configured one.
   */
  | { readonly kind: "unknown"; readonly model: string };

/**
 * A service's state plus the remedy its backend supplies.
 *
 * Kept together because they are learned together — at probe time, from the
 * backend instance that knows both — and needed together, by every surface
 * that renders a line. A caller looking the remedy up later would be looking
 * it up from somewhere that does not know which backend this service used.
 */
export interface ServiceReport {
  readonly state: ServiceState;
  readonly signIn?: string | undefined;
}

export interface ServiceLine {
  /** The single line. */
  readonly line: string;
  /** The backend's own words, shown muted beneath. Owner-only. */
  readonly detail?: string | undefined;
}

/**
 * The template, once.
 *
 * `device` is in every sentence on purpose: somebody with three machines
 * reading their dashboard needs to know which one to go and fix, and "run
 * claude in a terminal" is useless advice if it is the wrong terminal.
 */
export function serviceLine(input: {
  readonly service: string;
  readonly device: string;
  readonly state: ServiceState;
  /** How this backend is signed in, from the backend itself. */
  readonly signIn?: string | undefined;
  /** What removes it, for a binary that is gone. */
  readonly removeWith?: string | undefined;
}): ServiceLine {
  const { service, device, state } = input;
  switch (state.kind) {
    case "answers":
      return { line: `${service} — ${state.model}` };
    case "unknown":
      // No auth sentence at all: health as it was before any of this existed.
      return { line: `${service} — ${state.model}` };
    case "signed-out": {
      const remedy = input.signIn ?? "sign it in";
      return {
        line: `${service} — needs sign-in on ${device}: ${remedy}`,
        ...(state.detail === undefined ? {} : { detail: state.detail }),
      };
    }
    case "missing": {
      const remove = input.removeWith ?? `remove it from ~/.byollm/config.json`;
      return {
        line: `${service} — not found on ${device}: install it, or ${remove}`,
      };
    }
  }
}

/**
 * Every service as the owner's surfaces print it — the block, not the line.
 *
 * Lives here rather than in the CLI because it is rendering, and rendering
 * that sits inside a two-thousand-line command file is rendering nobody
 * tests. `byollm connect` and the daemon both print exactly this.
 */
export function renderServices(
  states: ReadonlyMap<string, ServiceReport>,
  device: string,
): string[] {
  const lines: string[] = [];
  for (const [service, report] of states) {
    const said = serviceLine({
      service,
      device,
      state: report.state,
      ...(report.signIn === undefined ? {} : { signIn: report.signIn }),
    });
    lines.push(`  ${said.line}`);
    // The backend's own words, for the owner, beneath the remedy. Indented
    // because it is evidence for the sentence above it, not a second finding.
    if (said.detail !== undefined) lines.push(`    ${said.detail}`);
  }
  return lines;
}

/**
 * The line `byollm status` adds beneath a service, or nothing.
 *
 * Nothing in two cases, and they are different: a service that answered has
 * no remedy to offer, and a service nobody has probed has no finding at all.
 * Both print what `status` always printed, because inventing a sentence from
 * an absence is how "not asked" becomes "cannot answer".
 */
export function authNote(input: {
  readonly service: string;
  readonly device: string;
  readonly report: ServiceReport | undefined;
}): ServiceLine | undefined {
  const { report } = input;
  if (report === undefined) return undefined;
  if (report.state.kind === "answers") return undefined;
  if (report.state.kind === "unknown") return undefined;
  return serviceLine({
    service: input.service,
    device: input.device,
    state: report.state,
    ...(report.signIn === undefined ? {} : { signIn: report.signIn }),
  });
}
