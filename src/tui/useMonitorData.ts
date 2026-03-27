/**
 * gsd-pr-pilot — useMonitorData hook
 *
 * Polls the filesystem every 2 seconds and returns current monitor state,
 * recent events, and fix history. This is display-only — it never advances
 * the real event cursor in monitor-state.json.
 */

import { useState, useEffect } from "react";
import type { MonitorState, FixAttempt } from "../types.js";
import type { ClassifiedEvent } from "../classifier.js";
import { loadState, readFixes } from "../state.js";
import { consumeEvents } from "../consumer.js";

export interface MonitorData {
    state: MonitorState | null;
    events: ClassifiedEvent[];
    fixes: FixAttempt[];
    loading: boolean;
}

/**
 * Poll the filesystem every 2 seconds for monitor state, fix history, and
 * recent events. Always reads from cursor 0 so the TUI display never
 * advances the real consumption cursor stored in monitor-state.json.
 */
export function useMonitorData(projectRoot: string): MonitorData {
    const [data, setData] = useState<MonitorData>({
        state: null,
        events: [],
        fixes: [],
        loading: true,
    });

    useEffect(() => {
        let cancelled = false;

        function poll(): void {
            try {
                const state = loadState(projectRoot);
                const fixes = readFixes(projectRoot);
                // Always read from cursor 0 — display-only, does not consume
                const { consumed: events } = consumeEvents(projectRoot, 0);

                if (!cancelled) {
                    setData({ state, events, fixes, loading: false });
                }
            } catch {
                // Partial-write safety: swallow read errors and keep previous data
                if (!cancelled) {
                    setData(prev => ({ ...prev, loading: false }));
                }
            }
        }

        // Initial load
        poll();

        // Poll every 2 seconds
        const id = setInterval(poll, 2000);

        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [projectRoot]);

    return data;
}
