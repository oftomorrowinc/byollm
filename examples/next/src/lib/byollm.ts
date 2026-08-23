import { ByollmApp, MemoryStore, siteKeysFromEnv } from "@byollm/server";

/**
 * The README's step 2, verbatim.
 *
 * Lazily, and memoized, for the same reason the mount takes a function: a
 * module-scope `new` runs during `next build`.
 *
 * Do not "improve" this file. It is a copy of documentation, and its value is
 * that a change to the docs which breaks integrators breaks this build first.
 */
let store: MemoryStore | undefined;
export function getStore(): MemoryStore {
  return (store ??= new MemoryStore());
}

let app: ByollmApp | undefined;
export function getApp(): ByollmApp {
  return (app ??= new ByollmApp({
    store: getStore(),
    siteKeys: siteKeysFromEnv("BYOLLM_SITE_KEYS"),
  }));
}
