import type { LoadedConfig, ServiceConfig } from "./config.js";
import { loginCommandFor, loginPlan, type LoginCommand } from "./login.js";
import { serviceLine } from "./service-line.js";

/**
 * Ask the backends now, while somebody is watching — B047.
 *
 * Kevin, on .81: he signed out of `claude`, ran `start`, and nothing said a
 * word. Then `run`, and nothing again. The daemon was right and every screen
 * was silent.
 *
 * ## Why the honest version of this was silent
 *
 * `start` already named signed-out services. It read them from
 * services.json — what the daemon's own startup probe recorded — which is
 * the right source for a passive line and the wrong one for this moment.
 * `installService` waits for the daemon to be ALIVE, not for its first probe
 * to have finished and been written, and a probe is a real network call. So
 * the file `start` read was written before the sign-out on a used machine,
 * and did not exist at all on a new one. The tri-state rule then did exactly
 * what it should: absent is not signed-out, so it said nothing.
 *
 * Both of Kevin's cases are that, and neither is a bug in the read-back. The
 * read-back answers "what did this daemon learn last time" at the one moment
 * a person deserves "what is true right now".
 *
 * ## So this asks, and it replaces the read-back rather than joining it
 *
 * Two answers to one question on one screen is how they come to disagree.
 * The cost is one verification per mapped service per human-initiated start,
 * spent at the moment somebody is looking at the answer.
 *
 * ## Only for a person at a terminal
 *
 * A supervisor respawning the daemon at logon is not somebody who can answer
 * a prompt, and canaries cost money. Non-interactive callers return before
 * anything is spent, and the daemon's own probe stays the authority there.
 */
export interface PreflightDeps {
  readonly loaded: LoadedConfig;
  readonly device: string;
  readonly io: {
    readonly out: (text: string) => void;
    readonly err: (text: string) => void;
  };
  /** Whether we may ask at all — a TTY, not a supervisor. */
  readonly interactive: boolean;
  readonly ask: (question: string) => Promise<string>;
  readonly platform: NodeJS.Platform;
  /**
   * Ask one service whether it can answer.
   *
   * Takes the whole service config, not an id and a model. An HTTP-class
   * transport needs its `baseUrl` to be constructed at all — building one
   * without it throws, and the first version of this took `(id, model)` and
   * crashed `byollm run` outright for anybody serving Ollama. The narrower
   * signature was not simpler; it was missing a field the callee needs.
   */
  readonly verify: (config: ServiceConfig) => Promise<{
    readonly answers: boolean | undefined;
    readonly detail?: string | undefined;
  }>;
  readonly login: (command: LoginCommand) => Promise<boolean>;
  /** How each backend says it is signed in, for the remedy in the line. */
  readonly signInFor: (config: ServiceConfig) => string | undefined;
}

export async function preflight(deps: PreflightDeps): Promise<void> {
  if (!deps.interactive) return;

  for (const [service, config] of Object.entries(deps.loaded.config.services)) {
    const proof = await deps.verify(config);
    /**
     * `undefined` is not a failure — it is "there was no way to ask", which
     * is the third state the whole tri-state exists for. A local model server
     * with no canary must not be reported as signed out.
     */
    if (proof.answers !== false) continue;

    const signIn = deps.signInFor(config);
    const said = serviceLine({
      service,
      device: deps.device,
      state: {
        kind: "signed-out",
        ...(proof.detail === undefined ? {} : { detail: proof.detail }),
      },
      ...(signIn === undefined ? {} : { signIn }),
    });
    /* stderr, alongside the success rather than instead of it: the service
       is starting either way, and this must not land in a pipeline that
       wanted the serving line. */
    deps.io.err(`\n  ${said.line}\n`);
    if (said.detail !== undefined) deps.io.err(`    ${said.detail}\n`);

    const command = loginCommandFor(config.type);
    if (command === undefined) continue;

    const plan = loginPlan(command, deps.platform);
    if (plan.kind === "print") {
      /* Windows, per Todd's ruling and B049's evidence: the spawn cannot
         work there, so it is not offered. */
      deps.io.err(`\n${plan.say}\n`);
      continue;
    }

    /**
     * Asked, never assumed. A login opens a browser, and opening one on
     * somebody's machine because they typed `start` is not a thing to do
     * without being told yes.
     *
     * Asked once. Declining is a decision, and a second prompt would be
     * arguing with it.
     */
    const answer = await deps.ask(`  Sign in to ${service} now? [Y/n] `);
    if (/^n(o)?$/i.test(answer.trim())) continue;

    deps.io.err(`  ${command.says}\n\n`);
    await deps.login(command);
    const again = await deps.verify(config);
    deps.io.err(
      again.answers === true
        ? `  ${service} is signed in.\n`
        : `  ${service} still cannot answer` +
            (again.detail === undefined ? "" : `: ${again.detail}`) +
            `\n  Starting anyway — nothing routes to it until it can.\n`,
    );
  }
}
