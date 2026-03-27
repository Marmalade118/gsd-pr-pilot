/**
 * gsd-pr-pilot — Event Consumer
 *
 * Reads new events from events.jsonl starting at a byte-offset cursor,
 * logs each consumed event tersely, and returns the new cursor position.
 *
 * The consumer is intentionally read-only with respect to events.jsonl —
 * it never truncates or rewrites the file. The cursor persists in
 * monitor-state.json so consumption survives process restarts.
 */

import { existsSync, readFileSync } from "node:fs";
import type { ClassifiedEvent } from "./classifier.js";
import { eventsFilePath } from "./state.js";

// ── Public types ───────────────────────────────────────────────────

export interface ConsumeResult {
    consumed: ClassifiedEvent[];
    newCursor: number;
}

// ── Core function ──────────────────────────────────────────────────

/**
 * Read new events from events.jsonl starting at `cursor` bytes.
 *
 * Key invariants:
 * - Partial lines at EOF (no trailing \n) are never consumed — the cursor
 *   stops before them so a future call can pick them up once complete.
 * - Malformed JSON lines are skipped with a warning; the cursor still
 *   advances past them so they are not re-processed endlessly.
 * - If the file does not exist the function returns immediately with an
 *   empty result and the cursor unchanged.
 */
export function consumeEvents(projectRoot: string, cursor: number): ConsumeResult {
    const filePath = eventsFilePath(projectRoot);

    if (!existsSync(filePath)) {
        return { consumed: [], newCursor: cursor };
    }

    // Read the whole file into a Buffer so we can work with raw byte counts.
    let buf: Buffer;
    try {
        buf = readFileSync(filePath);
    } catch {
        return { consumed: [], newCursor: cursor };
    }

    // Nothing new since last read.
    if (cursor >= buf.length) {
        return { consumed: [], newCursor: cursor };
    }

    // Slice from the current cursor position.
    const slice = buf.slice(cursor);
    const text = slice.toString("utf-8");

    const consumed: ClassifiedEvent[] = [];
    let bytesConsumed = 0;

    // Split on newline. The last element may be a partial line (no trailing \n).
    const parts = text.split("\n");

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isLast = i === parts.length - 1;

        if (isLast) {
            // Last segment: only process it if it is empty (meaning the file
            // ended with a newline) — otherwise it is a partial write.
            if (part.length > 0) {
                // Partial line — do not consume, leave cursor here.
                break;
            }
            // It is empty and it is the last part, meaning the previous line
            // had a trailing \n. Nothing more to consume.
            break;
        }

        // Each complete line contributes its byte length plus the \n separator.
        const lineByteLen = Buffer.byteLength(part, "utf-8") + 1; // +1 for \n

        if (part.trim() === "") {
            // Blank line — skip but advance cursor.
            bytesConsumed += lineByteLen;
            continue;
        }

        try {
            const event = JSON.parse(part) as ClassifiedEvent;
            consumed.push(event);
            bytesConsumed += lineByteLen;
        } catch {
            // Malformed JSON — warn and advance past it so we don't loop forever.
            const ts = new Date().toISOString();
            console.warn(`[${ts}] [pr-pilot] [consumer] WARN: malformed line skipped: ${part.slice(0, 120)}`);
            bytesConsumed += lineByteLen;
        }
    }

    return { consumed, newCursor: cursor + bytesConsumed };
}

// ── Logging ────────────────────────────────────────────────────────

/**
 * Log one terse line per consumed event.
 * Format: [timestamp] [pr-pilot] [consumed] <action>: <reason>
 * One line per event — never multi-line (R013).
 */
export function logConsumedEvents(consumed: ClassifiedEvent[]): void {
    for (const ce of consumed) {
        const ts = new Date().toISOString();
        console.log(`[${ts}] [pr-pilot] [consumed] ${ce.action}: ${ce.reason}`);
    }
}
