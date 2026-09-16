import { defineConfig } from "tsup";

export default defineConfig({
  /**
   * TWO entries, and the second is not a convenience — B018c.
   *
   * `portable.ts` is the door a BROWSER comes through: it names the whole
   * reachable set a tab needs — the format, the identity schema, the console
   * frames — none of which may drag `node:crypto` behind it.
   *
   * It was written portable and PROVED portable — and that proved the wrong
   * thing. The only way in was the barrel, which pulls the whole protocol
   * including node-only code, so a bundler resolving it failed on
   * `Can't resolve 'net'`. A portable module nobody can reach portably is not
   * portable; the test checked the file and not the path to it.
   */
  entry: ["src/index.ts", "src/portable.ts"],
  format: ["esm"],
  tsconfig: "tsconfig.build.json",
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
});
