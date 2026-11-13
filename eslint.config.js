import js from "@eslint/js";
import tseslint from "typescript-eslint";
import importX from "eslint-plugin-import-x";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

// ---------------------------------------------------------------------------
// Architecture boundaries (ARCHITECTURE §2, AD-1, AD-11).
//
//   shared ← core / readiness / execution ← fetch
//   shared ← experience ← react
//   shared ← axios
//   react, experience, axios reach the core only through client interfaces:
//   TYPE imports are allowed, RUNTIME imports are not.
//   readiness and execution never import each other.
//
// Rules are pattern-based on import specifiers, so they work before the
// directories contain code and are covered by tests/infra/boundaries.test.ts.
// ---------------------------------------------------------------------------

const dir = (name) => [`**/${name}`, `**/${name}/**`];

const REACT_PKGS = ["react", "react-dom"];
const REACT_PKG_PATTERNS = ["react/*", "react-dom/*"];
const AXIOS_PKG_PATTERNS = ["axios/*"];

/** Build a restriction block for files in one part of the architecture. */
const restrict = ({ files, paths = [], patterns = [], typeOnlyPatterns = [], message }) => ({
  files,
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: paths.map((name) => ({ name, message })),
        patterns: [
          ...patterns.map((group) => ({ group: [].concat(group), message })),
          ...typeOnlyPatterns.map((group) => ({
            group: [].concat(group),
            allowTypeImports: true,
            message: `${message} (type-only imports are allowed)`,
          })),
        ],
      },
    ],
  },
});

// Flat config REPLACES (does not merge) a rule's options when several blocks match one
// file, so each layer gets exactly one block that lists all of its restrictions.
const NO_UI_OR_ADAPTER_ENTRIES = {
  paths: [...REACT_PKGS, "axios"],
  patterns: [REACT_PKG_PATTERNS, AXIOS_PKG_PATTERNS, dir("experience"), dir("react"), dir("axios")],
};
const CORE_LAYERS = [dir("core"), dir("readiness"), dir("execution"), dir("fetch")];

const boundaries = [
  // Public core entry: no React, Axios, UI or adapter entries.
  restrict({
    files: ["src/index.ts"],
    ...NO_UI_OR_ADAPTER_ENTRIES,
    message: "The core entry must not import React, Axios, the experience UI or their entries.",
  }),
  restrict({
    files: ["src/core/**"],
    paths: NO_UI_OR_ADAPTER_ENTRIES.paths,
    patterns: [...NO_UI_OR_ADAPTER_ENTRIES.patterns, dir("fetch")],
    message:
      "core must not import React, Axios, experience/react/axios, or fetch (adapters depend on the core).",
  }),
  // readiness and execution never import each other; the engine wires them via ReadinessPort.
  restrict({
    files: ["src/readiness/**"],
    paths: NO_UI_OR_ADAPTER_ENTRIES.paths,
    patterns: [...NO_UI_OR_ADAPTER_ENTRIES.patterns, dir("fetch"), dir("execution")],
    message:
      "readiness must not import React/Axios/UI/fetch, nor execution (use ReadinessPort from the engine).",
  }),
  restrict({
    files: ["src/execution/**"],
    paths: NO_UI_OR_ADAPTER_ENTRIES.paths,
    patterns: [...NO_UI_OR_ADAPTER_ENTRIES.patterns, dir("fetch"), dir("readiness")],
    message:
      "execution must not import React/Axios/UI/fetch, nor readiness (use ReadinessPort from the engine).",
  }),
  restrict({
    files: ["src/fetch/**"],
    ...NO_UI_OR_ADAPTER_ENTRIES,
    message: "fetch must not import React, Axios, the experience UI or their entries.",
  }),
  // shared is the leaf layer.
  restrict({
    files: ["src/shared/**"],
    paths: NO_UI_OR_ADAPTER_ENTRIES.paths,
    patterns: [...NO_UI_OR_ADAPTER_ENTRIES.patterns, ...CORE_LAYERS],
    message: "shared is a leaf layer: no React/Axios/UI and no other src layers.",
  }),
  // experience: framework-free; reaches the core through types only.
  restrict({
    files: ["src/experience/**"],
    paths: [...REACT_PKGS, "axios"],
    patterns: [REACT_PKG_PATTERNS, AXIOS_PKG_PATTERNS, dir("react"), dir("axios")],
    typeOnlyPatterns: CORE_LAYERS,
    message: "experience is framework-free and reaches the core through types only.",
  }),
  // react entry: no Axios; core only via types (dual-package hazard, R-4).
  restrict({
    files: ["src/react/**"],
    paths: ["axios"],
    patterns: [AXIOS_PKG_PATTERNS, dir("axios")],
    typeOnlyPatterns: CORE_LAYERS,
    message: "wakeit/react imports no Axios and no runtime core code (ARCHITECTURE section 10).",
  }),
  // axios entry: no React, no UI; core via types; the axios package itself is type-only.
  restrict({
    files: ["src/axios/**"],
    paths: [...REACT_PKGS],
    patterns: [REACT_PKG_PATTERNS, dir("react"), dir("experience")],
    typeOnlyPatterns: ["axios", ...CORE_LAYERS],
    message: "wakeit/axios imports no React and only types from axios and the core.",
  }),
];

// Browser globals must not be touched by library code (AD-10: nothing at import,
// environment resolved lazily). Only the env module and the React layer may use them.
const NO_BROWSER_GLOBALS = ["window", "document", "navigator", "localStorage", "sessionStorage"];

export default tseslint.config(
  { ignores: ["dist/", "coverage/", "node_modules/", "docs/", "tests/infra/fixtures/"] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "import-x": importX },
    settings: {
      ...importX.flatConfigs.typescript.settings,
      "import-x/resolver-next": [createTypeScriptImportResolver({ project: "./tsconfig.json" })],
    },
    rules: {
      eqeqeq: ["error", "always"],
      "no-console": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "import-x/no-cycle": "error",
    },
  },

  ...boundaries,

  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/react/**", "src/**/*.test.{ts,tsx}", "src/core/env.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        ...NO_BROWSER_GLOBALS.map((name) => ({
          name,
          message: "Browser globals are only allowed in src/core/env.ts and src/react (AD-10).",
        })),
      ],
    },
  },

  {
    files: ["src/react/**/*.{ts,tsx}", "tests/**/*.tsx"],
    ...reactHooks.configs.flat.recommended,
  },

  // Plain JS (configs, scripts): no type information, Node globals.
  {
    files: ["**/*.{js,mjs}"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },

  // Build/verification scripts are CLIs; console output is their interface.
  { files: ["scripts/**"], rules: { "no-console": "off" } },
);
