/**
 * gsd-pr-pilot — Type Definitions
 *
 * Core types for PR monitoring, event classification, and fix tracking.
 */

// ── PR identity ────────────────────────────────────────────────────

/** A fully qualified PR reference: owner/repo#number */
export interface PrRef {
    owner: string;
    repo: string;
    number: number;
}

/** Parse "owner/repo#123" into a PrRef. Returns null on invalid input. */
export function parsePrRef(raw: string): PrRef | null {
    const match = raw.match(/^([^/]+)\/([^#]+)#(\d+)$/);
    if (!match) return null;
    return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
}

/** Format a PrRef back to "owner/repo#123" */
export function formatPrRef(ref: PrRef): string {
    return `${ref.owner}/${ref.repo}#${ref.number}`;
}

// ── CI check status ────────────────────────────────────────────────

export type CheckConclusion =
    | "success"
    | "failure"
    | "cancelled"
    | "timed_out"
    | "action_required"
    | "neutral"
    | "skipped"
    | "stale"
    | "pending";

export interface CheckRun {
    name: string;
    status: "queued" | "in_progress" | "completed";
    conclusion: CheckConclusion | null;
    detailsUrl: string | null;
}

// ── Review comments ────────────────────────────────────────────────

export type CommentSource =
    | "human"
    | "ai_review"
    | "simplify_code"
    | "ci_bot"
    | "unknown";

export interface PrComment {
    id: number;
    author: string;
    body: string;
    source: CommentSource;
    createdAt: string;
    /** File path if this is a review comment on a specific file */
    path: string | null;
    /** Line number if this is a review comment on a specific line */
    line: number | null;
    /** Whether this comment is part of a review thread */
    isReviewComment: boolean;
}

// ── PR state snapshot ──────────────────────────────────────────────

export type PrMergeState =
    | "open"
    | "merged"
    | "closed";

export interface PrSnapshot {
    ref: PrRef;
    title: string;
    state: PrMergeState;
    branch: string;
    baseBranch: string;
    checks: CheckRun[];
    /** Whether all checks have passed */
    checksPass: boolean;
    /** Whether any check has failed (not pending — definitively failed) */
    checksFailed: boolean;
    /** Whether at least one approving review exists */
    approved: boolean;
    /** Whether changes have been requested */
    changesRequested: boolean;
    /** Timestamp of last fetch */
    fetchedAt: string;
}

// ── Events (changes between polls) ─────────────────────────────────

export type PrEventKind =
    | "check_failed"
    | "check_passed"
    | "all_checks_passed"
    | "comment_added"
    | "changes_requested"
    | "approved"
    | "pr_merged"
    | "pr_closed";

export interface PrEvent {
    kind: PrEventKind;
    ref: PrRef;
    timestamp: string;
    /** The check that failed/passed, if applicable */
    check?: CheckRun;
    /** The comment that was added, if applicable */
    comment?: PrComment;
}

// ── Fix attempts ───────────────────────────────────────────────────

export type FixOutcome =
    | "success"
    | "failed"
    | "skipped"
    | "escalated";

export interface FixAttempt {
    ref: PrRef;
    event: PrEvent;
    outcome: FixOutcome;
    description: string;
    commitSha: string | null;
    timestamp: string;
    /** If escalated, the reason shown to the user */
    escalationReason: string | null;
}

// ── Monitor configuration ──────────────────────────────────────────

export type AutonomyLevel =
    | "fix"       // fix everything deterministic, escalate the rest
    | "ask"       // ask before every change
    | "notify";   // notify only, never change anything

export interface CommentSourceFilter {
    ci_checks: boolean;
    human_reviews: boolean;
    ai_reviews: boolean;
    simplify_code: boolean;
}

export const DEFAULT_COMMENT_FILTER: CommentSourceFilter = {
    ci_checks: true,
    human_reviews: true,
    ai_reviews: false,
    simplify_code: false,
};

export interface MonitorConfig {
    /** PRs to monitor */
    prs: PrRef[];
    /** How much autonomy the monitor has */
    autonomy: AutonomyLevel;
    /** Which comment sources to act on vs notify-only */
    commentFilter: CommentSourceFilter;
    /** Seconds between polls */
    pollIntervalSeconds: number;
    /** Maximum fix attempts per PR before giving up */
    maxFixAttempts: number;
    /** Maps PR key (owner/repo#N) to local filesystem path for the repo clone */
    repoMap: Record<string, string>;
}

export const DEFAULT_MONITOR_CONFIG: Omit<MonitorConfig, "prs"> = {
    autonomy: "fix",
    commentFilter: DEFAULT_COMMENT_FILTER,
    pollIntervalSeconds: 60,
    maxFixAttempts: 5,
    repoMap: {},
};

// ── Monitor state (persisted to disk) ──────────────────────────────

export type MonitorStatus =
    | "running"
    | "paused"
    | "stopped"
    | "error";

export interface MonitorState {
    status: MonitorStatus;
    config: MonitorConfig;
    /** Per-PR tracking */
    prStates: Map<string, PrTrackingState>;
    /** When monitoring started */
    startedAt: string;
    /** When monitoring last polled */
    lastPollAt: string | null;
    /** Error message if status is "error" */
    lastError: string | null;
    /** Byte offset into events.jsonl — tracks how far the consumer has read */
    eventCursor: number;
}

export interface PrTrackingState {
    ref: PrRef;
    /** Last known snapshot */
    lastSnapshot: PrSnapshot | null;
    /** IDs of comments we've already processed */
    processedCommentIds: Set<number>;
    /** Check names we've already attempted to fix */
    attemptedCheckFixes: Set<string>;
    /** All fix attempts for this PR */
    fixes: FixAttempt[];
    /** Number of consecutive fix failures */
    consecutiveFailures: number;
}

// ── Serialisation helpers ──────────────────────────────────────────

/** Convert MonitorState to a JSON-safe object (Maps → objects, Sets → arrays) */
export function serialiseState(state: MonitorState): unknown {
    return {
        ...state,
        prStates: Object.fromEntries(
            Array.from(state.prStates.entries()).map(([key, ps]) => [
                key,
                {
                    ...ps,
                    processedCommentIds: Array.from(ps.processedCommentIds),
                    attemptedCheckFixes: Array.from(ps.attemptedCheckFixes),
                },
            ]),
        ),
    };
}

/** Restore MonitorState from a parsed JSON object */
export function deserialiseState(raw: Record<string, unknown>): MonitorState {
    const prStatesRaw = (raw.prStates ?? {}) as Record<string, Record<string, unknown>>;
    const prStates = new Map<string, PrTrackingState>();

    for (const [key, ps] of Object.entries(prStatesRaw)) {
        prStates.set(key, {
            ref: ps.ref as PrRef,
            lastSnapshot: (ps.lastSnapshot as PrSnapshot) ?? null,
            processedCommentIds: new Set(ps.processedCommentIds as number[]),
            attemptedCheckFixes: new Set(ps.attemptedCheckFixes as string[]),
            fixes: (ps.fixes as FixAttempt[]) ?? [],
            consecutiveFailures: (ps.consecutiveFailures as number) ?? 0,
        });
    }

    const rawConfig = (raw.config ?? {}) as Record<string, unknown>;
    const config: MonitorConfig = {
        ...(rawConfig as unknown as MonitorConfig),
        repoMap: ((rawConfig.repoMap as Record<string, string>) ?? {}),
    };

    return {
        status: raw.status as MonitorStatus,
        config,
        prStates,
        startedAt: raw.startedAt as string,
        lastPollAt: (raw.lastPollAt as string) ?? null,
        lastError: (raw.lastError as string) ?? null,
        eventCursor: (raw.eventCursor as number) ?? 0,
    };
}
