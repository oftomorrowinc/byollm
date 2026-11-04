import { PROTOCOL_VERSION } from "@byollm/protocol";
import { describe, expect, it } from "vitest";
import {
  observeArrivals,
  sleep,
  type ConformanceTarget,
} from "../src/index.js";
import { referenceTarget } from "./reference-target.js";

/**
 * C042 calls logged first — the upstream half (byollm_012 §12 row 10, #6933
 * card 2).
 *
 * The check is "the upstream asserts the ingress line exists when the call
 * arrives". Card 3 writes the daemon half: it logs each call before sealing
 * it, and its kit check reads the ingress log from inside the observer this
 * file proves. What has to be true of the upstream for that check to mean
 * anything is an ordering, and it is what is asserted here: the observer sees
 * a `tool-call` before the target does, and the caller is not answered until
 * the observer has finished. Turn either round and a daemon that logged after
 * sending would have its response, write its line, and pass.
 *
 * Mutation (MUTATIONS.md): in `observeArrivals`, forward the request to the
 * target before awaiting `observe`.
 */

/** The reference target, with every request it receives written down. */
function recorded(events: string[]): ConformanceTarget {
  const inner = referenceTarget();
  return new Proxy(inner, {
    get(target, property) {
      if (property === "fetch") {
        return async (request: Request) => {
          events.push(`target ${new URL(request.url).pathname}`);
          return target.fetch(request);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

const post = (
  target: ConformanceTarget,
  endpoint: string,
  body: Record<string, unknown>,
) =>
  target.fetch(
    new Request(`${target.origin}/byollm/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...body }),
    }),
  );

describe("C042 calls logged first — the upstream half", () => {
  it("lets the observer look before the target answers, and holds the caller until it has", async () => {
    const events: string[] = [];
    const seen: unknown[] = [];
    const target = observeArrivals(
      recorded(events),
      "tool-call",
      async (body) => {
        events.push("observe start");
        seen.push(body);
        // Long enough that a caller answered in parallel would get in first.
        await sleep(25);
        events.push("observe end");
      },
    );

    const response = await post(target, "tool-call", { callId: "c1" });
    events.push("caller answered");

    expect(events).toEqual([
      "observe start",
      "observe end",
      "target /byollm/tool-call",
      "caller answered",
    ]);
    expect(seen).toEqual([{ protocolVersion: PROTOCOL_VERSION, callId: "c1" }]);
    // And the reference server serves the endpoint: unsigned is refused as
    // unsigned, which a path it did not know would answer 404.
    expect(response.status).toBe(401);
  });

  it("refuses the call when the observer throws, before the target sees it", async () => {
    const events: string[] = [];
    const target = observeArrivals(recorded(events), "tool-call", () => {
      throw new Error("no ingress line for this call");
    });
    await expect(post(target, "tool-call", {})).rejects.toThrow(
      /no ingress line/,
    );
    expect(events).toEqual([]);
  });

  it("stands at one door only, and is otherwise the target", async () => {
    const events: string[] = [];
    const inner = recorded(events);
    let observed = 0;
    const target = observeArrivals(inner, "tool-call", () => {
      observed += 1;
    });
    await post(target, "heartbeat", {});
    await post(target, "tool-results", {});
    expect(observed).toBe(0);
    expect(events).toEqual([
      "target /byollm/heartbeat",
      "target /byollm/tool-results",
    ]);
    expect(target.leaseMs).toBe(inner.leaseMs);
    expect(target.origin).toBe(inner.origin);
    await expect(target.reset()).resolves.toBeUndefined();
  });
});
