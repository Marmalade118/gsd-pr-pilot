/**
 * gsd-pr-pilot — FixHistory component
 *
 * Renders the last N fix attempts with outcome icons:
 *   ✅ success
 *   ❌ failed
 *   ⬆️  escalated
 *   ⏭️  skipped
 */

import { Box, Text } from "ink";
import type { FixAttempt } from "../types.js";

const MAX_HISTORY = 10;

interface FixHistoryProps {
    fixes: FixAttempt[];
}

const OUTCOME_ICON: Record<string, string> = {
    success: "✅",
    failed: "❌",
    escalated: "⬆️ ",
    skipped: "⏭️ ",
};

export function FixHistory({ fixes }: FixHistoryProps) {
    const recent = fixes.slice(-MAX_HISTORY).reverse();

    return (
        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
            <Text bold>Fix History</Text>
            {recent.length === 0 ? (
                <Text dimColor>No fix attempts yet.</Text>
            ) : (
                recent.map((fix, idx) => {
                    const icon = OUTCOME_ICON[fix.outcome] ?? "?";
                    const prKey = `${fix.ref.owner}/${fix.ref.repo}#${fix.ref.number}`;
                    return (
                        <Box key={idx} gap={1}>
                            <Text>{icon}</Text>
                            <Text bold>{prKey}</Text>
                            <Text dimColor>{fix.description}</Text>
                        </Box>
                    );
                })
            )}
        </Box>
    );
}
