// Verifies what `npm pack` would publish (AC-P2, AC-P3). Nothing is published.
// Run via `pnpm pack:check`.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const out = execSync("npm pack --dry-run --json --ignore-scripts", {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
});
const [{ files }] = JSON.parse(out);
const paths = files.map((f) => f.path.replaceAll("\\", "/"));

const errors = [];
// AC-P2: built output, README, LICENSE (plus the manifest npm always includes).
const allowed = (p) =>
  p.startsWith("dist/") || ["package.json", "README.md", "LICENSE"].includes(p);
for (const p of paths.filter((p) => !allowed(p))) errors.push(`unexpected file in package: ${p}`);
if (!paths.some((p) => p.startsWith("dist/")))
  errors.push("dist/ is missing: run `pnpm build` first");
// AC-P3: zero runtime dependencies.
if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
  errors.push("package.json must not declare runtime `dependencies`");
}

if (errors.length > 0) {
  for (const message of errors) console.error(`✖ ${message}`);
  process.exit(1);
}
console.log(`✔ pack contents ok (${paths.length} files):`);
for (const p of paths) console.log(`  ${p}`);
