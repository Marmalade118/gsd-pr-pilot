/**
 * gsd-pr-pilot — TUI App component (minimal, expanded in T02)
 *
 * Renders the root TUI layout. Uses useMonitorData to get live data.
 * This component is intentionally minimal for T01 — it proves the
 * TSX pipeline compiles and the hook is wired. T02 will expand it.
 */

import { Box, Text } from "ink";
import { useMonitorData } from "./useMonitorData.js";

interface AppProps {
    projectRoot: string;
}

export function App({ projectRoot }: AppProps) {
    const { state, events, fixes, loading } = useMonitorData(projectRoot);

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

    return (
        <Box flexDirection="column">
            <Text bold color="cyan">PR Pilot Monitor</Text>
            <Text>Status: <Text color={state.status === "running" ? "green" : "yellow"}>{state.status}</Text></Text>
            <Text>PRs: {state.config.prs.length}</Text>
            <Text>Events: {events.length}</Text>
            <Text>Fixes: {fixes.length}</Text>
        </Box>
    );
}
