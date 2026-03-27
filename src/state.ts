/**
 * gsd-pr-pilot — State Persistence
 *
 * Reads and writes monitor state to .gsd/pr-pilot/ in the project directory.
 * State survives process restarts — the polling loop can pick up where it left off.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { MonitorState, FixAttempt, PrRef } from "./types.js";
import { serialiseState, deserialiseState, formatPrRef } from "./types.js";

// ── Paths ──────────────────────────────────────────────────────────

function stateDir(projectRoot: string): string {
    return join(projectRoot, ".gsd", "pr-pilot");
}

function stateFile(projectRoot: string): string {
    return join(stateDir(projectRoot), "monitor-state.json");
}

function fixesLogFile(projectRoot: string): string {
    return join(stateDir(projectRoot), "fixes.jsonl");
}

export function eventsFilePath(projectRoot: string): string {
    return join(projectRoot, ".gsd", "pr-pilot", "events.jsonl");
}

export function pidFilePath(projectRoot: string): string {
    return join(stateDir(projectRoot), "poller.pid");
}

function reportFile(projectRoot: string): string {
    return join(stateDir(projectRoot), "REPORT.md");
}

// ── Read / Write ───────────────────────────────────────────────────

export function ensureStateDir(projectRoot: string): void {
    mkdirSync(stateDir(projectRoot), { recursive: true });
}

export function loadState(projectRoot: string): MonitorState | null {
    const path = stateFile(projectRoot);
    if (!existsSync(path)) return null;
    try {
        const raw = JSON.parse(readFileSync(path, "utf-8"));
        return deserialiseState(raw);
    } catch {
        return null;
    }
}

export function saveState(projectRoot: string, state: MonitorState): void {
    ensureStateDir(projectRoot);
    writeFileSync(stateFile(projectRoot), JSON.stringify(serialiseState(state), null, 2));
}

export function clearState(projectRoot: string): void {
    const path = stateFile(projectRoot);
    if (existsSync(path)) {
        writeFileSync(path, "");
    }
}

// ── PID tracking (R015) ────────────────────────────────────────────

/** Write the given PID to the pidfile, ensuring the state dir exists. */
export function writePid(projectRoot: string, pid: number): void {
    ensureStateDir(projectRoot);
    writeFileSync(pidFilePath(projectRoot), String(pid), "utf-8");
}

/** Read the PID from the pidfile. Returns null if the file is absent or unreadable. */
export function readPid(projectRoot: string): number | null {
    const path = pidFilePath(projectRoot);
    if (!existsSync(path)) return null;
    try {
        const raw = readFileSync(path, "utf-8").trim();
        const pid = parseInt(raw, 10);
        return Number.isFinite(pid) ? pid : null;
    } catch {
        return null;
    }
}

/**
 * Returns true if the process with the given PID is alive.
 * Uses `process.kill(pid, 0)` which works on both Unix and Windows:
 * no signal is sent — it only probes whether the PID exists.
 */
export function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** Delete the pidfile if it exists. */
export function clearPid(projectRoot: string): void {
    const path = pidFilePath(projectRoot);
    if (existsSync(path)) {
        try {
            unlinkSync(path);
        } catch {
            // Ignore deletion errors (race condition on exit is fine)
        }
    }
}

// ── Fix log (append-only JSONL) ────────────────────────────────────

export function appendFix(projectRoot: string, fix: FixAttempt): void {
    ensureStateDir(projectRoot);
    appendFileSync(fixesLogFile(projectRoot), JSON.stringify(fix) + "\n");
}

export function readFixes(projectRoot: string): FixAttempt[] {
    const path = fixesLogFile(projectRoot);
    if (!existsSync(path)) return [];
    try {
        return readFileSync(path, "utf-8")
            .split("\n")
            .filter(Boolean)
            .map(line => JSON.parse(line) as FixAttempt);
    } catch {
        return [];
    }
}

// ── Report generation ──────────────────────────────────────────────

export function writeReport(projectRoot: string, state: MonitorState): string {
    ensureStateDir(projectRoot);

    const fixes = readFixes(projectRoot);
    const lines: string[] = [
        "# PR Pilot Report",
        "",
        `**Started:** ${state.startedAt}`,
        `**Ended:** ${new Date().toISOString()}`,
        `**Status:** ${state.status}`,
        "",
        "## PRs Monitored",
        "",
    ];

    for (const [key, prState] of state.prStates) {
        const snap = prState.lastSnapshot;
        const prFixes = fixes.filter(f => formatPrRef(f.ref) === key);

        lines.push(`### ${key}${snap ? ` — ${snap.title}` : ""}`);
        lines.push("");

        if (snap) {
            lines.push(`- **State:** ${snap.state}`);
            lines.push(`- **Checks:** ${snap.checksPass ? "✅ all passing" : snap.checksFailed ? "❌ failures" : "⏳ pending"}`);
            lines.push(`- **Review:** ${snap.approved ? "✅ approved" : snap.changesRequested ? "🔄 changes requested" : "⏳ pending"}`);
            lines.push("");
        }

        if (prFixes.length > 0) {
            lines.push("#### Fix Attempts");
            lines.push("");
            lines.push("| Time | Event | Outcome | Description |");
            lines.push("|------|-------|---------|-------------|");
            for (const fix of prFixes) {
                const icon = fix.outcome === "success" ? "✅" : fix.outcome === "escalated" ? "🔔" : "❌";
                lines.push(`| ${fix.timestamp} | ${fix.event.kind} | ${icon} ${fix.outcome} | ${fix.description} |`);
            }
            lines.push("");
        } else {
            lines.push("No fix attempts.");
            lines.push("");
        }
    }

    // Summary
    const successCount = fixes.filter(f => f.outcome === "success").length;
    const escalatedCount = fixes.filter(f => f.outcome === "escalated").length;
    const failedCount = fixes.filter(f => f.outcome === "failed").length;

    lines.push("## Summary");
    lines.push("");
    lines.push(`- **Fixes applied:** ${successCount}`);
    lines.push(`- **Escalated to user:** ${escalatedCount}`);
    lines.push(`- **Fix attempts failed:** ${failedCount}`);

    const content = lines.join("\n") + "\n";
    const path = reportFile(projectRoot);
    writeFileSync(path, content);
    return path;
}
