import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memory.js";
import { createHandler } from "./next.js";

/**
 * The Next.js mount is the one file a developer copies, so its shape is part
 * of the contract: what they destructure has to exist and behave.
 */
describe("createHandler — the one-file Next mount", () => {
  const handler = () =>
    createHandler({
      store: new MemoryStore(),
      verificationUrl: "https://app.test/settings/runners",
    });

  it("exports POST, GET and a dynamic marker", () => {
    const mounted = handler();
    expect(typeof mounted.POST).toBe("function");
    expect(typeof mounted.GET).toBe("function");
    // Route handlers must not be cached — every call mutates lease state.
    expect(mounted.dynamic).toBe("force-dynamic");
  });

  it("serves the protocol through POST", async () => {
    const response = await handler().POST(
      new Request("https://app.test/api/byollm/pair", {
        method: "POST",
        body: JSON.stringify({
          protocolVersion: "0",
          action: "start",
          daemon: { version: "0.1.0", label: "mbp", platform: "darwin" },
          capabilities: [],
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { verificationUrl: string };
    expect(body.verificationUrl).toBe("https://app.test/settings/runners");
  });

  it("gives a stray GET a clear 405 rather than a framework 404", async () => {
    const response = await handler().GET(
      new Request("https://app.test/api/byollm/claim"),
    );
    expect(response.status).toBe(405);
  });
});
