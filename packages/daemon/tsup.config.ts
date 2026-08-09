import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  tsconfig: "tsconfig.build.json",
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
  // The shebang lives at the top of `cli.ts`; a tsup banner would also
  // stamp it onto the library entry, which is not an executable.
});
