/**
 * Tests for gh.ts — mapRawChecks and mapRawReviewComments
 *
 * These are pure mapping functions that don't exec gh CLI, so they're
 * testable without any mocking or network access.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mapRawChecks, mapRawReviewComments } from "../gh.js";

// ── mapRawChecks ───────────────────────────────────────────────────

describe("mapRawChecks", () => {
    it("maps a SUCCESS check to completed/success", () => {
        const result = mapRawChecks([{ name: "build", state: "SUCCESS", link: "https://example.com/runs/1" }]);
        assert.equal(result.length, 1);
        assert.equal(result[0].name, "build");
        assert.equal(result[0].status, "completed");
        assert.equal(result[0].conclusion, "success");
        assert.equal(result[0].detailsUrl, "https://example.com/runs/1");
    });

    it("maps a FAILURE check to completed/failure", () => {
        const result = mapRawChecks([{ name: "lint", state: "FAILURE" }]);
        assert.equal(result[0].status, "completed");
        assert.equal(result[0].conclusion, "failure");
        assert.equal(result[0].detailsUrl, null);
    });

    it("maps a PENDING check to in_progress/null conclusion", () => {
        const result = mapRawChecks([{ name: "typecheck", state: "PENDING" }]);
        assert.equal(result[0].status, "in_progress");
        assert.equal(result[0].conclusion, null);
    });

    it("maps a SKIPPED check to completed/skipped", () => {
        const result = mapRawChecks([{ name: "e2e", state: "SKIPPED" }]);
        assert.equal(result[0].status, "completed");
        assert.equal(result[0].conclusion, "skipped");
    });

    it("handles an empty array", () => {
        const result = mapRawChecks([]);
        assert.deepEqual(result, []);
    });

    it("handles mixed states in one batch", () => {
        const raw = [
            { name: "build", state: "SUCCESS", link: "https://example.com/1" },
            { name: "lint", state: "FAILURE", link: "https://example.com/2" },
            { name: "typecheck", state: "PENDING" },
            { name: "e2e", state: "SKIPPED" },
        ];
        const result = mapRawChecks(raw);
        assert.equal(result.length, 4);
        assert.equal(result[0].conclusion, "success");
        assert.equal(result[1].conclusion, "failure");
        assert.equal(result[2].conclusion, null);
        assert.equal(result[3].conclusion, "skipped");
        // Only the first two had links
        assert.equal(result[0].detailsUrl, "https://example.com/1");
        assert.equal(result[2].detailsUrl, null);
    });
});

// ── mapRawReviewComments ───────────────────────────────────────────

describe("mapRawReviewComments", () => {
    it("maps a single review comment with all fields", () => {
        const raw = [{
            id: 101,
            user: { login: "alice" },
            body: "Please fix this.",
            created_at: "2024-03-01T12:00:00Z",
            path: "src/foo.ts",
            original_line: 42,
        }];
        const result = mapRawReviewComments(raw);
        assert.equal(result.length, 1);
        assert.equal(result[0].id, 101);
        assert.equal(result[0].author, "alice");
        assert.equal(result[0].body, "Please fix this.");
        assert.equal(result[0].createdAt, "2024-03-01T12:00:00Z");
        assert.equal(result[0].path, "src/foo.ts");
        assert.equal(result[0].line, 42);
        assert.equal(result[0].isReviewComment, true);
    });

    it("handles null original_line gracefully", () => {
        const raw = [{
            id: 202,
            user: { login: "bob" },
            body: "General comment.",
            created_at: "2024-03-02T09:00:00Z",
            path: "README.md",
            original_line: null,
        }];
        const result = mapRawReviewComments(raw);
        assert.equal(result[0].line, null);
    });

    it("handles missing optional fields (no user, no path, no original_line)", () => {
        const raw = [{
            id: 303,
            body: "Orphaned comment.",
            created_at: "2024-03-03T00:00:00Z",
        }];
        const result = mapRawReviewComments(raw);
        assert.equal(result[0].author, "unknown");
        assert.equal(result[0].path, null);
        assert.equal(result[0].line, null);
    });

    it("maps multiple review comments correctly", () => {
        const raw = [
            { id: 1, user: { login: "alice" }, body: "Fix A", created_at: "2024-01-01T00:00:00Z", path: "a.ts", original_line: 10 },
            { id: 2, user: { login: "bob" }, body: "Fix B", created_at: "2024-01-02T00:00:00Z", path: "b.ts", original_line: 20 },
            { id: 3, user: { login: "carol" }, body: "Fix C", created_at: "2024-01-03T00:00:00Z", path: "c.ts", original_line: null },
        ];
        const result = mapRawReviewComments(raw);
        assert.equal(result.length, 3);
        assert.equal(result[0].author, "alice");
        assert.equal(result[1].author, "bob");
        assert.equal(result[2].author, "carol");
        assert.equal(result[2].line, null);
    });

    it("returns empty array for empty input", () => {
        const result = mapRawReviewComments([]);
        assert.deepEqual(result, []);
    });
});
