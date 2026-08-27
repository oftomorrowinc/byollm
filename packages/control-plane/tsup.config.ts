import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/store-contract.ts"],
  format: ["esm"],
  tsconfig: "tsconfig.build.json",
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
});
