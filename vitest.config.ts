import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Workspace packages resolve to their *source* under test, not their built
 * `dist`. Without this a stale build silently shadows an edit, and the
 * failure looks like a logic bug rather than a missing `pnpm build`.
 */
const sourceAliases = {
  "@byollm/protocol": fileURLToPath(
    new URL("./packages/protocol/src/index.ts", import.meta.url),
  ),
  // Before the bare `@byollm/server` entry, deliberately: these are prefix
  // matches applied in order, so the shorter key would otherwise rewrite
  // `@byollm/server/supabase` into `<server/src/index.ts>/supabase`.
  "@byollm/server/supabase": fileURLToPath(
    new URL("./packages/server/src/supabase/index.ts", import.meta.url),
  ),
  "@byollm/server": fileURLToPath(
    new URL("./packages/server/src/index.ts", import.meta.url),
  ),
  "@byollm/relay": fileURLToPath(
    new URL("./packages/relay/src/index.ts", import.meta.url),
  ),
  "@byollm/control-plane": fileURLToPath(
    new URL("./packages/control-plane/src/index.ts", import.meta.url),
  ),
  // Missing until 2026-08-20, and it cost an hour: the posture suite imports
  // `auditDeployment` from here, so every relay test that runs an audit was
  // reading whatever `dist` happened to hold. An edit to a probe looked like a
  // failure in the relay — which is precisely the shadowing this list exists
  // to prevent, with the one package that *audits* the others left off it.
  "@byollm/conformance": fileURLToPath(
    new URL("./packages/conformance/src/index.ts", import.meta.url),
  ),
  byollm: fileURLToPath(
    new URL("./packages/daemon/src/index.ts", import.meta.url),
  ),
};

/**
 * Coverage gates come from docs/standards.md (as amended by byollm_001 Rev 1
 * point F): a numeric line gate on a types-and-schemas package is trivially
 * met or gamed, so `protocol` is gated by the conformance kit instead. The
 * daemon's allowance exists because process-spawning code has branches that
 * only a real backend exercises.
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: sourceAliases },
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.mjs"],
          environment: "node",
        },
      },
      {
        resolve: { alias: sourceAliases },
        test: {
          name: "adversarial",
          include: ["packages/daemon/test/adversarial/**/*.test.ts"],
          environment: "node",
          testTimeout: 30_000,
        },
      },
      {
        resolve: { alias: sourceAliases },
        test: {
          name: "conformance",
          include: ["packages/conformance/test/**/*.test.ts"],
          environment: "node",
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        resolve: { alias: sourceAliases },
        test: {
          name: "control-plane",
          include: ["packages/control-plane/test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        resolve: { alias: sourceAliases },
        test: {
          name: "relay",
          include: ["packages/relay/test/**/*.test.ts"],
          environment: "node",
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov", "json-summary"],
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/index.ts",
        "**/types.ts",
        // The kit is the thing that measures other code; its own guarantee is
        // that it runs green against two independent servers in CI.
        "packages/conformance/src/**",
        // The Supabase adapter is certified by the `conformance-supabase` CI
        // job, which runs the full kit against a real Postgres with a real
        // daemon. A unit test with a mocked PostgREST would exercise the mock,
        // not the adapter, and would let a wrong SQL predicate pass.
        "packages/server/src/supabase/**",
      ],
      thresholds: {
        "packages/server/src/**": {
          lines: 90,
          branches: 90,
          functions: 90,
          statements: 90,
        },
        "packages/daemon/src/**": {
          lines: 85,
          branches: 85,
          functions: 85,
          statements: 85,
        },
        // The engine is the law over somebody else's data, and it is small
        // enough that every branch is reachable from a test. Gated at the
        // server's level rather than the daemon's for that reason: there is
        // no process-spawning here to excuse a gap.
        "packages/control-plane/src/**": {
          lines: 90,
          branches: 90,
          functions: 90,
          statements: 90,
        },
      },
    },
  },
});
