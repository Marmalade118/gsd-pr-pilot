/**
 * gsd-pr-pilot — Polling Loop
 *
 * The core monitor loop. Runs as a standalone process (spawned via bg_shell
 * or the install script). Polls GitHub PRs, diffs state, classifies events,
 * and writes results to disk. Does NOT contain LLM logic — that's handled
 * by the extension's command handler reading state and spawning agents.
 *
 * Communication protocol:
 * - Reads config from:   .gsd/pr-pilot/monitor-state.json
 * - Writes state to:     .gsd/pr-pilot/monitor-state.json
 * - Appends events to:   .gsd/pr-pilot/events.jsonl (trigger file)
 * - Logs to stdout (picked up by bg_shell)
 *
 * Lifecycle:
 * - Starts when the extension spawns it via bg_shell
 * - Stops when: all PRs are merged/closed, state.status set to "stopped",
 *   or the process is killed
 */

import { appendFileSync } from "node:fs";
import type {
    MonitorState, PrRef, PrTrackingState,
} from "./types.js";
import { formatPrRef } from "./types.js";
import { loadState, saveState, eventsFilePath } from "./state.js";
import { fetchPrSnapshot, fetchComments } from "./gh.js";
import { diffSnapshot } from "./differ.js";
import { classifyEvent, type ClassifiedEvent } from "./classifier.js";
import { consumeEvents, logConsumedEvents } from "./consumer.js";

// ── Entry point ────────────────────────────────────────────────────

const projectRoot = process.argv[2] || process.cwd();

function log(level: string, message: string): void {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [pr-pilot] [${level}] ${message}`);
}

function appendEvent(classified: ClassifiedEvent): void {
    const entry = {
        ...classified,
        writtenAt: new Date().toISOString(),
    };
    appendFileSync(eventsFilePath(projectRoot), JSON.stringify(entry) + "\n");
}

async function pollOnce(state: MonitorState): Promise<void> {
    for (const [key, prState] of state.prStates) {
        const ref = prState.ref;
        const label = formatPrRef(ref);

        // Skip merged/closed PRs
        if (prState.lastSnapshot?.state === "merged" || prState.lastSnapshot?.state === "closed") {
            continue;
        }

        log("info", `Polling ${label}...`);

        // Fetch current state
        const snapshot = fetchPrSnapshot(ref);
        if (!snapshot) {
            log("warn", `Failed to fetch ${label} — skipping this cycle`);
            continue;
        }

        // Fetch comments
        const comments = fetchComments(ref);

        // Diff against previous state
        const events = diffSnapshot(ref, prState, snapshot, comments);

        // Classify and emit events
        for (const event of events) {
            const classified = classifyEvent(event, state.config);
            log("info", `[${label}] ${classified.action}: ${classified.reason}`);
            appendEvent(classified);

            // Mark comments as processed
            if (event.comment) {
                prState.processedCommentIds.add(event.comment.id);
            }
        }

        // Mark all fetched comments as seen (even if no events were emitted)
        for (const comment of comments) {
            prState.processedCommentIds.add(comment.id);
        }

        // Update tracking state
        prState.lastSnapshot = snapshot;
    }

    // Consume events written during this cycle (and any unconsumed from prior cycles)
    const consumeResult = consumeEvents(projectRoot, state.eventCursor);
    logConsumedEvents(consumeResult.consumed);
    state.eventCursor = consumeResult.newCursor;

    state.lastPollAt = new Date().toISOString();
}

function allPrsDone(state: MonitorState): boolean {
    for (const [, prState] of state.prStates) {
        const s = prState.lastSnapshot?.state;
        if (s !== "merged" && s !== "closed") return false;
    }
    return true;
}

async function main(): Promise<void> {
    log("info", `Starting PR Pilot monitor (project: ${projectRoot})`);

    const state = loadState(projectRoot);
    if (!state) {
        log("error", "No monitor state found. Start monitoring via /pr-pilot first.");
        process.exit(1);
    }

    if (state.status !== "running") {
        log("info", `Monitor status is "${state.status}" — exiting`);
        process.exit(0);
    }

    const interval = state.config.pollIntervalSeconds * 1000;
    log("info", `Monitoring ${state.config.prs.length} PR(s), polling every ${state.config.pollIntervalSeconds}s`);

    // Initial poll
    try {
        await pollOnce(state);
        saveState(projectRoot, state);
    } catch (err) {
        log("error", `Poll failed: ${err}`);
        state.lastError = String(err);
        saveState(projectRoot, state);
    }

    // Polling loop
    const timer = setInterval(async () => {
        // Re-read state in case the extension updated it (e.g. stopped monitoring)
        const freshState = loadState(projectRoot);
        if (!freshState || freshState.status !== "running") {
            log("info", "Monitor stopped externally — exiting");
            clearInterval(timer);
            process.exit(0);
        }

        try {
            await pollOnce(freshState);
            saveState(projectRoot, freshState);

            if (allPrsDone(freshState)) {
                log("info", "All PRs are merged or closed — monitoring complete");
                freshState.status = "stopped";
                saveState(projectRoot, freshState);
                clearInterval(timer);
                process.exit(0);
            }
        } catch (err) {
            log("error", `Poll failed: ${err}`);
            freshState.lastError = String(err);
            saveState(projectRoot, freshState);
        }
    }, interval);
}

main().catch(err => {
    log("error", `Fatal: ${err}`);
    process.exit(1);
});
