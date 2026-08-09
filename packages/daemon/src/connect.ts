import { platform } from "node:os";
import type { Capability } from "@byollm/protocol";
import { ClientError, type ProtocolClient } from "./client.js";
import type { Pairing } from "./pairings.js";

export interface ConnectOptions {
  readonly client: ProtocolClient;
  readonly daemonVersion: string;
  readonly label: string;
  readonly capabilities: readonly Capability[];
  /** Called once, with what to show the user. */
  readonly onCode: (info: {
    userCode: string;
    verificationUrl: string;
    expiresAt: number;
  }) => void;
  /** Called each poll, so a CLI can show it is still waiting. */
  readonly onPoll?: () => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly signal?: AbortSignal;
}

export type ConnectResult =
  | { readonly ok: true; readonly pairing: Pairing }
  | {
      readonly ok: false;
      readonly reason: "denied" | "expired" | "aborted";
      readonly message: string;
    };

/**
 * The device-code pairing flow, from the daemon's side.
 *
 * The daemon asks for a code, shows it, and polls. The user approves inside
 * the app's own authenticated session, which is how the server learns who
 * they are — the daemon never asserts an identity and never accepts a pasted
 * long-lived secret ({@link MUSTS.PAIR_INTERACTIVE}).
 *
 * Nothing listens on the user's machine for this. A loopback redirect would
 * be fewer keystrokes and would contradict the product's whole posture, as
 * well as breaking on the headless boxes most likely to be running a model.
 */
export async function connect(options: ConnectOptions): Promise<ConnectResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  const started = await options.client.pairStart({
    version: options.daemonVersion,
    label: options.label,
    platform: currentPlatform(),
    capabilities: options.capabilities,
  });

  options.onCode({
    userCode: started.userCode,
    verificationUrl: started.verificationUrl,
    expiresAt: started.expiresAt,
  });

  for (;;) {
    if (options.signal?.aborted === true) {
      return { ok: false, reason: "aborted", message: "pairing was canceled" };
    }
    if (now() >= started.expiresAt) {
      return {
        ok: false,
        reason: "expired",
        message: "the pairing code expired before it was approved",
      };
    }

    await sleep(started.pollIntervalMs);
    options.onPoll?.();

    let polled;
    try {
      polled = await options.client.pairPoll(started.deviceCode);
    } catch (error) {
      // A blip while waiting for a human is not a failure — keep polling
      // until the code itself expires.
      if (error instanceof ClientError && error.retryable) continue;
      throw error;
    }

    switch (polled.status) {
      case "pending":
        continue;
      case "denied":
        return {
          ok: false,
          reason: "denied",
          message: "the pairing request was declined",
        };
      case "expired":
        return {
          ok: false,
          reason: "expired",
          message: "the pairing code expired before it was approved",
        };
      case "approved":
        return {
          ok: true,
          pairing: {
            origin: options.client.origin,
            runnerId: polled.runnerId,
            token: polled.runnerToken,
            owner: polled.owner,
            ...(polled.ownerLabel === undefined
              ? {}
              : { ownerLabel: polled.ownerLabel }),
            pairedAt: now(),
          },
        };
    }
  }
}

/** The platform, narrowed to what the protocol accepts. */
export function currentPlatform(): "darwin" | "linux" | "win32" {
  const current = platform();
  if (current === "darwin" || current === "linux" || current === "win32") {
    return current;
  }
  // byollm_002 scopes v1 to macOS and Linux. Anything else reports as linux
  // rather than refusing outright — the protocol field is descriptive, and a
  // BSD user with Ollama running should not be blocked by a label.
  return "linux";
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
