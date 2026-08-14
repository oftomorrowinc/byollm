import { rm } from "node:fs/promises";

/**
 * Remove a temp directory, tolerating a write that lands mid-removal.
 *
 * `rm -rf` walks a tree; a file created during the walk makes the parent
 * non-empty again and the whole call fails with `ENOTEMPTY`. The daemon writes
 * lazily — its key file appears the first time anything asks for its identity
 * — so a late write can land after a test believes it is done.
 *
 * This failed once in CI and nowhere locally, which is the shape of every
 * cleanup race: the window is real but narrow, and a loaded machine widens
 * it. Retried rather than serialised, because the alternative is every test
 * knowing which paths make the daemon touch disk.
 */
export async function removeTemp(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  // A leaked temp directory is not worth failing a test run over.
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
