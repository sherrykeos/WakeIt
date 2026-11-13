import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";

// Proves the architecture boundary rules (ARCHITECTURE §2, eslint.config.js)
// actually fire, using virtual files so no placeholder source has to exist.
const cwd = fileURLToPath(new URL("../..", import.meta.url));

const eslint = new ESLint({
  cwd,
  // Boundary rules are syntactic; skip type information for virtual files.
  overrideConfig: [
    tseslint.configs.disableTypeChecked,
    { languageOptions: { parserOptions: { projectService: false } } },
  ],
});

async function ruleIds(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${cwd}${filePath}` });
  return (result?.messages ?? []).map((m) => m.ruleId ?? "parse-error");
}

const RESTRICTED = "no-restricted-imports";
const GLOBALS = "no-restricted-globals";

describe("architecture boundaries are enforced by lint", () => {
  const violations: [string, string, string][] = [
    [
      "core imports react",
      "src/core/x.ts",
      'import { useState } from "react";\nexport { useState };',
    ],
    ["core imports react-dom subpath", "src/core/x.ts", 'import "react-dom/client";'],
    ["core imports axios", "src/core/x.ts", 'import axios from "axios";\nexport { axios };'],
    ["core entry imports react", "src/index.ts", 'import "react";'],
    ["core imports experience", "src/core/x.ts", 'import "../experience/reducer";'],
    ["core imports the react layer", "src/core/x.ts", 'import "../react/provider";'],
    ["core imports fetch adapter", "src/core/x.ts", 'import "../fetch/wrap-fetch";'],
    ["readiness imports execution", "src/readiness/x.ts", 'import "../execution/executor";'],
    ["execution imports readiness", "src/execution/x.ts", 'import "../readiness/controller";'],
    ["shared imports core", "src/shared/x.ts", 'import "../core/client";'],
    ["experience imports react", "src/experience/x.ts", 'import "react";'],
    ["experience imports core at runtime", "src/experience/x.ts", 'import "../core/client";'],
    ["react layer imports core at runtime", "src/react/x.ts", 'import "../core/client";'],
    ["react layer imports axios", "src/react/x.ts", 'import "axios";'],
    [
      "axios entry imports axios at runtime",
      "src/axios/x.ts",
      'import axios from "axios";\nexport { axios };',
    ],
    ["axios entry imports react", "src/axios/x.ts", 'import "react";'],
  ];

  it.each(violations)("%s", async (_name, file, code) => {
    expect(await ruleIds(file, code)).toContain(RESTRICTED);
  });

  const allowed: [string, string, string][] = [
    ["core imports readiness", "src/core/x.ts", 'import "../readiness/controller";'],
    ["core imports shared", "src/core/x.ts", 'import "../shared/deferred";'],
    [
      "fetch adapter imports core types",
      "src/fetch/x.ts",
      'import type { WakeIt } from "../core/types";\nexport type { WakeIt };',
    ],
    [
      "react layer imports core types",
      "src/react/x.ts",
      'import type { WakeIt } from "../core/types";\nexport type { WakeIt };',
    ],
    ["react layer imports react", "src/react/x.ts", 'import "react";'],
    ["react layer imports experience", "src/react/x.ts", 'import "../experience/reducer";'],
    [
      "axios entry imports axios types",
      "src/axios/x.ts",
      'import type { AxiosInstance } from "axios";\nexport type { AxiosInstance };',
    ],
    [
      "axios entry imports inline type from axios",
      "src/axios/x.ts",
      'import { type AxiosInstance } from "axios";\nexport type { AxiosInstance };',
    ],
    [
      "experience imports core types",
      "src/experience/x.ts",
      'import type { WakeIt } from "../core/types";\nexport type { WakeIt };',
    ],
  ];

  it.each(allowed)("allows: %s", async (_name, file, code) => {
    expect(await ruleIds(file, code)).not.toContain(RESTRICTED);
  });

  it("forbids browser globals outside src/core/env.ts and src/react", async () => {
    const code = "export const f = () => window.location;";
    expect(await ruleIds("src/core/x.ts", code)).toContain(GLOBALS);
    expect(
      await ruleIds("src/readiness/x.ts", "export const f = () => navigator.onLine;"),
    ).toContain(GLOBALS);
    expect(await ruleIds("src/core/env.ts", code)).not.toContain(GLOBALS);
    expect(await ruleIds("src/react/x.ts", code)).not.toContain(GLOBALS);
  });

  it("detects import cycles", async () => {
    // Fixtures are excluded from normal linting; lint them explicitly here.
    const withFixtures = new ESLint({
      cwd,
      ignore: false,
      overrideConfig: [
        tseslint.configs.disableTypeChecked,
        { languageOptions: { parserOptions: { projectService: false } } },
      ],
    });
    const results = await withFixtures.lintFiles(["tests/infra/fixtures/cycle/a.ts"]);
    const ids = results.flatMap((r) => r.messages.map((m) => m.ruleId));
    expect(ids).toContain("import-x/no-cycle");
  });
});
