import { describe, expect, it } from "vitest";
import { ClientError, ProtocolClient } from "./client.js";
import { connect } from "./connect.js";
import { Pairings } from "./pairings.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fetch that answers with a fixed status and body. */
function fetchReturning(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
    );
}

const client = (fetchImpl: typeof fetch) =>
  new ProtocolClient({ origin: "https://app.test", fetch: fetchImpl });

describe("ProtocolClient — the four truths never share a message", () => {
  it("reports an unreachable server distinctly", async () => {
    const failing: typeof fetch = () =>
      Promise.reject(new Error("ECONNREFUSED"));
    const error = await client(failing)
      .claim({ runnerId: "r", capabilities: [], max: 1 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ClientError);
    expect((error as ClientError).kind).toBe("unreachable");
    expect((error as ClientError).retryable).toBe(true);
  });

  it("reports revocation distinctly, and never retries it", async () => {
    const error = await client(
      fetchReturning(403, { error: "revoked", message: "revoked by owner" }),
    )
      .claim({ runnerId: "r", capabilities: [], max: 1 })
      .catch((e: unknown) => e);

    expect((error as ClientError).kind).toBe("revoked");
    expect((error as ClientError).retryable).toBe(false);
  });

  it("treats no matching work as a plain success, not an error", async () => {
    const response = await client(
      fetchReturning(200, { jobs: [], leaseMs: 60_000 }),
    ).claim({ runnerId: "r", capabilities: [], max: 1 });
    expect(response.jobs).toEqual([]);
  });

  it("never retries a 400 or a 404", async () => {
    for (const status of [400, 404]) {
      const error = await client(
        fetchReturning(status, { error: "bad-request", message: "no" }),
      )
        .claim({ runnerId: "r", capabilities: [], max: 1 })
        .catch((e: unknown) => e);
      expect((error as ClientError).kind, String(status)).toBe("rejected");
      expect((error as ClientError).retryable).toBe(false);
    }
  });

  it("honours Retry-After on a rate limit", async () => {
    const error = await client(
      fetchReturning(
        429,
        { error: "rate-limited", message: "slow down" },
        { "retry-after": "17" },
      ),
    )
      .claim({ runnerId: "r", capabilities: [], max: 1 })
      .catch((e: unknown) => e);

    expect((error as ClientError).kind).toBe("rate-limited");
    expect((error as ClientError).retryAfter).toBe(17);
    expect((error as ClientError).retryable).toBe(true);
  });

  it("treats a 5xx as retryable", async () => {
    const error = await client(
      fetchReturning(500, { error: "server-error", message: "oops" }),
    )
      .claim({ runnerId: "r", capabilities: [], max: 1 })
      .catch((e: unknown) => e);
    expect((error as ClientError).kind).toBe("server-error");
    expect((error as ClientError).retryable).toBe(true);
  });

  it("refuses a response that does not match the protocol", async () => {
    // A server whose answer we cannot parse is not one to guess about.
    const error = await client(fetchReturning(200, { surprise: true }))
      .claim({ runnerId: "r", capabilities: [], max: 1 })
      .catch((e: unknown) => e);
    expect((error as ClientError).kind).toBe("malformed-response");
  });

  it("refuses a body that is not JSON at all", async () => {
    const error = await client(fetchReturning(200, "<html>nope</html>"))
      .claim({ runnerId: "r", capabilities: [], max: 1 })
      .catch((e: unknown) => e);
    expect((error as ClientError).kind).toBe("malformed-response");
  });
});

describe("ProtocolClient — request shape", () => {
  it("sends the bearer token and never listens for anything", async () => {
    let seen: Request | undefined;
    const capture: typeof fetch = (input, init) => {
      seen = new Request(input, init);
      return Promise.resolve(
        new Response(JSON.stringify({ released: [] }), {
          headers: { "content-type": "application/json" },
        }),
      );
    };

    await new ProtocolClient({
      origin: "https://app.test/",
      token: "secret-token",
      fetch: capture,
    }).release({ runnerId: "r", jobIds: ["j"], reason: "shutdown" });

    expect(seen?.url).toBe("https://app.test/byollm/release");
    expect(seen?.method).toBe("POST");
    expect(seen?.headers.get("authorization")).toBe("Bearer secret-token");
  });

  it("normalises a trailing slash on the origin", () => {
    expect(new ProtocolClient({ origin: "https://app.test///" }).origin).toBe(
      "https://app.test",
    );
  });

  it("carries a token onto a derived client", () => {
    const withToken = new ProtocolClient({
      origin: "https://app.test",
    }).withToken("t");
    expect(withToken.origin).toBe("https://app.test");
  });
});

describe("connect — the device-code flow", () => {
  const started = {
    deviceCode: "d".repeat(32),
    userCode: "KRTZ-9F2Q",
    verificationUrl: "https://app.test/pair",
    expiresAt: Date.now() + 600_000,
    // The schema floors this at 500ms; the tests inject their own `sleep`.
    pollIntervalMs: 500,
  };

  /** Answers `start` once, then the given poll responses in order. */
  function scripted(polls: unknown[]): typeof fetch {
    let index = 0;
    return (_input, init) => {
      const body = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as {
        action?: string;
      };
      const payload =
        body.action === "start" ? started : (polls[index++] ?? polls.at(-1));
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        }),
      );
    };
  }

  it("shows the user a code and returns a pairing once approved", async () => {
    let shown: { userCode: string; verificationUrl: string } | undefined;
    const result = await connect({
      client: client(
        scripted([
          { status: "pending" },
          {
            status: "approved",
            runnerToken: "t".repeat(32),
            runnerId: "runner_1",
            owner: "alice",
          },
        ]),
      ),
      daemonVersion: "0.0.0",
      label: "test",
      capabilities: [],
      onCode: (info) => {
        shown = info;
      },
      sleep: () => Promise.resolve(),
    });

    expect(shown?.userCode).toBe("KRTZ-9F2Q");
    expect(shown?.verificationUrl).toBe("https://app.test/pair");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pairing.owner).toBe("alice");
      expect(result.pairing.origin).toBe("https://app.test");
    }
  });

  it("reports a denial as a denial", async () => {
    const result = await connect({
      client: client(scripted([{ status: "denied" }])),
      daemonVersion: "0.0.0",
      label: "test",
      capabilities: [],
      onCode: () => undefined,
      sleep: () => Promise.resolve(),
    });
    expect(result).toMatchObject({ ok: false, reason: "denied" });
  });

  it("reports expiry as expiry", async () => {
    const result = await connect({
      client: client(scripted([{ status: "expired" }])),
      daemonVersion: "0.0.0",
      label: "test",
      capabilities: [],
      onCode: () => undefined,
      sleep: () => Promise.resolve(),
    });
    expect(result).toMatchObject({ ok: false, reason: "expired" });
  });

  it("stops polling once the code's own deadline passes", async () => {
    let now = Date.now();
    const result = await connect({
      client: client(scripted([{ status: "pending" }])),
      daemonVersion: "0.0.0",
      label: "test",
      capabilities: [],
      onCode: () => undefined,
      now: () => now,
      sleep: () => {
        now += 60_000;
        return Promise.resolve();
      },
    });
    expect(result).toMatchObject({ ok: false, reason: "expired" });
  });

  it("keeps polling through a transient failure", async () => {
    // A blip while waiting for a human is not a failure.
    let call = 0;
    const flaky: typeof fetch = (_input, init) => {
      const body = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as {
        action?: string;
      };
      if (body.action === "start") {
        return Promise.resolve(
          new Response(JSON.stringify(started), {
            headers: { "content-type": "application/json" },
          }),
        );
      }
      call += 1;
      if (call === 1) return Promise.reject(new Error("network blip"));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: "approved",
            runnerToken: "t".repeat(32),
            runnerId: "runner_1",
            owner: "alice",
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    };

    const result = await connect({
      client: client(flaky),
      daemonVersion: "0.0.0",
      label: "test",
      capabilities: [],
      onCode: () => undefined,
      sleep: () => Promise.resolve(),
    });
    expect(result.ok).toBe(true);
  });

  it("can be aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await connect({
      client: client(scripted([{ status: "pending" }])),
      daemonVersion: "0.0.0",
      label: "test",
      capabilities: [],
      onCode: () => undefined,
      sleep: () => Promise.resolve(),
      signal: controller.signal,
    });
    expect(result).toMatchObject({ ok: false, reason: "aborted" });
  });
});

describe("Pairings", () => {
  it("stores, replaces and forgets pairings, keyed by origin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "byollm-pairings-"));
    try {
      const path = join(dir, "pairings.json");
      const store = new Pairings(path);
      await store.load();
      expect(store.list()).toEqual([]);

      await store.put({
        origin: "https://app.test/",
        runnerId: "runner_1",
        token: "t1",
        owner: "alice",
        pairedAt: 1,
      });
      // Trailing slash and a path are the same server.
      expect(store.get("https://app.test/api")?.runnerId).toBe("runner_1");

      // Re-pairing supersedes rather than duplicating.
      await store.put({
        origin: "https://app.test",
        runnerId: "runner_2",
        token: "t2",
        owner: "alice",
        pairedAt: 2,
      });
      expect(store.list()).toHaveLength(1);
      expect(store.get("https://app.test")?.runnerId).toBe("runner_2");

      const reloaded = new Pairings(path);
      await reloaded.load();
      expect(reloaded.get("https://app.test")?.token).toBe("t2");

      expect(await reloaded.remove("https://app.test")).toBe(true);
      expect(await reloaded.remove("https://app.test")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to be used before load", () => {
    expect(() => new Pairings("/nope").list()).toThrow(/before load/);
  });
});
