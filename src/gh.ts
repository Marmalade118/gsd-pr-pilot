/**
 * gsd-pr-pilot — GitHub CLI Integration
 *
 * All GitHub interaction goes through `gh` CLI. No API tokens needed —
 * gh handles auth. Each function shells out, parses JSON, and returns
 * typed results. Errors are caught and returned as nulls, never thrown.
 */

import { execSync } from "node:child_process";
import type {
    PrRef, PrSnapshot, PrComment, CheckRun, CheckConclusion,
    CommentSource,
} from "./types.js";
import { formatPrRef } from "./types.js";

// ── Helpers ────────────────────────────────────────────────────────

function gh(args: string, options?: { cwd?: string }): string | null {
    try {
        return execSync(`gh ${args}`, {
            encoding: "utf-8",
            timeout: 30_000,
            cwd: options?.cwd,
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
    } catch {
        return null;
    }
}

function ghJson<T>(args: string, options?: { cwd?: string }): T | null {
    const raw = gh(args, options);
    if (!raw) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

// ── Public API ─────────────────────────────────────────────────────

/** Check if gh CLI is available and authenticated */
export function isGhAvailable(): boolean {
    return gh("auth status") !== null;
}

/** Fetch the current state of a PR */
export function fetchPrSnapshot(ref: PrRef): PrSnapshot | null {
    const prId = formatPrRef(ref);

    // Fetch PR metadata
    const pr = ghJson<{
        title: string;
        state: string;
        headRefName: string;
        baseRefName: string;
        reviewDecision: string | null;
    }>(`pr view ${ref.number} --repo ${ref.owner}/${ref.repo} --json title,state,headRefName,baseRefName,reviewDecision`);

    if (!pr) return null;

    // Fetch checks
    const checks = fetchChecks(ref);

    const checksPass = checks.length > 0 && checks.every(
        c => c.conclusion === "success" || c.conclusion === "skipped" || c.conclusion === "neutral",
    );
    const checksFailed = checks.some(c => c.conclusion === "failure");

    // Map PR state
    let state: PrSnapshot["state"] = "open";
    if (pr.state === "MERGED") state = "merged";
    else if (pr.state === "CLOSED") state = "closed";

    return {
        ref,
        title: pr.title,
        state,
        branch: pr.headRefName,
        baseBranch: pr.baseRefName,
        checks,
        checksPass,
        checksFailed,
        approved: pr.reviewDecision === "APPROVED",
        changesRequested: pr.reviewDecision === "CHANGES_REQUESTED",
        fetchedAt: new Date().toISOString(),
    };
}

/** Map raw `gh pr checks --json name,state,link` output to CheckRun objects */
export function mapRawChecks(raw: Array<{ name: string; state: string; link?: string }>): CheckRun[] {
    return raw.map(c => {
        const isPending = c.state === "PENDING";
        return {
            name: c.name,
            status: isPending ? "in_progress" : "completed",
            conclusion: isPending ? null : (c.state.toLowerCase() as CheckConclusion),
            detailsUrl: c.link ?? null,
        };
    });
}

/** Fetch check runs for a PR */
export function fetchChecks(ref: PrRef): CheckRun[] {
    // gh pr checks --json uses: name, state (SUCCESS/FAILURE/SKIPPED/PENDING), link
    const raw = ghJson<Array<{
        name: string;
        state: string;
        link?: string;
    }>>(`pr checks ${ref.number} --repo ${ref.owner}/${ref.repo} --json name,state,link`);

    if (!raw) return [];

    return mapRawChecks(raw);
}

/** Map raw GitHub API review comment objects to PrComment objects (minus source classification) */
export function mapRawReviewComments(raw: Array<{
    id: number;
    user?: { login?: string };
    body: string;
    created_at: string;
    path?: string;
    original_line?: number | null;
}>): Array<Omit<PrComment, "source">> {
    return raw.map(c => ({
        id: c.id,
        author: c.user?.login ?? "unknown",
        body: c.body,
        createdAt: c.created_at,
        path: c.path ?? null,
        line: c.original_line ?? null,
        isReviewComment: true,
    }));
}

/** Fetch comments on a PR (both issue comments and review comments) */
export function fetchComments(ref: PrRef): PrComment[] {
    // Issue-level comments
    const issueComments = ghJson<Array<{
        id: number;
        author: { login: string };
        body: string;
        createdAt: string;
    }>>(`pr view ${ref.number} --repo ${ref.owner}/${ref.repo} --json comments --jq '.comments'`) ?? [];

    // Review comments — fetch raw API response (no --jq: avoids JSONL parse failure with 2+ comments)
    const reviewRaw = ghJson<Array<{
        id: number;
        user?: { login?: string };
        body: string;
        created_at: string;
        path?: string;
        original_line?: number | null;
    }>>(`api repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`) ?? [];

    const comments: PrComment[] = [];

    for (const c of issueComments) {
        comments.push({
            id: c.id,
            author: c.author.login,
            body: c.body,
            source: classifyCommentSource(c.author.login, c.body),
            createdAt: c.createdAt,
            path: null,
            line: null,
            isReviewComment: false,
        });
    }

    for (const c of mapRawReviewComments(reviewRaw)) {
        comments.push({
            ...c,
            source: classifyCommentSource(c.author, c.body),
        });
    }

    return comments;
}

/** Fetch the log output for a failed check run */
export function fetchCheckLog(ref: PrRef, checkName: string, branch: string): string | null {
    // gh run view can get logs, but we need the run ID first
    const runs = ghJson<Array<{
        databaseId: number;
        name: string;
        conclusion: string;
    }>>(`run list --repo ${ref.owner}/${ref.repo} --branch ${branch} --json databaseId,name,conclusion --limit 10`);

    if (!runs) return null;

    const failedRun = runs.find(r => r.name === checkName && r.conclusion === "failure");
    if (!failedRun) return null;

    return gh(`run view ${failedRun.databaseId} --repo ${ref.owner}/${ref.repo} --log-failed`);
}

/** Reply to a review comment on a PR */
export function replyToComment(ref: PrRef, commentId: number, body: string): boolean {
    try {
        execSync(
            `gh api repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments/${commentId}/replies --method POST --input -`,
            {
                input: JSON.stringify({ body }),
                encoding: "utf-8",
                timeout: 30_000,
                stdio: ["pipe", "pipe", "pipe"],
            },
        );
        return true;
    } catch {
        return false;
    }
}

/** Check if a branch has been force-pushed (compare local HEAD with remote) */
export function isBranchSafe(ref: PrRef, branchName: string, localHead: string, cwd: string): boolean {
    const remoteHead = gh(
        `api repos/${ref.owner}/${ref.repo}/git/refs/heads/${branchName} --jq '.object.sha'`,
    );
    if (!remoteHead) return true; // Can't verify — assume safe
    return remoteHead === localHead;
}

// ── Comment source classification ──────────────────────────────────

const AI_REVIEW_AUTHORS = new Set([
    "github-actions[bot]",
    "coderabbitai[bot]",
    "codiumai-pr-agent-pro[bot]",
    "copilot[bot]",
    "sourcery-ai[bot]",
    "deepsource-autofix[bot]",
]);

const SIMPLIFY_CODE_PATTERNS = [
    /simplify.?code/i,
    /code.?quality/i,
    /maintainability/i,
    /DRY.?principle/i,
    /SOLID.?principle/i,
];

function classifyCommentSource(author: string, body: string): CommentSource {
    // Bot authors
    if (author.endsWith("[bot]")) {
        // Check for "Simplify Code" workflow specifically
        if (SIMPLIFY_CODE_PATTERNS.some(p => p.test(body))) {
            return "simplify_code";
        }
        if (AI_REVIEW_AUTHORS.has(author)) {
            return "ai_review";
        }
        return "ci_bot";
    }

    return "human";
}
