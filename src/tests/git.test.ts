/**
 * Tests for git.ts — git helper functions
 *
 * Creates real temporary git repositories for each test group.
 * Cleans up after all tests run.
 *
 * Note: git must be on PATH and git user config must allow commits.
 * We set user.name and user.email locally inside each temp repo.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
    getCurrentBranch,
    checkoutBranch,
    isWorkingTreeClean,
    getHeadSha,
    stashIfDirty,
    stashPop,
} from "../git.js";

// ── Helpers ────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "pr-pilot-git-test-"));
    tmpDirs.push(dir);
    return dir;
}

function git(cmd: string, cwd: string): string {
    return execSync(`git ${cmd}`, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
    }).trim();
}

/**
 * Initialise a fresh git repo with a user config and an initial commit
 * so that HEAD points to a real branch.
 */
function makeRepo(): string {
    const dir = makeTmpDir();
    git("init -b main", dir);
    git("config user.email test@example.com", dir);
    git("config user.name Test", dir);
    // Initial commit so HEAD is valid
    writeFileSync(join(dir, "README.md"), "hello\n");
    git("add README.md", dir);
    git(`commit -m "initial commit"`, dir);
    return dir;
}

// Clean up all temp dirs after all tests run
after(() => {
    for (const dir of tmpDirs) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

// ── getCurrentBranch ───────────────────────────────────────────────

describe("getCurrentBranch", () => {
    it("returns 'main' after init with initial commit", () => {
        const repo = makeRepo();
        const branch = getCurrentBranch(repo);
        assert.equal(branch, "main");
    });

    it("returns null for a non-git directory", () => {
        const dir = makeTmpDir();
        const branch = getCurrentBranch(dir);
        assert.equal(branch, null);
    });

    it("returns the correct branch name after checkout", () => {
        const repo = makeRepo();
        git("checkout -b feature/xyz", repo);
        const branch = getCurrentBranch(repo);
        assert.equal(branch, "feature/xyz");
    });
});

// ── checkoutBranch ─────────────────────────────────────────────────

describe("checkoutBranch", () => {
    it("returns true when switching to an existing branch", () => {
        const repo = makeRepo();
        git("checkout -b dev", repo);
        git("checkout main", repo);
        const ok = checkoutBranch("dev", repo);
        assert.equal(ok, true);
        assert.equal(getCurrentBranch(repo), "dev");
    });

    it("returns false when the branch does not exist", () => {
        const repo = makeRepo();
        const ok = checkoutBranch("nonexistent-branch", repo);
        assert.equal(ok, false);
    });

    it("returns false in a non-git directory", () => {
        const dir = makeTmpDir();
        const ok = checkoutBranch("main", dir);
        assert.equal(ok, false);
    });
});

// ── isWorkingTreeClean ─────────────────────────────────────────────

describe("isWorkingTreeClean", () => {
    it("returns true after initial commit with no changes", () => {
        const repo = makeRepo();
        assert.equal(isWorkingTreeClean(repo), true);
    });

    it("returns false when there is an untracked file", () => {
        const repo = makeRepo();
        writeFileSync(join(repo, "newfile.txt"), "content\n");
        assert.equal(isWorkingTreeClean(repo), false);
    });

    it("returns false when there is a staged change", () => {
        const repo = makeRepo();
        writeFileSync(join(repo, "README.md"), "modified content\n");
        git("add README.md", repo);
        assert.equal(isWorkingTreeClean(repo), false);
    });

    it("returns false when there is an unstaged change", () => {
        const repo = makeRepo();
        writeFileSync(join(repo, "README.md"), "modified content\n");
        // Not staged — just a modification
        assert.equal(isWorkingTreeClean(repo), false);
    });

    it("returns false in a non-git directory", () => {
        const dir = makeTmpDir();
        assert.equal(isWorkingTreeClean(dir), false);
    });
});

// ── getHeadSha ─────────────────────────────────────────────────────

describe("getHeadSha", () => {
    it("returns a 40-char hex string after initial commit", () => {
        const repo = makeRepo();
        const sha = getHeadSha(repo);
        assert.ok(sha !== null, "sha should not be null");
        assert.match(sha, /^[0-9a-f]{40}$/i);
    });

    it("returns null in a non-git directory", () => {
        const dir = makeTmpDir();
        const sha = getHeadSha(dir);
        assert.equal(sha, null);
    });

    it("changes after a new commit", () => {
        const repo = makeRepo();
        const sha1 = getHeadSha(repo);
        writeFileSync(join(repo, "file2.txt"), "second commit\n");
        git("add file2.txt", repo);
        git(`commit -m "second commit"`, repo);
        const sha2 = getHeadSha(repo);
        assert.ok(sha2 !== null);
        assert.notEqual(sha1, sha2);
    });
});

// ── stashIfDirty + stashPop ────────────────────────────────────────

describe("stashIfDirty", () => {
    it("returns false when working tree is already clean", () => {
        const repo = makeRepo();
        assert.equal(stashIfDirty(repo), false);
    });

    it("returns true when working tree is dirty and stash is created", () => {
        const repo = makeRepo();
        writeFileSync(join(repo, "README.md"), "dirty content\n");
        git("add README.md", repo); // stage it so stash picks it up
        assert.equal(stashIfDirty(repo), true);
        // After stash, tree should be clean
        assert.equal(isWorkingTreeClean(repo), true);
    });

    it("returns false in a non-git directory", () => {
        const dir = makeTmpDir();
        assert.equal(stashIfDirty(dir), false);
    });
});

describe("stashPop", () => {
    it("restores stashed changes after stashIfDirty", () => {
        const repo = makeRepo();
        writeFileSync(join(repo, "README.md"), "stashed content\n");
        git("add README.md", repo);
        const stashed = stashIfDirty(repo);
        assert.equal(stashed, true);
        assert.equal(isWorkingTreeClean(repo), true);

        const popped = stashPop(repo);
        assert.equal(popped, true);
        // Working tree should be dirty again
        assert.equal(isWorkingTreeClean(repo), false);
    });

    it("returns false when there is nothing to pop", () => {
        const repo = makeRepo();
        // No stash exists
        const result = stashPop(repo);
        assert.equal(result, false);
    });

    it("returns false in a non-git directory", () => {
        const dir = makeTmpDir();
        assert.equal(stashPop(dir), false);
    });
});

// ── stash + checkout cycle ─────────────────────────────────────────

describe("stash + checkout cycle", () => {
    let repo: string;

    before(() => {
        repo = makeRepo();
    });

    it("stash → checkout → pop preserves changes on original branch", () => {
        // Create a second branch
        git("checkout -b topic", repo);
        git("checkout main", repo);

        // Make a dirty change on main
        writeFileSync(join(repo, "README.md"), "work in progress\n");
        git("add README.md", repo);

        const stashed = stashIfDirty(repo);
        assert.equal(stashed, true);
        assert.equal(isWorkingTreeClean(repo), true);

        // Switch to topic branch
        const switched = checkoutBranch("topic", repo);
        assert.equal(switched, true);
        assert.equal(getCurrentBranch(repo), "topic");

        // Switch back to main
        checkoutBranch("main", repo);
        assert.equal(getCurrentBranch(repo), "main");

        // Pop the stash
        const popped = stashPop(repo);
        assert.equal(popped, true);
        assert.equal(isWorkingTreeClean(repo), false);
    });
});
