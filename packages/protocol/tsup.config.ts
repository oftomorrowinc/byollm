import { defineConfig } from "tsup";

export default defineConfig({
  /**
   * TWO entries, and the second is not a convenience — B018c.
   *
   * `envelope-format.ts` is the one module a BROWSER has to import: it is the
   * shared definition of which bytes get signed, and the browser end of a
   * console session cannot use `seal`/`open` because those are `node:crypto`.
   *
   * It was written portable and PROVED portable — and that proved the wrong
   * thing. The only way in was the barrel, which pulls the whole protocol
   * including node-only code, so a bundler resolving it failed on
   * `Can't resolve 'net'`. A portable module nobody can reach portably is not
   * portable; the test checked the file and not the path to it.
   */
  entry: ["src/index.ts", "src/envelope-format.ts"],
  format: ["esm"],
  tsconfig: "tsconfig.build.json",
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
});
