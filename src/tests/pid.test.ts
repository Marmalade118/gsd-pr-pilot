/**
 * Tests for PID tracking helpers in state.ts
 *
 * These functions manage poller.pid to detect stale monitor state on restart.
 * All tests use a temporary directory so they don't pollute the project root.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { pidFilePath, writePid, readPid, isPidAlive, clearPid } from "../state.js";

// ── Temp directory setup ───────────────────────────────────────────

let tmpRoot: string;

before(() => {
    // Create a temp dir that acts as the projectRoot for all tests
    tmpRoot = mkdtempSync(join(tmpdir(), "pr-pilot-pid-test-"));
});

after(() => {
    // Clean up temp dir
    try {
        rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
        // Best-effort cleanup
    }
});

// ── pidFilePath ────────────────────────────────────────────────────

describe("pidFilePath", () => {
    it("returns the expected path inside .gsd/pr-pilot/", () => {
        const p = pidFilePath(tmpRoot);
        assert.ok(p.endsWith("poller.pid"), `Expected path ending in poller.pid, got: ${p}`);
        assert.ok(p.includes(".gsd"), `Expected .gsd in path, got: ${p}`);
    });
});

// ── writePid / readPid ─────────────────────────────────────────────

describe("writePid / readPid", () => {
    it("writePid creates the file and readPid returns the written PID", () => {
        const testPid = 12345;
        writePid(tmpRoot, testPid);

        const pidFile = pidFilePath(tmpRoot);
        assert.ok(existsSync(pidFile), "PID file should exist after writePid");

        const read = readPid(tmpRoot);
        assert.equal(read, testPid, `Expected PID ${testPid}, got ${read}`);
    });

    it("readPid returns null when pidfile does not exist", () => {
        // Use a fresh tmpRoot sub-path that has no pidfile
        const fresh = mkdtempSync(join(tmpdir(), "pr-pilot-pid-nofile-"));
        try {
            const result = readPid(fresh);
            assert.equal(result, null, "Should return null when pidfile is absent");
        } finally {
            rmSync(fresh, { recursive: true, force: true });
        }
    });
});

// ── isPidAlive ─────────────────────────────────────────────────────

describe("isPidAlive", () => {
    it("returns true for the current process PID", () => {
        const alive = isPidAlive(process.pid);
        assert.ok(alive, "Current process PID should be alive");
    });

    it("returns false for a definitely-dead PID (999999)", () => {
        // PID 999999 is virtually guaranteed to not exist on any platform
        const alive = isPidAlive(999999);
        assert.ok(!alive, "PID 999999 should not be alive");
    });
});

// ── clearPid ───────────────────────────────────────────────────────

describe("clearPid", () => {
    it("deletes the pidfile if it exists", () => {
        // Ensure a pidfile is written first
        writePid(tmpRoot, 99999);
        const pidFile = pidFilePath(tmpRoot);
        assert.ok(existsSync(pidFile), "PID file should exist before clearPid");

        clearPid(tmpRoot);
        assert.ok(!existsSync(pidFile), "PID file should be deleted after clearPid");
    });

    it("does not throw when pidfile does not exist", () => {
        const fresh = mkdtempSync(join(tmpdir(), "pr-pilot-pid-clear-"));
        try {
            // Should not throw
            assert.doesNotThrow(() => clearPid(fresh));
        } finally {
            rmSync(fresh, { recursive: true, force: true });
        }
    });
});
