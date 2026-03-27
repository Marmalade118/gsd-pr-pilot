/**
 * Tests for fixer.ts — attemptFix()
 *
 * Uses real temporary git repositories. The `runPi` function is injected
 * for each test — no need to create fake pi binaries. This avoids
 * Windows .cmd extension and shell resolution complexity.
 *
 * Each test gets its own isolated directory and temp repo.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
    mkdtempSync, writeFileSync, mkdirSync, rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { attemptFix } from "../fixer.js";
import type { PiRunner } from "../fixer.js";
import type { ClassifiedEvent } from "../classifier.js";
import type { MonitorConfig, PrTrackingState, PrSnapshot } from "../types.js";
import { DEFAULT_MONITOR_CONFIG } from "../types.js";

// ── Helpers ────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "pr-pilot-fixer-test-"));
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
 * Create an initialised git repo with a single commit.
 */
function makeRepo(): string {
    const dir = makeTmpDir();
    git("init -b main", dir);
    git("config user.email test@example.com", dir);
    git("config user.name Test", dir);
    writeFileSync(join(dir, "README.md"), "hello\n");
    git("add README.md", dir);
    git(`commit -m "initial commit"`, dir);
    return dir;
}

/**
 * A no-op PiRunner: returns empty string (success exit, no commit).
 */
const noOpRunner: PiRunner = () => "";

/**
 * A PiRunner that returns an ESCALATE signal.
 */
const escalateRunner: PiRunner = () => "ESCALATE: Requires business logic judgment";

/**
 * Build a PiRunner that creates a file and commits it in the given cwd.
 * The runner ignores the prompt and just applies the commit.
 */
function makeCommittingRunner(commitMessage: string): PiRunner {
    return (_prompt: string, cwd: string): string | null => {
        try {
            writeFileSync(join(cwd, "fix.txt"), "fixed\n");
            execSync("git add fix.txt", { cwd, stdio: ["pipe", "pipe", "pipe"] });
            execSync(
                `git -c user.email=test@example.com -c user.name=Test commit -m "${commitMessage}"`,
                { cwd, stdio: ["pipe", "pipe", "pipe"] },
            );
            return ""; // empty output — no escalation signal
        } catch {
            return null; // signal failure
        }
    };
}

// ── Fixtures ───────────────────────────────────────────────────────

const BASE_REF = { owner: "test-owner", repo: "test-repo", number: 99 };
const PR_KEY = "test-owner/test-repo#99";

function makeCheckFailedEvent(): ClassifiedEvent {
    return {
        event: {
            kind: "check_failed",
            ref: BASE_REF,
            timestamp: new Date().toISOString(),
            check: { name: "build", status: "completed", conclusion: "failure", detailsUrl: null },
        },
        action: "fix",
        reason: "CI check build failed",
    };
}

function makeConfig(repoMap: Record<string, string>): MonitorConfig {
    return {
        ...DEFAULT_MONITOR_CONFIG,
        prs: [BASE_REF],
        repoMap,
    };
}

function makePrState(snapshot: PrSnapshot | null): PrTrackingState {
    return {
        ref: BASE_REF,
        lastSnapshot: snapshot,
        processedCommentIds: new Set(),
        attemptedCheckFixes: new Set(),
        fixes: [],
        consecutiveFailures: 0,
    };
}

function makeSnapshot(branch: string): PrSnapshot {
    return {
        ref: BASE_REF,
        title: "Test PR",
        state: "open",
        branch,
        baseBranch: "main",
        checks: [],
        checksPass: false,
        checksFailed: true,
        approved: false,
        changesRequested: false,
        fetchedAt: new Date().toISOString(),
    };
}

// Clean up after all tests
after(() => {
    for (const dir of tmpDirs) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

// ── Tests ──────────────────────────────────────────────────────────

describe("attemptFix — skipped cases", () => {
    it("returns 'skipped' when repoMap has no entry for the PR", async () => {
        const classified = makeCheckFailedEvent();
        const config = makeConfig({}); // empty repoMap
        const prState = makePrState(makeSnapshot("feature/test"));
        const projectRoot = makeTmpDir();

        const result = await attemptFix(classified, config, prState, projectRoot, noOpRunner);

        assert.equal(result.outcome, "skipped");
        assert.ok(result.description.includes(PR_KEY), `description should mention PR key, got: ${result.description}`);
    });

    it("returns 'skipped' when prState has no snapshot", async () => {
        const repo = makeRepo();
        const classified = makeCheckFailedEvent();
        const config = makeConfig({ [PR_KEY]: repo });
        const prState = makePrState(null); // no snapshot
        const projectRoot = makeTmpDir();

        const result = await attemptFix(classified, config, prState, projectRoot, noOpRunner);

        assert.equal(result.outcome, "skipped");
        assert.ok(
            result.description.toLowerCase().includes("snapshot"),
            `description should mention snapshot, got: ${result.description}`,
        );
    });

    it("returns 'skipped' when working tree is dirty", async () => {
        const repo = makeRepo();
        // Make the working tree dirty (untracked file)
        writeFileSync(join(repo, "dirty.txt"), "dirty content\n");

        const classified = makeCheckFailedEvent();
        const config = makeConfig({ [PR_KEY]: repo });
        const prState = makePrState(makeSnapshot("main"));
        const projectRoot = makeTmpDir();

        const result = await attemptFix(classified, config, prState, projectRoot, noOpRunner);

        assert.equal(result.outcome, "skipped");
        assert.ok(
            result.escalationReason?.includes("dirty") || result.description.includes("dirty"),
            `should mention dirty, got: ${result.description}`,
        );
    });
});

describe("attemptFix — failed cases", () => {
    it("returns 'failed' when pi makes no commit (no-op runner)", async () => {
        const repo = makeRepo();

        const classified = makeCheckFailedEvent();
        const config = makeConfig({ [PR_KEY]: repo });
        const prState = makePrState(makeSnapshot("main")); // main already exists
        const projectRoot = makeTmpDir();

        // noOpRunner returns empty string — pi "succeeds" but makes no commit
        const result = await attemptFix(classified, config, prState, projectRoot, noOpRunner);

        assert.equal(result.outcome, "failed");
        assert.ok(
            result.description.includes("no commit"),
            `expected 'no commit' in description, got: ${result.description}`,
        );
    });

    it("returns 'failed' when pi runner returns null (pi crash)", async () => {
        const repo = makeRepo();

        const classified = makeCheckFailedEvent();
        const config = makeConfig({ [PR_KEY]: repo });
        const prState = makePrState(makeSnapshot("main"));
        const projectRoot = makeTmpDir();

        const crashRunner: PiRunner = () => null;
        const result = await attemptFix(classified, config, prState, projectRoot, crashRunner);

        assert.equal(result.outcome, "failed");
        assert.ok(
            result.description.includes("failed") || result.description.includes("timed out"),
            `expected failure message, got: ${result.description}`,
        );
    });

    it("returns 'failed' when checkout fails (branch does not exist)", async () => {
        const repo = makeRepo();

        const classified = makeCheckFailedEvent();
        const config = makeConfig({ [PR_KEY]: repo });
        // Snapshot points to a branch that does not exist in the repo
        const prState = makePrState(makeSnapshot("feature/nonexistent-branch"));
        const projectRoot = makeTmpDir();

        const result = await attemptFix(classified, config, prState, projectRoot, noOpRunner);

        assert.equal(result.outcome, "failed");
    });
});

describe("attemptFix — success case", () => {
    it("commits via pi and returns 'failed' at push (no remote) with new commit on branch", async () => {
        const repo = makeRepo();

        // Create a feature branch
        git("checkout -b feature/ci-fix", repo);
        const initialFeatureHead = git("rev-parse HEAD", repo);
        git("checkout main", repo);

        const committingRunner = makeCommittingRunner("fix: ci failure (#99)");
        const classified = makeCheckFailedEvent();
        const config = makeConfig({ [PR_KEY]: repo });
        const prState = makePrState(makeSnapshot("feature/ci-fix"));
        const projectRoot = makeTmpDir();

        const result = await attemptFix(classified, config, prState, projectRoot, committingRunner);

        // No remote → push fails → outcome is 'failed' at push step
        // But the commit must have been created on the feature branch
        git("checkout feature/ci-fix", repo);
        const newFeatureHead = git("rev-parse HEAD", repo);
        git("checkout main", repo);

        assert.notEqual(
            newFeatureHead, initialFeatureHead,
            "feature branch should have a new commit after fix",
        );
        const commitMsg = git(`log --format=%s -1 ${newFeatureHead}`, repo);
        assert.ok(
            commitMsg.includes("fix: ci failure") || commitMsg.includes("#99"),
            `expected fix commit message, got: ${commitMsg}`,
        );

        // Outcome is 'failed' at push (no remote configured)
        assert.equal(result.outcome, "failed");
        assert.ok(
            result.description.toLowerCase().includes("push"),
            `expected push failure in description, got: ${result.description}`,
        );
    });
});

describe("attemptFix — branch restoration", () => {
    it("restores original branch after a failed checkout", async () => {
        const repo = makeRepo();

        const classified = makeCheckFailedEvent();
        const config = makeConfig({ [PR_KEY]: repo });
        // Point to nonexistent branch so checkout fails early
        const prState = makePrState(makeSnapshot("feature/does-not-exist"));
        const projectRoot = makeTmpDir();

        const originalBranch = git("rev-parse --abbrev-ref HEAD", repo);
        assert.equal(originalBranch, "main");

        await attemptFix(classified, config, prState, projectRoot, noOpRunner);

        // Branch should be restored to main
        const currentBranch = git("rev-parse --abbrev-ref HEAD", repo);
        assert.equal(currentBranch, "main", `branch should be restored to main, got: ${currentBranch}`);
    });

    it("restores original branch after a no-commit (pi no-op)", async () => {
        const repo = makeRepo();
        git("checkout -b feature/restore-test", repo);
        git("checkout main", repo);

        const classified = makeCheckFailedEvent();
        const config = makeConfig({ [PR_KEY]: repo });
        const prState = makePrState(makeSnapshot("feature/restore-test"));
        const projectRoot = makeTmpDir();

        await attemptFix(classified, config, prState, projectRoot, noOpRunner);

        // Should be back on main
        const currentBranch = git("rev-parse --abbrev-ref HEAD", repo);
        assert.equal(currentBranch, "main", `branch should be restored to main, got: ${currentBranch}`);
    });
});

describe("attemptFix — escalation from pi output", () => {
    it("returns 'escalated' when pi outputs ESCALATE:", async () => {
        const repo = makeRepo();
        git("checkout -b feature/escalate-test", repo);
        git("checkout main", repo);

        const classified = makeCheckFailedEvent();
        const config = makeConfig({ [PR_KEY]: repo });
        const prState = makePrState(makeSnapshot("feature/escalate-test"));
        const projectRoot = makeTmpDir();

        const result = await attemptFix(classified, config, prState, projectRoot, escalateRunner);

        assert.equal(result.outcome, "escalated");
        assert.ok(
            result.escalationReason !== null && result.escalationReason.length > 0,
            `escalationReason should be set, got: ${result.escalationReason}`,
        );
        assert.ok(
            result.escalationReason?.includes("Requires") || result.escalationReason?.includes("business"),
            `escalationReason should contain reason text, got: ${result.escalationReason}`,
        );
    });
});
