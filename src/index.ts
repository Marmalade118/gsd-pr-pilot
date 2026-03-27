/**
 * gsd-pr-pilot — Extension Entry Point
 *
 * Registers the /pr-pilot command with GSD. This is the file that gets
 * copied into ~/.gsd/agent/extensions/pr-pilot/ by the install script.
 *
 * The extension does NOT run the polling loop itself — it spawns a
 * background process (poll.ts compiled to poll.js) and communicates
 * via the filesystem (.gsd/pr-pilot/).
 */

import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import type {
    MonitorState, PrRef, PrTrackingState, MonitorConfig,
} from "./types.js";
import {
    parsePrRef, formatPrRef,
    DEFAULT_MONITOR_CONFIG, DEFAULT_COMMENT_FILTER,
} from "./types.js";
import { loadState, saveState, ensureStateDir, writeReport } from "./state.js";
import { isGhAvailable } from "./gh.js";

// ── Module-level path resolution (Windows-safe via fileURLToPath) ──

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pollScript = join(__dirname, "poll.js");
const tuiScript = join(__dirname, "tui.js");

// ── Extension registration ─────────────────────────────────────────

// The pi extension API shape (we don't import the type to avoid
// depending on @gsd/pi-coding-agent at runtime)
interface PiExtensionAPI {
    registerCommand(name: string, def: {
        description: string;
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    }): void;
    sendUserMessage(message: string): void;
}

interface ExtensionCommandContext {
    cwd: string;
    ui: {
        notify(message: string, level: "info" | "warning" | "error" | "success"): void;
    };
}

export default function prPilot(pi: PiExtensionAPI): void {
    pi.registerCommand("pr-pilot", {
        description: "Monitor GitHub PRs for CI failures and review comments",
        handler: async (args: string, ctx: ExtensionCommandContext) => {
            const parts = args.trim().split(/\s+/);
            const subcommand = parts[0]?.toLowerCase() ?? "";

            switch (subcommand) {
                case "start":
                    await handleStart(parts.slice(1), ctx);
                    break;
                case "stop":
                    await handleStop(ctx);
                    break;
                case "status":
                    await handleStatus(ctx);
                    break;
                case "report":
                    await handleReport(ctx);
                    break;
                case "":
                case "help":
                    showHelp(ctx);
                    break;
                default: {
                    // Treat bare args as PR refs → start
                    const allRefs = parts.every(p => parsePrRef(p) !== null);
                    if (allRefs) {
                        await handleStart(parts, ctx);
                    } else {
                        ctx.ui.notify(`Unknown subcommand: ${subcommand}. Use /pr-pilot help`, "warning");
                    }
                    break;
                }
            }
        },
    });
}

// ── Subcommands ────────────────────────────────────────────────────

async function handleStart(
    prArgs: string[],
    ctx: ExtensionCommandContext,
): Promise<void> {
    if (!isGhAvailable()) {
        ctx.ui.notify("gh CLI not available or not authenticated. Run `gh auth login` first.", "error");
        return;
    }

    if (prArgs.length === 0) {
        ctx.ui.notify("Usage: /pr-pilot start owner/repo#1 [--repo /path] [owner/repo#2 ...]", "warning");
        return;
    }

    // ── Parse --repo flag ──────────────────────────────────────────
    let repoPath: string | undefined;
    const filteredArgs: string[] = [];
    for (let i = 0; i < prArgs.length; i++) {
        if (prArgs[i] === "--repo" && i + 1 < prArgs.length) {
            repoPath = prArgs[i + 1];
            i++; // skip the path arg
        } else {
            filteredArgs.push(prArgs[i]);
        }
    }

    // Resolve repo path to absolute; default to cwd if omitted
    const resolvedRepo = repoPath
        ? resolve(ctx.cwd, repoPath)
        : ctx.cwd;

    if (repoPath && !existsSync(resolvedRepo)) {
        ctx.ui.notify(
            `Warning: --repo path does not exist: ${resolvedRepo}. Continuing anyway.`,
            "warning",
        );
    }

    // ── Parse PR refs ──────────────────────────────────────────────
    const refs: PrRef[] = [];
    for (const arg of filteredArgs) {
        const ref = parsePrRef(arg);
        if (!ref) {
            ctx.ui.notify(`Invalid PR reference: ${arg}. Expected format: owner/repo#123`, "error");
            return;
        }
        refs.push(ref);
    }

    if (refs.length === 0) {
        ctx.ui.notify("Usage: /pr-pilot start owner/repo#1 [--repo /path] [owner/repo#2 ...]", "warning");
        return;
    }

    // Check for existing monitor
    const existing = loadState(ctx.cwd);
    if (existing && existing.status === "running") {
        ctx.ui.notify(
            `Monitor is already running (${existing.config.prs.length} PRs). Stop it first with /pr-pilot stop`,
            "warning",
        );
        return;
    }

    // ── Build repoMap: each PR key → resolved repo path ───────────
    const repoMap: Record<string, string> = {};
    for (const ref of refs) {
        repoMap[formatPrRef(ref)] = resolvedRepo;
    }

    // ── Initialise state ───────────────────────────────────────────
    const prStates = new Map<string, PrTrackingState>();
    for (const ref of refs) {
        prStates.set(formatPrRef(ref), {
            ref,
            lastSnapshot: null,
            processedCommentIds: new Set(),
            attemptedCheckFixes: new Set(),
            fixes: [],
            consecutiveFailures: 0,
        });
    }

    const state: MonitorState = {
        status: "running",
        config: {
            ...DEFAULT_MONITOR_CONFIG,
            prs: refs,
            repoMap,
        },
        prStates,
        startedAt: new Date().toISOString(),
        lastPollAt: null,
        lastError: null,
        eventCursor: 0,
    };

    saveState(ctx.cwd, state);

    const prList = refs.map(formatPrRef).join(", ");

    // ── Spawn detached watcher process ─────────────────────────────
    try {
        const child = spawn("node", [pollScript, ctx.cwd], {
            detached: true,
            stdio: "ignore",
            cwd: ctx.cwd,
        });

        child.on("error", (err) => {
            console.error(`[pr-pilot] watcher spawn error: ${err.message}`);
        });

        child.unref();

        // ── Attempt wmux split creation (best-effort) ──────────────
        let tuiLaunched = false;
        try {
            const cmuxMod = await import("../cmux/index.js" as string).catch(() => null);
            if (cmuxMod) {
                const CmuxClient: any = cmuxMod.CmuxClient ?? cmuxMod.default?.CmuxClient;
                if (CmuxClient) {
                    const client = CmuxClient.fromPreferences?.();
                    if (client?.canRun?.()) {
                        const splitId = await client.createSplit("right");
                        await client.sendSurface(splitId, `node ${tuiScript} ${ctx.cwd}`);
                        tuiLaunched = true;
                    }
                }
            }
        } catch (wmuxErr) {
            const msg = wmuxErr instanceof Error ? wmuxErr.message : String(wmuxErr);
            console.error(`[pr-pilot] wmux split failed: ${msg}`);
        }

        ctx.ui.notify(
            `PR Pilot: monitoring ${refs.length} PR(s): ${prList}\nRepo path: ${resolvedRepo}\nWatcher started (poll.js detached)${tuiLaunched ? "\nTUI opened in split pane" : ""}`,
            "success",
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        state.status = "error";
        state.lastError = `Failed to spawn watcher: ${message}`;
        saveState(ctx.cwd, state);
        ctx.ui.notify(`PR Pilot: failed to start watcher: ${message}`, "error");
    }
}

async function handleStop(ctx: ExtensionCommandContext): Promise<void> {
    const state = loadState(ctx.cwd);
    if (!state) {
        ctx.ui.notify("No active PR Pilot monitor.", "info");
        return;
    }

    state.status = "stopped";
    saveState(ctx.cwd, state);

    const reportPath = writeReport(ctx.cwd, state);
    ctx.ui.notify(`PR Pilot stopped. Report written to ${reportPath}`, "success");
}

async function handleStatus(ctx: ExtensionCommandContext): Promise<void> {
    const state = loadState(ctx.cwd);
    if (!state) {
        ctx.ui.notify("No active PR Pilot monitor.", "info");
        return;
    }

    const lines: string[] = [
        `PR Pilot: ${state.status}`,
        `  Started: ${state.startedAt}`,
        `  Last poll: ${state.lastPollAt ?? "never"}`,
    ];

    if (state.lastError) {
        lines.push(`  Last error: ${state.lastError}`);
    }

    for (const [key, prState] of state.prStates) {
        const snap = prState.lastSnapshot;
        if (snap) {
            const checks = snap.checksPass ? "✅" : snap.checksFailed ? "❌" : "⏳";
            const review = snap.approved ? "✅" : snap.changesRequested ? "🔄" : "⏳";
            lines.push(`  ${key}: checks=${checks} review=${review} fixes=${prState.fixes.length}`);
        } else {
            lines.push(`  ${key}: not yet polled`);
        }
    }

    ctx.ui.notify(lines.join("\n"), "info");
}

async function handleReport(ctx: ExtensionCommandContext): Promise<void> {
    const state = loadState(ctx.cwd);
    if (!state) {
        ctx.ui.notify("No PR Pilot state found.", "info");
        return;
    }

    const reportPath = writeReport(ctx.cwd, state);
    ctx.ui.notify(`Report written to ${reportPath}`, "success");
}

function showHelp(ctx: ExtensionCommandContext): void {
    ctx.ui.notify(
        [
            "PR Pilot — Background PR Monitor",
            "",
            "Usage:",
            "  /pr-pilot start owner/repo#1 --repo /path    Start with local repo path",
            "  /pr-pilot start owner/repo#1 [owner/repo#2 ...]  Start monitoring",
            "  /pr-pilot stop                                    Stop monitoring",
            "  /pr-pilot status                                  Show current state",
            "  /pr-pilot report                                  Generate summary report",
            "  /pr-pilot help                                    Show this help",
            "",
            "Shorthand:",
            "  /pr-pilot owner/repo#1 owner/repo#2               Same as start",
            "",
            "Options:",
            "  --repo /path    Path to the local repository clone (defaults to cwd)",
        ].join("\n"),
        "info",
    );
}
