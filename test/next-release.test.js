import test from "node:test";
import assert from "node:assert/strict";
import { bumpFor, nextVersion, parseCommit, releaseNotes } from "../scripts/next-release.mjs";

const commit = (subject, body = "") => ({ hash: "abcdef1234", ...parseCommit(subject, body) });

test("reads Conventional Commits", () => {
  assert.deepEqual(parseCommit("feat(tools): add scrape_grocery"), { type: "feat", breaking: false, description: "add scrape_grocery" });
  assert.equal(parseCommit("fix!: rename a tool").breaking, true);
  assert.equal(parseCommit("refactor: x", "BREAKING CHANGE: removed y").breaking, true);
  assert.equal(parseCommit("Update README").type, "other");
  // Mentioning the rule in a message is not a breaking change.
  assert.equal(parseCommit("ci: releases", 'feat -> minor, "!" or BREAKING CHANGE -> major.').breaking, false);
  assert.equal(parseCommit("refactor: x", "Explanation.\n\nBREAKING-CHANGE: removed y").breaking, true);
});

test("chooses the version bump", () => {
  assert.equal(bumpFor([]), null);
  assert.equal(bumpFor([commit("fix: a"), commit("docs: b")]), "patch");
  assert.equal(bumpFor([commit("fix: a"), commit("feat: b")]), "minor");
  assert.equal(bumpFor([commit("feat: a"), commit("feat!: b")]), "major");
  assert.equal(nextVersion("1.0.1", "patch"), "1.0.2");
  assert.equal(nextVersion("1.0.2", "minor"), "1.1.0");
  assert.equal(nextVersion("1.4.2", "major"), "2.0.0");
});

test("groups the release notes", () => {
  const notes = releaseNotes([commit("feat: add booking"), commit("fix: retry"), commit("chore: deps")]);
  assert.match(notes, /## Features\n\n- add booking \(abcdef1\)/);
  assert.match(notes, /## Fixes\n\n- retry/);
  assert.match(notes, /## Other changes\n\n- deps/);
  assert.doesNotMatch(notes, /Breaking/);
});
