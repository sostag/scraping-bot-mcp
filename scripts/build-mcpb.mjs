// Builds the Claude Desktop extension (.mcpb) of the current version:
//
//   node scripts/build-mcpb.mjs <output.mcpb>
//
// Needs dist/ (npm run build). Copies manifest.json (with the version of
// package.json), dist/ and the production dependencies to a temporary folder,
// then packs it with the official CLI. Used by .github/workflows/release.yml.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";

const root = resolve(import.meta.dirname, "..");
const output = resolve(process.argv[2] || "scraping-bot.mcpb");
if (!existsSync(join(root, "dist/index.js"))) throw new Error("dist/ is missing: run npm run build first");

const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
manifest.version = version;

const dir = mkdtempSync(join(tmpdir(), "scraping-bot-mcpb-"));
try {
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  for (const file of ["dist", "package.json", "package-lock.json", "README.md", "LICENSE"]) {
    cpSync(join(root, file), join(dir, file), { recursive: true });
  }
  // Production dependencies only; no prepare script (dist/ is already built)
  execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dir, stdio: "inherit" });
  execFileSync("npx", ["-y", MCPB_CLI, "validate", join(dir, "manifest.json")], { stdio: "inherit" });
  execFileSync("npx", ["-y", MCPB_CLI, "pack", dir, output], { stdio: "inherit" });
  console.log(`Built ${output} (version ${version})`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
