/**
 * gsd-pr-pilot — Event Differ
 *
 * Compares two PR snapshots and emits events for anything that changed.
 * This is the core "what happened since last poll?" logic.
 */

import type { PrRef, PrSnapshot, PrEvent, PrComment, PrTrackingState } from "./types.js";

/**
 * Compare a new snapshot against the tracking state and emit events
 * for anything that changed since the last poll.
 */
export function diffSnapshot(
    ref: PrRef,
    prev: PrTrackingState,
    current: PrSnapshot,
    newComments: PrComment[],
): PrEvent[] {
    const events: PrEvent[] = [];
    const now = new Date().toISOString();
    const prevSnap = prev.lastSnapshot;

    // ── Check status changes ───────────────────────────────────────

    for (const check of current.checks) {
        if (check.conclusion === "failure" && !prev.attemptedCheckFixes.has(check.name)) {
            // Only emit if this check wasn't already failing last poll
            const prevCheck = prevSnap?.checks.find(c => c.name === check.name);
            if (!prevCheck || prevCheck.conclusion !== "failure") {
                events.push({
                    kind: "check_failed",
                    ref,
                    timestamp: now,
                    check,
                });
            }
        }

        if (check.conclusion === "success") {
            const prevCheck = prevSnap?.checks.find(c => c.name === check.name);
            if (prevCheck && prevCheck.conclusion === "failure") {
                events.push({
                    kind: "check_passed",
                    ref,
                    timestamp: now,
                    check,
                });
            }
        }
    }

    // All checks now passing (transition from not-all-passing)
    if (current.checksPass && prevSnap && !prevSnap.checksPass) {
        events.push({ kind: "all_checks_passed", ref, timestamp: now });
    }

    // ── New comments ───────────────────────────────────────────────

    for (const comment of newComments) {
        if (!prev.processedCommentIds.has(comment.id)) {
            events.push({
                kind: "comment_added",
                ref,
                timestamp: now,
                comment,
            });
        }
    }

    // ── Review state changes ───────────────────────────────────────

    if (current.approved && prevSnap && !prevSnap.approved) {
        events.push({ kind: "approved", ref, timestamp: now });
    }

    if (current.changesRequested && prevSnap && !prevSnap.changesRequested) {
        events.push({ kind: "changes_requested", ref, timestamp: now });
    }

    // ── PR lifecycle ───────────────────────────────────────────────

    if (current.state === "merged" && prevSnap?.state !== "merged") {
        events.push({ kind: "pr_merged", ref, timestamp: now });
    }

    if (current.state === "closed" && prevSnap?.state !== "closed") {
        events.push({ kind: "pr_closed", ref, timestamp: now });
    }

    return events;
}
