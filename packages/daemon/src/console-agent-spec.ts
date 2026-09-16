import { z } from "zod";
import { PublicIdentity } from "@byollm/protocol";

/**
 * What the hub tells a box when it wants a console — the one definition of
 * that message, parsed rather than trusted.
 *
 * It arrives as one argument to `byollm console-agent`, which means it comes
 * from the box's supervisor, which got it from the hub. None of those is a
 * reason to skip validating it: the hub is exactly the party the sealing
 * exists to keep out of the session, so a message from it is input.
 */
export const ConsoleAgentSpec = z
  .object({
    /** `wss://…`, the broker endpoint for this session. */
    url: z.string().min(1),
    sessionId: z.string().min(1),
    deadlineAt: z.number().int().positive(),
    /** The browser's ephemeral identity, pinned for this session. */
    browser: PublicIdentity,
    shell: z
      .object({
        command: z.string().min(1),
        args: z.array(z.string()).default([]),
        cwd: z.string().min(1),
        env: z.record(z.string(), z.string()).default({}),
      })
      .strict(),
  })
  .strict();
export type ConsoleAgentSpec = z.infer<typeof ConsoleAgentSpec>;
