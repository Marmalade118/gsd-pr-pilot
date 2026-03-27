/**
 * gsd-pr-pilot — EventList component
 *
 * Scrollable list of classified events with keyboard navigation:
 *   ↑/↓  — move selection
 *   d    — dismiss selected event
 *   a    — acknowledge selected event
 *   f    — manual fix (stub — logs to stderr)
 *
 * Escalation events are highlighted in red/bold.
 * Dismissed events are dimmed.
 * Only active when isActive prop is true (EventList panel is focused).
 */

import { useState, useEffect, useRef } from "react";
import { execFileSync } from "node:child_process";
import { Box, Text, useInput } from "ink";
import type { ClassifiedEvent } from "../classifier.js";

/**
 * Fire a WezTerm toast notification. Silently ignored if wezterm CLI is not
 * available, the pane is not inside WezTerm, or any other error occurs.
 */
function sendToast(title: string, body: string): void {
    try {
        execFileSync("wezterm", ["cli", "send-notification", "--title", title, "--body", body], {
            timeout: 5000,
            stdio: "ignore",
        });
    } catch {
        // wezterm not available, not in a WezTerm terminal, or notification failed — ignore
    }
}

interface EventListProps {
    events: ClassifiedEvent[];
    isActive: boolean;
}

const MAX_VISIBLE = 30;

export function EventList({ events, isActive }: EventListProps) {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [dismissedIndices, setDismissedIndices] = useState<Set<number>>(new Set());
    const [acknowledgedIndices, setAcknowledgedIndices] = useState<Set<number>>(new Set());

    // Track previously-seen event count to detect new arrivals
    const prevCountRef = useRef(0);

    // Fire toast notifications for newly-arriving escalation events
    useEffect(() => {
        const prevCount = prevCountRef.current;
        if (events.length > prevCount) {
            // Only look at events added since the last render
            const newEvents = events.slice(prevCount);
            for (const ce of newEvents) {
                if (ce.action === "escalate") {
                    const prKey = `${ce.event.ref.owner}/${ce.event.ref.repo}#${ce.event.ref.number}`;
                    sendToast("PR Pilot — Escalation", `${prKey}: ${ce.reason}`);
                }
            }
        }
        prevCountRef.current = events.length;
    }, [events]);

    // Show most-recent events first, capped at MAX_VISIBLE
    const visible = events.slice(-MAX_VISIBLE).reverse();
    const visibleCount = visible.length;

    useInput(
        (input, key) => {
            if (key.upArrow) {
                setSelectedIndex(i => Math.max(0, i - 1));
            } else if (key.downArrow) {
                setSelectedIndex(i => Math.min(visibleCount - 1, i + 1));
            } else if (input === "d") {
                // Dismiss: add to dismissed set
                setDismissedIndices(prev => {
                    const next = new Set(prev);
                    next.add(selectedIndex);
                    return next;
                });
            } else if (input === "a") {
                // Acknowledge: add to acknowledged set
                setAcknowledgedIndices(prev => {
                    const next = new Set(prev);
                    next.add(selectedIndex);
                    return next;
                });
            } else if (input === "f") {
                // Manual fix: not yet implemented in TUI
                process.stderr.write("[pr-pilot] manual fix triggering from TUI not yet implemented\n");
            }
        },
        { isActive },
    );

    if (visibleCount === 0) {
        return (
            <Box
                flexGrow={1}
                borderStyle="single"
                borderColor={isActive ? "cyan" : "gray"}
                paddingX={1}
                flexDirection="column"
            >
                <Text bold>Events {isActive ? <Text color="cyan">[focused]</Text> : ""}</Text>
                <Text dimColor>No events yet.</Text>
            </Box>
        );
    }

    return (
        <Box
            flexGrow={1}
            borderStyle="single"
            borderColor={isActive ? "cyan" : "gray"}
            paddingX={1}
            flexDirection="column"
        >
            <Text bold>
                Events{" "}
                {isActive ? <Text color="cyan">[focused]</Text> : ""}
            </Text>
            {visible.map((ce, idx) => {
                const isDismissed = dismissedIndices.has(idx);
                const isAcknowledged = acknowledgedIndices.has(idx);
                const isSelected = isActive && idx === selectedIndex;
                const isEscalation = ce.action === "escalate";

                const prKey = `${ce.event.ref.owner}/${ce.event.ref.repo}#${ce.event.ref.number}`;
                const label = `[${ce.event.kind}] ${prKey} — ${ce.reason}`;

                if (isDismissed) {
                    return (
                        <Box key={idx}>
                            <Text dimColor>{isSelected ? "▶ " : "  "}{label} (dismissed)</Text>
                        </Box>
                    );
                }

                if (isEscalation) {
                    return (
                        <Box key={idx}>
                            <Text color="red" bold inverse={isSelected}>
                                {isSelected ? "▶ " : "  "}
                                🚨 {label}
                                {isAcknowledged ? " ✓" : ""}
                            </Text>
                        </Box>
                    );
                }

                return (
                    <Box key={idx}>
                        <Text inverse={isSelected}>
                            {isSelected ? "▶ " : "  "}
                            {ce.action === "fix" ? "🔧 " : ce.action === "notify" ? "ℹ️  " : ""}
                            {label}
                            {isAcknowledged ? " ✓" : ""}
                        </Text>
                    </Box>
                );
            })}
        </Box>
    );
}
