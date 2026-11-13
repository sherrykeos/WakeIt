import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: false,
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
        },
      },
      {
        // Browser-oriented tests (React Testing Library). Real-browser tests
        // (Playwright + axe) are added in the phase that builds the UI.
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/**/*.test.tsx", "tests/**/*.test.tsx"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      reporter: ["text", "html", "lcov"],
      // No thresholds yet: there is no logic to measure. Thresholds are set
      // once the core exists (AC-E1 and the contract tests define the targets).
    },
  },
});
