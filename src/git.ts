/**
 * gsd-pr-pilot — Git helpers
 *
 * Pure git helper functions used by the fix orchestrator.
 * All functions accept a `cwd` parameter, return typed results,
 * and never throw — they return null/false on any failure,
 * matching the gh.ts pattern.
 */

import { execSync } from "node:child_process";

// ── Internal helper ────────────────────────────────────────────────

function run(cmd: string, cwd: string): string | null {
    try {
        return execSync(cmd, {
            cwd,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
    } catch {
        return null;
    }
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Returns the name of the currently checked-out branch,
 * or null if HEAD is detached or the command fails.
 */
export function getCurrentBranch(cwd: string): string | null {
    const result = run("git rev-parse --abbrev-ref HEAD", cwd);
    // "HEAD" means detached HEAD state — treat as null
    if (result === "HEAD") return null;
    return result;
}

/**
 * Checks out the given branch. Returns true on success, false on failure.
 */
export function checkoutBranch(branch: string, cwd: string): boolean {
    return run(`git checkout ${branch}`, cwd) !== null;
}

/**
 * Returns true if the working tree has no uncommitted changes (staged or unstaged).
 * Returns false on any error.
 */
export function isWorkingTreeClean(cwd: string): boolean {
    const result = run("git status --porcelain", cwd);
    if (result === null) return false;
    return result === "";
}

/**
 * Returns the full 40-character SHA of the current HEAD commit,
 * or null if the repo has no commits or the command fails.
 */
export function getHeadSha(cwd: string): string | null {
    const result = run("git rev-parse HEAD", cwd);
    if (result === null) return null;
    // Must be a valid 40-char hex sha
    if (!/^[0-9a-f]{40}$/i.test(result)) return null;
    return result;
}

/**
 * Pushes the given branch to the given remote.
 * Returns true on success, false on failure.
 */
export function push(remote: string, branch: string, cwd: string): boolean {
    return run(`git push ${remote} ${branch}`, cwd) !== null;
}

/**
 * Stashes uncommitted changes if the working tree is dirty.
 * Returns true if a stash was actually created, false if the tree was
 * already clean or on any error.
 */
export function stashIfDirty(cwd: string): boolean {
    if (isWorkingTreeClean(cwd)) return false;
    const result = run("git stash", cwd);
    if (result === null) return false;
    // "No local changes to save" means nothing was stashed
    return !result.includes("No local changes to save");
}

/**
 * Pops the most recent stash entry.
 * Returns true on success, false on failure.
 */
export function stashPop(cwd: string): boolean {
    return run("git stash pop", cwd) !== null;
}
