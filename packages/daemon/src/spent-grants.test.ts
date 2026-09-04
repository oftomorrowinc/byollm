import { CLOCK_SKEW_WARN_MS, GRANT_MAX_AGE_MS } from "@byollm/protocol";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

  it("refuses every grant while it cannot read what it already spent", async () => {
    /*
     * Flipped, 2026-09-03. The old assertion was the bug, argued for in its
     * own comment: refusing every grant turns a corrupt cache into a total
     * outage. True of refusing *forever*, which is not what is on offer —
     * the refusal lasts exactly as long as a grant can be replayed, because
     * that is the only window in which the lost file mattered.
     */
    await writeFile(path(), "{ not json");
    const store = new SpentGrants(path());
    store.load(NOW);

    expect(store.blockedReason(NOW)).toBeDefined();
    expect(store.spend("grant_1", NOW, NOW)).toBe(false);
  });

  it("stops refusing once nothing it forgot could still be replayed", async () => {
    /* The other half, and the reason the outage argument does not apply.
       Past the acceptance horizon plus tolerated skew, every id the lost file
       held is one the verifier would refuse on freshness anyway. */
    await writeFile(path(), "{ not json");
    const store = new SpentGrants(path());
    store.load(NOW);

    const after = NOW + GRANT_MAX_AGE_MS + CLOCK_SKEW_WARN_MS;
    expect(store.blockedReason(after - 1)).toBeDefined();
    expect(store.blockedReason(after)).toBeUndefined();
    expect(store.spend("grant_1", after, after)).toBe(true);
  });

  it("treats a file that has never been written as nothing spent", () => {
    // The control: fresh is not corrupt. A new device must admit its first
    // grant, or nothing is ever served.
    const store = new SpentGrants(path());
    store.load(NOW);

    expect(store.blockedReason(NOW)).toBeUndefined();
    expect(store.spend("grant_1", NOW, NOW)).toBe(true);
    expect(store.has("grant_1", NOW)).toBe(true);
  });

  it("refuses the job when it cannot write the note", async () => {
    /*
     * Flipped, 2026-09-03. This blessed running the job on in-memory
     * protection alone — but a restart is what erases memory, so the case
     * where the note fails and the case where the note is needed are the
     * same case. It reports the failure now instead of swallowing it, and
     * the caller refuses.
     */
    /* The live path is free at load — so this is the write failing, not the
       read. A directory standing where the file goes makes the final rename
       fail whatever the permissions are; a read-only parent would prove the
       same thing only for a test that is not running as root, and CI's user
       is not ours to assume. */
    const store = new SpentGrants(path());
    store.load(NOW);
    await mkdir(path(), { recursive: true });

    expect(store.blockedReason(NOW)).toBeUndefined();
    expect(store.spend("grant_1", NOW, NOW)).toBe(false);
    // Still burned here, which is the safe direction: this process will not
    // admit it either, and the upstream re-offers with a fresh grant.
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
