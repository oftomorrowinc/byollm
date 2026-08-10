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
    ],
    // The spread comes first: it carries its own `languageOptions`, and
    // spreading it after ours would silently discard the globals below.
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
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
