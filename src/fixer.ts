/**
 * gsd-pr-pilot — Fix Orchestrator
 *
 * Manages the lifecycle of a single autonomous fix attempt:
 *   checkout → fetch logs → spawn pi --print → commit → push → reply
 *
 * Never throws — all errors are captured in the returned FixAttempt.
 */

import { execFileSync, spawnSync } from "node:child_process";
import type { ClassifiedEvent } from "./classifier.js";
import type { MonitorConfig, PrTrackingState, FixAttempt, PrRef } from "./types.js";
import { formatPrRef } from "./types.js";
import {
    isWorkingTreeClean,
    getCurrentBranch,
    checkoutBranch,
    getHeadSha,
    push,
} from "./git.js";
import { fetchCheckLog, replyToComment } from "./gh.js";

// ── Types ──────────────────────────────────────────────────────────

/**
 * Injectable pi runner — returns stdout as string or null on failure.
 * Defaults to the real `pi --print` invocation.
 */
export type PiRunner = (prompt: string, cwd: string) => string | null;

// ── Internal helpers ───────────────────────────────────────────────

function makeSkipped(ref: PrRef, event: ClassifiedEvent["event"], description: string): FixAttempt {
    return {
        ref,
        event,
        outcome: "skipped",
        description,
        commitSha: null,
        timestamp: new Date().toISOString(),
        escalationReason: description,
    };
}

function makeFailed(ref: PrRef, event: ClassifiedEvent["event"], description: string): FixAttempt {
    return {
        ref,
        event,
        outcome: "failed",
        description,
        commitSha: null,
        timestamp: new Date().toISOString(),
        escalationReason: null,
    };
}

function makeSuccess(ref: PrRef, event: ClassifiedEvent["event"], description: string, commitSha: string): FixAttempt {
    return {
        ref,
        event,
        outcome: "success",
        description,
        commitSha,
        timestamp: new Date().toISOString(),
        escalationReason: null,
    };
}

/**
 * Default pi runner — invokes `pi --print <prompt>` in the given cwd.
 * On Windows, CMD batch shims need `shell: true` so cmd.exe interprets them.
 */
export function defaultPiRunner(prompt: string, cwd: string): string | null {
    try {
        // Use spawnSync so we can pass shell:true on Windows without exposing
        // the prompt to shell glob expansion (prompt is argv[0] to pi, not shell input).
        const result = spawnSync(
            "pi",
            ["--print", prompt],
            {
                cwd,
                timeout: 120_000,
                encoding: "utf-8",
                stdio: ["pipe", "pipe", "pipe"],
                // shell:true lets Windows resolve pi → pi.cmd via CMD.EXE
                shell: process.platform === "win32",
            },
        );
        if (result.status !== 0 || result.error) return null;
        return typeof result.stdout === "string" ? result.stdout : null;
    } catch {
        return null;
    }
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Attempt an autonomous fix for a classified event.
 *
 * @param classified  The event and its classification (must be action:"fix")
 * @param config      Monitor configuration (includes repoMap)
 * @param prState     Per-PR tracking state (includes lastSnapshot for branch name)
 * @param _projectRoot Project root (unused; reserved for future state writes)
 * @param runPi       Optional injectable pi runner (for tests)
 *
 * Flow:
 * 1. Resolve local repo path from config.repoMap
 * 2. Verify working tree is clean
 * 3. Save current branch, checkout PR branch
 * 4. Record HEAD sha before fix
 * 5. Fetch CI error logs (if check_failed)
 * 6. Spawn `pi --print <prompt>` to apply the fix
 * 7. Check if pi committed (HEAD sha changed)
 * 8. Push to remote
 * 9. Reply to review comment if applicable
 * 10. Restore original branch (always, via finally)
 */
export async function attemptFix(
    classified: ClassifiedEvent,
    config: MonitorConfig,
    prState: PrTrackingState,
    _projectRoot: string,
    runPi: PiRunner = defaultPiRunner,
): Promise<FixAttempt> {
    const { event } = classified;
    const ref = event.ref;
    const prKey = formatPrRef(ref);

    // Step 1: Resolve repo path
    const repoPath = config.repoMap[prKey];
    if (!repoPath) {
        return makeSkipped(ref, event, `No repoMap entry for ${prKey}`);
    }

    // Step 2: Require a snapshot for the branch name
    const branch = prState.lastSnapshot?.branch;
    if (!branch) {
        return makeSkipped(ref, event, `No PR snapshot available for ${prKey} — cannot determine branch`);
    }

    // Step 3: Require a clean working tree
    if (!isWorkingTreeClean(repoPath)) {
        return makeSkipped(ref, event, "Working tree is dirty");
    }

    // Step 4: Save current branch so we can restore it
    const savedBranch = getCurrentBranch(repoPath);

    try {
        // Step 5: Checkout PR branch
        const checkedOut = checkoutBranch(branch, repoPath);
        if (!checkedOut) {
            return makeFailed(ref, event, `Could not checkout branch ${branch}`);
        }

        // Step 6: Record HEAD sha before fix
        const shaBeforeFix = getHeadSha(repoPath);
        if (!shaBeforeFix) {
            return makeFailed(ref, event, "Could not read HEAD sha before fix");
        }

        // Step 7: Fetch error logs (best-effort — null is acceptable)
        let errorLogs: string | null = null;
        if (event.kind === "check_failed" && event.check) {
            errorLogs = fetchCheckLog(ref, event.check.name, branch);
        }

        // Step 8: Build prompt and run pi
        const prompt = buildPrompt(ref, event, errorLogs);
        const piOutput = runPi(prompt, repoPath);
        if (piOutput === null) {
            return makeFailed(ref, event, "pi --print failed or timed out");
        }

        // Step 9: Check if pi committed
        const shaAfterFix = getHeadSha(repoPath);
        if (!shaAfterFix || shaAfterFix === shaBeforeFix) {
            // Check if pi signalled escalation
            if (piOutput.trimStart().startsWith("ESCALATE:")) {
                const reason = piOutput.trimStart().replace(/^ESCALATE:\s*/i, "").split("\n")[0].trim();
                return {
                    ref,
                    event,
                    outcome: "escalated",
                    description: `pi requested escalation: ${reason}`,
                    commitSha: null,
                    timestamp: new Date().toISOString(),
                    escalationReason: reason,
                };
            }
            return makeFailed(ref, event, "pi ran but made no commit");
        }

        // Step 10: Push to remote
        const pushed = push("origin", branch, repoPath);
        if (!pushed) {
            return makeFailed(ref, event, `Push to origin/${branch} failed`);
        }

        // Step 11: Reply to review comment if applicable
        if (event.kind === "comment_added" && event.comment?.isReviewComment && event.comment.id) {
            const summary = `Fixed by pr-pilot (commit ${shaAfterFix.slice(0, 7)})`;
            replyToComment(ref, event.comment.id, summary);
        }

        // Step 12: Return success
        return makeSuccess(ref, event, `Fix applied and pushed (${shaAfterFix.slice(0, 7)})`, shaAfterFix);

    } finally {
        // Always restore original branch
        if (savedBranch) {
            checkoutBranch(savedBranch, repoPath);
        }
    }
}

// ── Prompt builder ─────────────────────────────────────────────────

function buildPrompt(ref: PrRef, event: ClassifiedEvent["event"], errorLogs: string | null): string {
    const lines: string[] = [
        `You are running non-interactively via \`pi --print\`.`,
        ``,
        `PR: ${formatPrRef(ref)}`,
        `Event: ${event.kind}`,
        ``,
    ];

    if (event.kind === "check_failed" && event.check) {
        lines.push(`## Failed CI Check`);
        lines.push(``);
        lines.push(`Check name: ${event.check.name}`);
        if (event.check.detailsUrl) {
            lines.push(`Details: ${event.check.detailsUrl}`);
        }
        if (errorLogs) {
            lines.push(``);
            lines.push(`## Error Logs`);
            lines.push(``);
            lines.push("```");
            // Truncate to ~4000 chars to avoid enormous prompts
            lines.push(errorLogs.slice(0, 4000));
            lines.push("```");
        }
        lines.push(``);
        lines.push(`## Instructions`);
        lines.push(``);
        lines.push(`1. Read the failing code and the error logs above.`);
        lines.push(`2. Apply a minimal, deterministic fix.`);
        lines.push(`3. Commit with: \`fix: <short description> (${formatPrRef(ref)})\``);
        lines.push(`4. If the fix requires judgment or is not deterministic, output: ESCALATE: <reason>`);
        lines.push(`   Do NOT commit in that case.`);
    } else if (event.kind === "comment_added" && event.comment) {
        lines.push(`## Review Comment`);
        lines.push(``);
        lines.push(`Author: ${event.comment.author}`);
        if (event.comment.path) {
            lines.push(`File: ${event.comment.path}${event.comment.line ? `:${event.comment.line}` : ""}`);
        }
        lines.push(``);
        lines.push("```");
        lines.push(event.comment.body);
        lines.push("```");
        lines.push(``);
        lines.push(`## Instructions`);
        lines.push(``);
        lines.push(`1. Read the file mentioned in the review comment.`);
        lines.push(`2. Apply a minimal fix that addresses the feedback.`);
        lines.push(`3. Commit with: \`fix: <short description> (${formatPrRef(ref)})\``);
        lines.push(`4. If the fix requires judgment or architectural decisions, output: ESCALATE: <reason>`);
        lines.push(`   Do NOT commit in that case.`);
    } else {
        lines.push(`## Event Details`);
        lines.push(``);
        lines.push(JSON.stringify(event, null, 2));
        lines.push(``);
        lines.push(`Apply the appropriate fix and commit it with conventional commit format.`);
        lines.push(`If judgment is needed, output: ESCALATE: <reason>`);
    }

    return lines.join("\n");
}
