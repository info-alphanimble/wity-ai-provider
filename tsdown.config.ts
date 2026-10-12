import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

// Builds dist/ with both `import` (.mjs) and `require` (.cjs) files, plus type files.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  platform: "neutral",
  target: "node22",
  dts: true,
  clean: true,
  fixedExtension: true,
  define: { __PACKAGE_VERSION__: JSON.stringify(version) },
});
