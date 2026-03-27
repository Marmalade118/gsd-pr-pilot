/**
 * Tests for types.ts — parsePrRef, serialiseState, deserialiseState
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    parsePrRef,
    formatPrRef,
    serialiseState,
    deserialiseState,
    DEFAULT_MONITOR_CONFIG,
} from "../types.js";
import type { MonitorState, MonitorConfig, PrTrackingState } from "../types.js";

// ── parsePrRef ─────────────────────────────────────────────────────

describe("parsePrRef", () => {
    it("parses a valid PR ref", () => {
        const ref = parsePrRef("owner/repo#42");
        assert.ok(ref !== null, "should return a PrRef");
        assert.equal(ref.owner, "owner");
        assert.equal(ref.repo, "repo");
        assert.equal(ref.number, 42);
    });

    it("parses PR ref with hyphenated repo name", () => {
        const ref = parsePrRef("octocat/hello-world#1");
        assert.ok(ref !== null);
        assert.equal(ref.owner, "octocat");
        assert.equal(ref.repo, "hello-world");
        assert.equal(ref.number, 1);
    });

    it("returns null for missing #number", () => {
        assert.equal(parsePrRef("owner/repo"), null);
    });

    it("returns null for missing repo", () => {
        assert.equal(parsePrRef("owner#42"), null);
    });

    it("returns null for empty string", () => {
        assert.equal(parsePrRef(""), null);
    });

    it("returns null for non-numeric PR number", () => {
        assert.equal(parsePrRef("owner/repo#abc"), null);
    });
});

// ── Helpers ────────────────────────────────────────────────────────

function makeMinimalState(overrides?: Partial<MonitorState>): MonitorState {
    const config: MonitorConfig = {
        ...DEFAULT_MONITOR_CONFIG,
        prs: [],
    };

    return {
        status: "running",
        config,
        prStates: new Map<string, PrTrackingState>(),
        startedAt: "2024-01-01T00:00:00.000Z",
        lastPollAt: null,
        lastError: null,
        eventCursor: 0,
        ...overrides,
    };
}

// ── serialiseState / deserialiseState round-trip ───────────────────

describe("serialiseState / deserialiseState", () => {
    it("round-trips a minimal state with eventCursor and repoMap", () => {
        const state = makeMinimalState({ eventCursor: 1024 });
        state.config.repoMap = { "owner/repo#1": "/local/path/to/repo" };

        const serialised = serialiseState(state) as Record<string, unknown>;
        const restored = deserialiseState(serialised);

        assert.equal(restored.eventCursor, 1024);
        assert.deepEqual(restored.config.repoMap, { "owner/repo#1": "/local/path/to/repo" });
        assert.equal(restored.status, "running");
        assert.equal(restored.startedAt, "2024-01-01T00:00:00.000Z");
        assert.equal(restored.lastPollAt, null);
        assert.equal(restored.lastError, null);
    });

    it("round-trips prStates with Set/Map conversion", () => {
        const ref = parsePrRef("owner/repo#1");
        assert.ok(ref !== null);

        const prState: PrTrackingState = {
            ref,
            lastSnapshot: null,
            processedCommentIds: new Set([10, 20, 30]),
            attemptedCheckFixes: new Set(["lint", "typecheck"]),
            fixes: [],
            consecutiveFailures: 0,
        };

        const state = makeMinimalState();
        state.prStates.set(formatPrRef(ref), prState);

        const serialised = serialiseState(state) as Record<string, unknown>;
        const restored = deserialiseState(serialised);

        const restoredPr = restored.prStates.get("owner/repo#1");
        assert.ok(restoredPr, "prState should be restored");
        assert.ok(restoredPr.processedCommentIds instanceof Set, "processedCommentIds should be a Set");
        assert.ok(restoredPr.processedCommentIds.has(10));
        assert.ok(restoredPr.processedCommentIds.has(20));
        assert.ok(restoredPr.attemptedCheckFixes instanceof Set, "attemptedCheckFixes should be a Set");
        assert.ok(restoredPr.attemptedCheckFixes.has("lint"));
    });
});

// ── Backward-compatibility defaults ───────────────────────────────

describe("deserialiseState backward compatibility", () => {
    it("defaults eventCursor to 0 when field is absent", () => {
        const raw: Record<string, unknown> = {
            status: "stopped",
            config: {
                prs: [],
                autonomy: "fix",
                commentFilter: {
                    ci_checks: true,
                    human_reviews: true,
                    ai_reviews: false,
                    simplify_code: false,
                },
                pollIntervalSeconds: 60,
                maxFixAttempts: 5,
                // repoMap intentionally absent
                // eventCursor intentionally absent
            },
            prStates: {},
            startedAt: "2024-01-01T00:00:00.000Z",
            lastPollAt: null,
            lastError: null,
            // no eventCursor field
        };

        const restored = deserialiseState(raw);
        assert.equal(restored.eventCursor, 0, "eventCursor should default to 0");
    });

    it("defaults repoMap to {} when field is absent from config", () => {
        const raw: Record<string, unknown> = {
            status: "running",
            config: {
                prs: [],
                autonomy: "notify",
                commentFilter: {
                    ci_checks: true,
                    human_reviews: true,
                    ai_reviews: false,
                    simplify_code: false,
                },
                pollIntervalSeconds: 60,
                maxFixAttempts: 5,
                // no repoMap
            },
            prStates: {},
            startedAt: "2024-01-01T00:00:00.000Z",
            lastPollAt: null,
            lastError: null,
        };

        const restored = deserialiseState(raw);
        assert.deepEqual(restored.config.repoMap, {}, "repoMap should default to {}");
    });
});

// ── DEFAULT_MONITOR_CONFIG ─────────────────────────────────────────

describe("DEFAULT_MONITOR_CONFIG", () => {
    it("includes repoMap as an empty object", () => {
        assert.ok(
            Object.prototype.hasOwnProperty.call(DEFAULT_MONITOR_CONFIG, "repoMap"),
            "repoMap should be a property of DEFAULT_MONITOR_CONFIG",
        );
        assert.deepEqual(DEFAULT_MONITOR_CONFIG.repoMap, {});
    });
});
