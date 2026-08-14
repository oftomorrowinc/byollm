import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      // `tsc --build` output — the typechecker's artefacts, not sources.
      "**/.tsbuild/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/.next/**",
      "site/**",
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The protocol is a boundary: unvalidated wire data is `unknown` and
      // narrowed by zod. Explicit `any` is banned outright; each exception
      // must carry an inline reason comment (standards.md).
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // A rejection nobody handles ends the Node process. This has now been
      // shipped twice in the same shape — `void this.#handle(job)` in the
      // daemon, and three `void`-discarded promises in the Supabase delivery
      // channel, where a transient store read or a caller's throwing
      // `onNoRunner` took the process down.
      //
      // `no-floating-promises` was already on via strictTypeChecked and
      // caught neither, because its default `ignoreVoid: true` treats `void
      // promise` as a deliberate acknowledgement. That is a reasonable
      // default for code where discarding is sometimes right. It is the wrong
      // default here: `void` was the exact spelling of both bugs, so the rule
      // was permitting the thing it exists to prevent.
      //
      // With `ignoreVoid: false` there is no silent spelling. Background work
      // must say where its failure goes — `.catch(...)` routing to a caller,
      // or an explicit handler. If a promise genuinely may be dropped, an
      // eslint-disable with a reason is the honest way to say so.
      "@typescript-eslint/no-floating-promises": [
        "error",
        { ignoreVoid: false, ignoreIIFE: false },
      ],
      // byollm_004 §2: no code path may turn payload text into a command
      // line. These bans are belt-and-braces alongside the adversarial suite.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:child_process",
              importNames: ["exec", "execSync", "spawnSync"],
              message:
                "byollm_004 §2: use execFile/spawn with a fixed argv array. Shell-invoking APIs are banned.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='exec'][callee.object.name='child_process']",
          message: "byollm_004 §2: no shell execution.",
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/test/**/*.ts", "packages/conformance/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
    },
  },
  {
    // The adversarial probes are standalone Node executables spawned as real
    // binaries, not modules the project imports. They get Node globals and no
    // type-aware rules, because there is no project graph to type them from.
    files: [
      "packages/daemon/test/adversarial/*.mjs",
      "packages/daemon/scripts/*.mjs",
      "packages/server/bin/*.mjs",
      "scripts/*.mjs",
    ],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      // Merge, do not replace: `disableTypeChecked` puts its own parserOptions
      // in `languageOptions`, and overwriting the whole key silently turns
      // type-checking back on — which then fails on any file outside a
      // tsconfig, as these standalone scripts are.
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: {
        process: "readonly",
        setInterval: "readonly",
        console: "readonly",
        URL: "readonly",
      },
    },
  },
  {
    files: ["**/*.js", "**/*.config.ts"],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
