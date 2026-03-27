/**
 * Tests for consumer.ts — consumeEvents()
 *
 * Uses real temp files (mkdtempSync) to avoid mocking fs.
 * Each test creates its own isolated directory and cleans up after.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";

import { consumeEvents } from "../consumer.js";
import type { ClassifiedEvent } from "../classifier.js";

// ── Helpers ────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "pr-pilot-consumer-test-"));
    tmpDirs.push(dir);
    // Create the .gsd/pr-pilot sub-path so eventsFilePath resolves correctly
    mkdirSync(join(dir, ".gsd", "pr-pilot"), { recursive: true });
    return dir;
}

function writeEvents(projectRoot: string, content: string): void {
    writeFileSync(join(projectRoot, ".gsd", "pr-pilot", "events.jsonl"), content);
}

function makeEvent(action: string, reason: string): ClassifiedEvent {
    return {
        event: {
            kind: "check_failed",
            ref: { owner: "o", repo: "r", number: 1 },
            timestamp: "2024-01-01T00:00:00.000Z",
        },
        action: action as ClassifiedEvent["action"],
        reason,
    };
}

// Clean up all temp dirs after tests run
after(() => {
    for (const dir of tmpDirs) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

// ── Tests ──────────────────────────────────────────────────────────

describe("consumeEvents", () => {
    it("returns empty result when events.jsonl does not exist", () => {
        const dir = makeTmpDir();
        // Don't write events.jsonl — it should not exist
        const result = consumeEvents(dir, 0);
        assert.equal(result.consumed.length, 0, "consumed should be empty");
        assert.equal(result.newCursor, 0, "cursor should stay at 0");
    });

    it("returns empty result for an empty file", () => {
        const dir = makeTmpDir();
        writeEvents(dir, "");
        const result = consumeEvents(dir, 0);
        assert.equal(result.consumed.length, 0, "consumed should be empty");
        assert.equal(result.newCursor, 0, "cursor should stay at 0");
    });

    it("consumes 3 valid events and advances cursor to file size", () => {
        const dir = makeTmpDir();
        const e1 = makeEvent("fix", "CI failed");
        const e2 = makeEvent("escalate", "Human review");
        const e3 = makeEvent("notify", "Check passed");
        const content = [e1, e2, e3].map(e => JSON.stringify(e)).join("\n") + "\n";
        writeEvents(dir, content);

        const fileSize = Buffer.byteLength(content, "utf-8");
        const result = consumeEvents(dir, 0);
        assert.equal(result.consumed.length, 3, "should consume 3 events");
        assert.equal(result.newCursor, fileSize, "cursor should equal file size");
        assert.equal(result.consumed[0].action, "fix");
        assert.equal(result.consumed[1].action, "escalate");
        assert.equal(result.consumed[2].action, "notify");
    });

    it("returns empty when cursor is already at end of file", () => {
        const dir = makeTmpDir();
        const e = makeEvent("notify", "test");
        const content = JSON.stringify(e) + "\n";
        writeEvents(dir, content);

        const fileSize = Buffer.byteLength(content, "utf-8");
        // First consume to advance cursor
        const first = consumeEvents(dir, 0);
        assert.equal(first.consumed.length, 1);
        assert.equal(first.newCursor, fileSize);

        // Second consume — cursor already at EOF
        const second = consumeEvents(dir, first.newCursor);
        assert.equal(second.consumed.length, 0, "no new events");
        assert.equal(second.newCursor, fileSize, "cursor unchanged");
    });

    it("does not consume partial line at EOF (no trailing newline)", () => {
        const dir = makeTmpDir();
        const e1 = makeEvent("fix", "complete line");
        const e2 = makeEvent("notify", "partial line no newline");
        const completeLine = JSON.stringify(e1) + "\n";
        const partialLine = JSON.stringify(e2); // intentionally no trailing \n
        writeEvents(dir, completeLine + partialLine);

        const result = consumeEvents(dir, 0);
        // Only the complete line should be consumed
        assert.equal(result.consumed.length, 1, "only complete line consumed");
        assert.equal(result.consumed[0].action, "fix");
        // Cursor should stop just after the complete line's newline
        assert.equal(result.newCursor, Buffer.byteLength(completeLine, "utf-8"));
    });

    it("skips malformed JSON line and advances cursor past it", () => {
        const dir = makeTmpDir();
        const e1 = makeEvent("fix", "before bad line");
        const e2 = makeEvent("notify", "after bad line");
        const content = [
            JSON.stringify(e1),
            "NOT_VALID_JSON{{{",
            JSON.stringify(e2),
        ].join("\n") + "\n";
        writeEvents(dir, content);

        const result = consumeEvents(dir, 0);
        // e1 and e2 should be consumed, bad line skipped
        assert.equal(result.consumed.length, 2, "should consume 2 valid events");
        assert.equal(result.consumed[0].action, "fix");
        assert.equal(result.consumed[1].action, "notify");
        // Cursor should be at the end of the file
        assert.equal(result.newCursor, Buffer.byteLength(content, "utf-8"));
    });

    it("resumes from a mid-file cursor correctly", () => {
        const dir = makeTmpDir();
        const e1 = makeEvent("fix", "first event");
        const e2 = makeEvent("escalate", "second event");
        const line1 = JSON.stringify(e1) + "\n";
        const line2 = JSON.stringify(e2) + "\n";
        writeEvents(dir, line1 + line2);

        // Simulate having already consumed the first line
        const cursorAfterFirst = Buffer.byteLength(line1, "utf-8");
        const result = consumeEvents(dir, cursorAfterFirst);
        assert.equal(result.consumed.length, 1, "should only consume second event");
        assert.equal(result.consumed[0].action, "escalate");
        assert.equal(result.newCursor, Buffer.byteLength(line1 + line2, "utf-8"));
    });

    it("handles a file with only a partial line (truncated write)", () => {
        const dir = makeTmpDir();
        // Simulate a half-written JSON line
        writeEvents(dir, '{"event":{"kind":"check_failed"');
        const result = consumeEvents(dir, 0);
        assert.equal(result.consumed.length, 0, "partial line should not be consumed");
        assert.equal(result.newCursor, 0, "cursor should stay at 0");
    });
});
