// Pre-commit hook (simple-git-hooks): looks for secrets (API keys, tokens,
// private keys, passwords in URLs...) in the staged files with secretlint, and
// stops the commit if it finds one. The repository is public.
import { execFileSync } from "node:child_process";

const files = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
if (files.length === 0) process.exit(0);
try {
  execFileSync("npx", ["--no-install", "secretlint", "--secretlintignore", ".secretlintignore", ...files], { stdio: "inherit" });
} catch {
  console.error("\nsecretlint found a possible secret in the staged files: remove it (environment variable) before committing.");
  process.exit(1);
}
