// Computes the next release from the commits pushed since the last vX.Y.Z tag
// (Conventional Commits): "feat" -> minor, "!" or a "BREAKING CHANGE:" footer -> major,
// anything else -> patch. Used by .github/workflows/release.yml:
//
//   node scripts/next-release.mjs <notes-file>
//
// prints "version=X.Y.Z" (nothing when there is no new commit) and writes the
// release notes to <notes-file>.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function parseCommit(subject, body = "") {
  const match = subject.match(/^(\w+)(?:\([^)]*\))?(!)?:\s*(.+)$/);
  return {
    type: match ? match[1].toLowerCase() : "other",
    // A footer line starting with "BREAKING CHANGE:", not the words anywhere.
    breaking: Boolean(match?.[2]) || /^BREAKING[ -]CHANGE:/m.test(body),
    description: match ? match[3] : subject,
  };
}

export function bumpFor(commits) {
  if (commits.length === 0) return null;
  if (commits.some((commit) => commit.breaking)) return "major";
  if (commits.some((commit) => commit.type === "feat")) return "minor";
  return "patch";
}

export function nextVersion(last, bump) {
  const [major, minor, patch] = last.split(".").map(Number);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function releaseNotes(commits) {
  const groups = [
    ["Breaking changes", (commit) => commit.breaking],
    ["Features", (commit) => !commit.breaking && commit.type === "feat"],
    ["Fixes", (commit) => !commit.breaking && commit.type === "fix"],
    ["Other changes", (commit) => !commit.breaking && commit.type !== "feat" && commit.type !== "fix"],
  ];
  return groups
    .map(([title, keep]) => {
      const lines = commits.filter(keep).map((commit) => `- ${commit.description} (${commit.hash.slice(0, 7)})`);
      return lines.length ? `## ${title}\n\n${lines.join("\n")}\n` : "";
    })
    .filter(Boolean)
    .join("\n");
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

function isAncestor(commit) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

function main() {
  const lastTag = git("tag", "--list", "v[0-9]*", "--sort=-v:refname").split("\n")[0] || null;
  // A release tag points to a version commit made next to main: its parent is
  // the last commit released.
  const base = lastTag ? (isAncestor(lastTag) ? lastTag : `${lastTag}^`) : null;
  const log = git("log", "--no-merges", "--format=%H%x1f%s%x1f%b%x1e", ...(base ? [`${base}..HEAD`] : ["HEAD"]));
  const commits = log
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [hash, subject, body] = entry.split("\x1f");
      return { hash, ...parseCommit(subject, body) };
    });

  const bump = bumpFor(commits);
  if (!bump) return;
  const version = nextVersion(lastTag ? lastTag.slice(1) : "0.0.0", bump);
  writeFileSync(process.argv[2] || "release-notes.md", releaseNotes(commits));
  console.log(`version=${version}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
