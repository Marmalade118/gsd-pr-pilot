/**
 * gsd-pr-pilot — TUI entry point
 *
 * Standalone process that renders the PR Pilot interactive TUI.
 * Launched by the /pr-pilot start command via bg_shell.
 *
 * Usage: node dist/tui.js [projectRoot]
 *
 * Falls back to process.cwd() when projectRoot is not provided.
 */

import { withFullScreen } from "fullscreen-ink";
import { App } from "./tui/App.js";

const projectRoot = process.argv[2] ?? process.cwd();

withFullScreen(<App projectRoot={projectRoot} />).start().catch((err: unknown) => {
    console.error("[pr-pilot] [tui] fatal:", err);
    process.exit(1);
});
