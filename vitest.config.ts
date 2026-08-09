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
  "@byollm/server": fileURLToPath(
    new URL("./packages/server/src/index.ts", import.meta.url),
  ),
  "@byollm/daemon": fileURLToPath(
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
          include: ["packages/*/src/**/*.test.ts"],
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
      },
    },
  },
});
