import { GRANT_MAX_AGE_MS } from "@byollm/protocol";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SpentGrants } from "./spent-grants.js";
import { removeTemp } from "./test-support.js";

/**
 * A grant admits one job, once — across a restart too.
 *
 * The old set lived only in the process, defended in a comment: "a device
 * that has restarted since is past that window anyway." It is not. A grant is
 * fresh for two minutes and a supervised restart takes about a second, so the
 * set came back empty exactly while the grant it was guarding was still
 * valid — and the relay re-delivering the same stub got a second admission
 * and a second execution of somebody's paid work.
 */
const NOW = 1_800_000_000_000;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-spent-"));
});
afterEach(async () => {
  await removeTemp(dir);
});

const path = () => join(dir, "spent-grants.json");

describe("SpentGrants", () => {
  it("remembers a grant across a restart inside its freshness window", async () => {
    // The failure, end to end: spend, die, come back one second later, and be
    // asked about the same grant while it is still perfectly valid.
    const before = new SpentGrants(path());
    before.load(NOW);
    before.spend("grant_1", NOW, NOW);

    const after = new SpentGrants(path());
    after.load(NOW + 1_000);

    expect(after.has("grant_1", NOW + 1_000)).toBe(true);
    await Promise.resolve();
  });

  it("forgets one whose grant could not be replayed anyway", () => {
    // Past the freshness window the verifier refuses it regardless, so
    // keeping the id would be guarding a door that is already shut — and the
    // file would grow forever.
    const before = new SpentGrants(path());
    before.load(NOW);
    before.spend("grant_1", NOW, NOW);

    const after = new SpentGrants(path());
    after.load(NOW + GRANT_MAX_AGE_MS + 1);

    expect(after.has("grant_1", NOW + GRANT_MAX_AGE_MS + 1)).toBe(false);
  });

  it("keeps one right up to the edge", () => {
    // The boundary belongs to the guarded side: at exactly the expiry the
    // grant is still refusable on freshness, and one millisecond earlier it
    // is not — so this must still say yes.
    const store = new SpentGrants(path());
    store.load(NOW);
    store.spend("grant_1", NOW, NOW);

    expect(store.has("grant_1", NOW + GRANT_MAX_AGE_MS - 1)).toBe(true);
  });

  it("reads a corrupt file as nothing spent, rather than refusing everything", async () => {
    /**
     * The unsafe direction, chosen deliberately.
     *
     * The alternative is a device that refuses every grant because a file did
     * not parse — a corrupt cache becoming a total outage. What is lost is
     * replay protection across one restart, which is the state this had
     * always, and it is bounded by the freshness window.
     */
    await writeFile(path(), "{ not json");
    const store = new SpentGrants(path());
    store.load(NOW);

    expect(store.has("grant_1", NOW)).toBe(false);
    // And it still works from here — a bad file is not a poisoned instance.
    store.spend("grant_1", NOW, NOW);
    expect(store.has("grant_1", NOW)).toBe(true);
  });

  it("still runs the job when it cannot write the note", () => {
    // A directory where the file should be: every write fails. Refusing the
    // work would trade a rare double-execution for a certain outage, so the
    // in-process guard stands alone and the job goes ahead.
    const store = new SpentGrants(dir);
    store.load(NOW);

    expect(() => {
      store.spend("grant_1", NOW, NOW);
    }).not.toThrow();
    expect(store.has("grant_1", NOW)).toBe(true);
  });

  it("is memory-only with no path, which is what direct mode is", () => {
    // No control plane, no grants, nothing to replay — and no file written
    // into somebody's home directory for a feature they are not using.
    const store = new SpentGrants();
    store.load(NOW);
    store.spend("grant_1", NOW, NOW);

    expect(store.has("grant_1", NOW)).toBe(true);
    expect(new SpentGrants().has("grant_1", NOW)).toBe(false);
  });
});
