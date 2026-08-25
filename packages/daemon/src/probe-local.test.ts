import { describe, expect, it } from "vitest";
import { probeLocalServers } from "./probe-local.js";

/**
 * Probing local servers — byollm_013 applied to onboarding.
 *
 * Every case here is a reply from a program nobody in this repository wrote,
 * arriving on a port anything at all could be listening to. So the shape is
 * parsed defensively and the tests are mostly about *not* believing it: an
 * empty model list is a legal answer, and a 200 carrying something unexpected
 * is a server with nothing to offer rather than a reason to fail setup.
 */

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** A fetch that answers only for the port given, and refuses the rest. */
const only = (port: number, body: unknown): typeof fetch =>
  ((url: string | URL) =>
    String(url).includes(`:${String(port)}`)
      ? Promise.resolve(ok(body))
      : Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;

describe("probeLocalServers", () => {
  it("reports a server that answered, with the models it named", async () => {
    const found = await probeLocalServers(
      50,
      only(11434, { data: [{ id: "llama3.2" }, { id: "qwen2.5" }] }),
    );
    expect(found).toEqual([
      {
        label: "Ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        models: ["llama3.2", "qwen2.5"],
      },
    ]);
  });

  it("says nothing about ports that refused", async () => {
    // The common case on any machine: five refusals and one answer. A probe
    // that reported the refusals would be a list of things somebody does not
    // have.
    const found = await probeLocalServers(50, only(1234, { data: [] }));
    expect(found.map((s) => s.label)).toEqual(["LM Studio"]);
  });

  it("keeps a server that lists no models", async () => {
    // Legal, and the caller decides what to do about it. Dropping it here
    // would report "nothing is running" to somebody who can see that it is.
    const found = await probeLocalServers(50, only(11434, { data: [] }));
    expect(found[0]?.models).toEqual([]);
  });

  it("treats a non-200 as nothing there", async () => {
    const four04 = (() =>
      Promise.resolve(new Response("nope", { status: 404 }))) as typeof fetch;
    expect(await probeLocalServers(50, four04)).toEqual([]);
  });

  it("treats a reply that is not JSON as nothing there", async () => {
    // Something is listening on 11434 and it is not a model server. Setup
    // should not crash on whatever it happens to be.
    const html = (() =>
      Promise.resolve(
        new Response("<html>hello</html>", { status: 200 }),
      )) as typeof fetch;
    expect(await probeLocalServers(50, html)).toEqual([]);
  });

  it.each([
    ["no data key", { object: "list" }],
    ["data is not an array", { data: "llama3.2" }],
    ["rows without ids", { data: [{ name: "llama3.2" }] }],
    ["rows that are not objects", { data: ["llama3.2", null, 7] }],
    ["a bare array", ["llama3.2"]],
    ["null", null],
  ])("survives a 200 with %s", async (_label, body) => {
    // Each of these is a shape some server somewhere actually returns, or
    // could. None of them is an error worth stopping a person's setup over.
    const found = await probeLocalServers(50, only(11434, body));
    expect(found).toHaveLength(body === null ? 1 : 1);
    expect(found[0]?.models).toEqual([]);
  });

  it("gives up on a port that accepts and never answers", async () => {
    // A socket that opens and then hangs is worse than one that refuses: the
    // wizard is waiting on a prompt somebody is watching. The abort is the
    // whole reason this takes a timeout.
    const hang = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      })) as unknown as typeof fetch;
    const started = Date.now();
    expect(await probeLocalServers(60, hang)).toEqual([]);
    // Six ports, probed together rather than one after another.
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
