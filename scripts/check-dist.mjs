// Post-build verification of the dist output. Run via `pnpm check:dist` after `pnpm build`.
// Checks that every `exports` target exists, that each entry resolves through the
// package exports map in both ESM and CJS, and that the core stays free of React/Axios.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const require = createRequire(import.meta.url);
const errors = [];
const fail = (msg) => errors.push(msg);

// 1. Every file referenced by `exports` exists.
const targets = [];
const collect = (value) => {
  if (typeof value === "string") targets.push(value);
  else if (value && typeof value === "object") Object.values(value).forEach(collect);
};
collect(pkg.exports);
for (const target of targets) {
  if (!existsSync(fileURLToPath(new URL(target, root)))) fail(`exports target missing: ${target}`);
}

// 2. Entries resolve through the exports map (package self-reference) as ESM and CJS.
//    Node has no `window`/`document`, so this also proves no browser access at import.
for (const sub of ["", "/react", "/axios"]) {
  const specifier = `${pkg.name}${sub}`;
  try {
    await import(specifier);
  } catch (error) {
    fail(`ESM import of "${specifier}" failed: ${error}`);
  }
  try {
    require(specifier);
  } catch (error) {
    fail(`CJS require of "${specifier}" failed: ${error}`);
  }
}

// 3. Isolation: the core bundle must not reference React or Axios; only the React
//    entry carries the "use client" banner.
const read = (file) => readFileSync(fileURLToPath(new URL(`dist/${file}`, root)), "utf8");
const forbiddenInCore = /(?:from|require\()\s*["'](?:react|react-dom|axios)(?:\/[^"']*)?["']/;
for (const file of ["index.js", "index.cjs", "index.d.ts", "index.d.cts"]) {
  if (forbiddenInCore.test(read(file))) fail(`dist/${file} references react/react-dom/axios`);
}
for (const file of ["react.js", "react.cjs"]) {
  if (!read(file).startsWith('"use client"'))
    fail(`dist/${file} is missing the "use client" banner`);
}
for (const file of ["index.js", "index.cjs", "axios.js", "axios.cjs"]) {
  if (read(file).includes("use client")) fail(`dist/${file} must not carry "use client"`);
}

if (errors.length > 0) {
  for (const message of errors) console.error(`✖ ${message}`);
  process.exit(1);
}
console.log(`✔ dist ok: ${targets.length} export targets exist; ESM + CJS resolve; core isolated.`);
