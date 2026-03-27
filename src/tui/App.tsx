/**
 * gsd-pr-pilot — TUI App component (full layout)
 *
 * Three-panel layout stacked vertically:
 *   Top:    PrStatus   — per-PR check/review/fix status
 *   Middle: EventList  — scrollable events with keyboard nav (flexGrow=1)
 *   Bottom: FixHistory — recent fix attempt history
 *
 * Tab cycles focus between panels (0=PrStatus, 1=EventList, 2=FixHistory).
 * EventList keyboard controls are only active when focusedPanel === 1.
 *
 * Watches state.status — exits cleanly when it becomes "stopped".
 */

import { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { useMonitorData } from "./useMonitorData.js";
import { PrStatus } from "./PrStatus.js";
import { EventList } from "./EventList.js";
import { FixHistory } from "./FixHistory.js";

interface AppProps {
    projectRoot: string;
}

export function App({ projectRoot }: AppProps) {
    const { state, events, fixes, loading } = useMonitorData(projectRoot);
    const [focusedPanel, setFocusedPanel] = useState(1); // default focus on EventList
    const { exit } = useApp();

    // Cycle panels with Tab
    useInput((input, key) => {
        if (key.tab) {
            setFocusedPanel(prev => (prev + 1) % 3);
        }
    });

    // Auto-exit when monitor is stopped
    useEffect(() => {
        if (state?.status === "stopped") {
            exit();
        }
    }, [state?.status, exit]);

    if (loading) {
        return (
            <Box>
                <Text color="yellow">Loading monitor data…</Text>
            </Box>
        );
    }

    if (!state) {
        return (
            <Box flexDirection="column">
                <Text color="red">No monitor state found.</Text>
                <Text dimColor>Run /pr-pilot start to begin monitoring.</Text>
                <Text dimColor>Project: {projectRoot}</Text>
            </Box>
        );
    }

    const statusColor =
        state.status === "running"
            ? "green"
            : state.status === "error"
                ? "red"
                : "yellow";

    const lastPoll = state.lastPollAt
        ? new Date(state.lastPollAt).toLocaleTimeString()
        : "—";

    return (
        <Box flexDirection="column" height="100%">
            {/* Top: PR status */}
            <PrStatus state={state} />

            {/* Middle: Event list — takes remaining height */}
            <EventList
                events={events}
                isActive={focusedPanel === 1}
            />

            {/* Bottom: Fix history */}
            <FixHistory fixes={fixes} />

            {/* Status bar */}
            <Box paddingX={1} gap={2}>
                <Text>
                    Status:{" "}
                    <Text color={statusColor}>{state.status}</Text>
                </Text>
                <Text dimColor>Last poll: {lastPoll}</Text>
                <Text dimColor>Tab: switch panel  ↑↓: navigate  d: dismiss  a: ack  f: fix</Text>
            </Box>
        </Box>
    );
}
