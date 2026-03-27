/**
 * gsd-pr-pilot — Event Classifier
 *
 * Decides what to do with each PR event based on the monitor's autonomy
 * level and comment source filters.
 */

import type {
    PrEvent, MonitorConfig, CommentSource,
} from "./types.js";

export type EventAction =
    | "fix"        // attempt an autonomous fix
    | "escalate"   // notify the user and ask for input
    | "notify"     // inform the user, no action needed
    | "ignore";    // skip entirely

export interface ClassifiedEvent {
    event: PrEvent;
    action: EventAction;
    reason: string;
}

/**
 * Classify a PR event into an action based on monitor configuration.
 */
export function classifyEvent(event: PrEvent, config: MonitorConfig): ClassifiedEvent {
    switch (event.kind) {
        case "check_failed":
            return classifyCheckFailure(event, config);
        case "check_passed":
            return { event, action: "notify", reason: `Check "${event.check?.name}" is now passing` };
        case "all_checks_passed":
            return { event, action: "notify", reason: "All checks are now passing" };
        case "comment_added":
            return classifyComment(event, config);
        case "changes_requested":
            return { event, action: "escalate", reason: "Reviewer requested changes" };
        case "approved":
            return { event, action: "notify", reason: "PR has been approved" };
        case "pr_merged":
            return { event, action: "notify", reason: "PR has been merged" };
        case "pr_closed":
            return { event, action: "notify", reason: "PR has been closed" };
        default:
            return { event, action: "ignore", reason: "Unknown event kind" };
    }
}

function classifyCheckFailure(event: PrEvent, config: MonitorConfig): ClassifiedEvent {
    if (!config.commentFilter.ci_checks) {
        return { event, action: "notify", reason: `CI check "${event.check?.name}" failed (CI checks filter disabled)` };
    }

    switch (config.autonomy) {
        case "fix":
            return { event, action: "fix", reason: `CI check "${event.check?.name}" failed — attempting fix` };
        case "ask":
            return { event, action: "escalate", reason: `CI check "${event.check?.name}" failed — awaiting your decision` };
        case "notify":
            return { event, action: "notify", reason: `CI check "${event.check?.name}" failed` };
    }
}

function classifyComment(event: PrEvent, config: MonitorConfig): ClassifiedEvent {
    const comment = event.comment;
    if (!comment) {
        return { event, action: "ignore", reason: "Comment event with no comment data" };
    }

    const source = comment.source;

    // Check if this source is enabled in the filter
    if (!isSourceEnabled(source, config)) {
        return {
            event,
            action: "notify",
            reason: `Comment from ${comment.author} (${source}) — source filter disabled`,
        };
    }

    // Human reviews are always escalated (they need judgment)
    if (source === "human") {
        switch (config.autonomy) {
            case "fix":
                return { event, action: "escalate", reason: `Review comment from ${comment.author} — needs your judgment` };
            case "ask":
                return { event, action: "escalate", reason: `Review comment from ${comment.author}` };
            case "notify":
                return { event, action: "notify", reason: `Review comment from ${comment.author}` };
        }
    }

    // AI review comments — escalate or notify depending on autonomy
    if (source === "ai_review" || source === "simplify_code") {
        switch (config.autonomy) {
            case "fix":
                return { event, action: "escalate", reason: `AI review comment from ${comment.author} — may need judgment` };
            case "ask":
                return { event, action: "escalate", reason: `AI review comment from ${comment.author}` };
            case "notify":
                return { event, action: "notify", reason: `AI review comment from ${comment.author}` };
        }
    }

    // CI bot comments — usually informational
    return { event, action: "notify", reason: `Bot comment from ${comment.author}` };
}

function isSourceEnabled(source: CommentSource, config: MonitorConfig): boolean {
    switch (source) {
        case "human":
            return config.commentFilter.human_reviews;
        case "ai_review":
            return config.commentFilter.ai_reviews;
        case "simplify_code":
            return config.commentFilter.simplify_code;
        case "ci_bot":
            return config.commentFilter.ci_checks;
        case "unknown":
            return true; // Don't filter unknowns
    }
}
