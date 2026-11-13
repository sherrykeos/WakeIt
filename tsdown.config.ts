import { defineConfig } from "tsdown";

// Entry points are fixed by AD-11: `wakeit`, `wakeit/react`, `wakeit/axios`.
// `react`, `react-dom` and `axios` are never bundled: peer dependencies are
// externalized automatically, and listed explicitly here as a safety net.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    react: "src/react/index.ts",
    axios: "src/axios/index.ts",
  },
  format: ["esm", "cjs"],
  platform: "neutral",
  target: "es2022",
  dts: { tsconfig: "tsconfig.build.json" },
  sourcemap: true,
  clean: true,
  treeshake: true,
  tsconfig: "tsconfig.build.json",
  deps: { neverBundle: ["react", "react-dom", "react/jsx-runtime", "axios"] },
  // ARCHITECTURE §8: `"use client"` on the React entry only.
  outputOptions: {
    banner: (chunk) => (chunk.name === "react" ? '"use client";' : ""),
  },
});
