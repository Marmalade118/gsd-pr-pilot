/**
 * gsd-pr-pilot — PrStatus component
 *
 * Renders a bordered box with one row per monitored PR showing:
 *   - PR key (owner/repo#N)
 *   - Check status icon (✅ passed / ❌ failed / ⏳ pending)
 *   - Review status icon (✅ approved / 🔄 changes requested / ⏳ pending)
 *   - Fix attempt count
 */

import { Box, Text } from "ink";
import type { MonitorState } from "../types.js";

interface PrStatusProps {
    state: MonitorState | null;
}

export function PrStatus({ state }: PrStatusProps) {
    if (!state) {
        return (
            <Box borderStyle="single" borderColor="gray" paddingX={1}>
                <Text dimColor>Waiting for first poll…</Text>
            </Box>
        );
    }

    const rows = Array.from(state.prStates.entries());

    if (rows.length === 0) {
        return (
            <Box borderStyle="single" borderColor="gray" paddingX={1}>
                <Text dimColor>No PRs being monitored.</Text>
            </Box>
        );
    }

    return (
        <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
            <Text bold underline>PR Status</Text>
            {rows.map(([key, ps]) => {
                const snap = ps.lastSnapshot;

                const checkIcon = snap
                    ? snap.checksPass
                        ? "✅"
                        : snap.checksFailed
                            ? "❌"
                            : "⏳"
                    : "⏳";

                const reviewIcon = snap
                    ? snap.approved
                        ? "✅"
                        : snap.changesRequested
                            ? "🔄"
                            : "⏳"
                    : "⏳";

                const fixCount = ps.fixes.length;

                return (
                    <Box key={key} gap={1}>
                        <Text bold>{key}</Text>
                        <Text>checks:{checkIcon}</Text>
                        <Text>review:{reviewIcon}</Text>
                        <Text dimColor>fixes:{fixCount}</Text>
                    </Box>
                );
            })}
        </Box>
    );
}
