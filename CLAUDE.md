# gsd-pr-pilot — Continuation Prompt

## What this is

A GSD extension that monitors GitHub PRs in the background — watching CI checks and review comments, auto-fixing deterministic failures, and escalating everything else to the user. It registers a `/pr-pilot` command.

## What exists

The scaffold is complete and compiles cleanly (`npm run build` — zero errors). Six source modules in `src/`:

| Module | Status | What it does |
|--------|--------|--------------|
| `types.ts` | ✅ Complete | All type definitions, PR refs, events, config, state serialisation (Map↔Object, Set↔Array) |
| `gh.ts` | ✅ Functional, needs refinement | GitHub CLI wrapper — fetches PR snapshots, checks, comments. Classifies comment sources (human/AI/simplify_code). Has `replyToComment` and `isBranchSafe` stubs |
| `differ.ts` | ✅ Complete | Compares two PR snapshots, emits typed `PrEvent[]` for changes (check failures, new comments, approvals, etc.) |
| `classifier.ts` | ✅ Complete | Maps each `PrEvent` → action (fix/escalate/notify/ignore) based on autonomy level and comment source filters |
| `poll.ts` | ✅ Functional | Standalone process entry point. Polls all PRs, diffs, classifies, writes events to `events.jsonl`. Runs as bg_shell watcher. Re-reads state each cycle so the extension can stop it by writing `status: "stopped"` |
| `state.ts` | ✅ Complete | Read/write `monitor-state.json`, append-only `fixes.jsonl`, generates `REPORT.md` |
| `index.ts` | ⚠️ Partial | Registers `/pr-pilot` command with start/stop/status/report. Start initialises state and tells the agent to spawn bg_shell — but the bg_shell spawn path uses `import.meta.url` which needs testing on Windows |

Supporting files:
- `agents/pr-fix.md` — subagent prompt for autonomous fixes (draft, needs refinement when fix loop is built)
- `scripts/install.js` — copies dist/ to `~/.gsd/agent/extensions/pr-pilot/`, writes package.json and extension-manifest.json
- `README.md` — architecture diagram, usage, config reference

## What needs to be built

### Priority 1 — Make the core loop work end-to-end

1. **Event consumer** — The polling loop writes classified events to `.gsd/pr-pilot/events.jsonl`. Nothing reads them yet. Need a mechanism for the main agent (or a spawned agent) to:
   - Read new events from `events.jsonl`
   - For `action: "fix"` events: spawn a fix agent
   - For `action: "escalate"` events: notify the user via GSD notifications
   - For `action: "notify"` events: log/display them
   - Mark events as consumed (either a cursor/offset in state, or move to a processed file)

2. **Fix agent spawning** — When a CI check fails and the classifier says "fix":
   - Determine which repo directory to work in (may need to clone or have the repo locally)
   - Checkout the PR branch
   - Spawn a `pi` process (separate context window) with the `agents/pr-fix.md` prompt
   - Pass it: the error logs (`gh run view --log-failed`), the repo path, the PR ref
   - After the fix agent completes: check if it committed, push to the PR branch
   - Reply to the review comment if applicable (`gh.ts` has `replyToComment`)
   - Record the fix attempt in `fixes.jsonl` via `state.ts`'s `appendFix`

3. **bg_shell integration** — The `/pr-pilot start` command currently sends a `pi.sendUserMessage()` asking the agent to start bg_shell. This is indirect. Better approach: use `pi.exec()` if available, or document that the user/agent needs to run:
   ```
   bg_shell start command:"node <path-to-poll.js> <project-root>" label:"pr-pilot" type:"watcher"
   ```

### Priority 2 — Robustness

4. **Windows path handling** — `import.meta.url` → file path conversion in `index.ts` uses a naive `.replace("file:///", "")`. Test on Windows and fix. Consider using `fileURLToPath` from `node:url`.

5. **`gh pr checks` JSON flag** — The `--json` flag for `gh pr checks` was added in gh CLI 2.40+. Verify this works. Older versions may need `gh api` calls instead.

6. **Comment fetching** — `gh.ts` `fetchComments` uses two different approaches (PR view for issue comments, API for review comments). The `--jq` filter on review comments may not work as written — the `gh api` response shape needs verification against a real PR.

7. **Graceful restart** — If the polling process is killed and restarted, it should pick up from the last `monitor-state.json` without re-processing old events. The state already tracks `processedCommentIds` and `attemptedCheckFixes`, but verify the full restart path works.

### Priority 3 — Polish

8. **GSD notification integration** — Surface escalations and fix results through GSD's notification system (toast notifications on Windows via wmux, terminal notifications otherwise). The preferences system has a `notifications` section.

9. **Configurable settings** — The brief calls for configurable autonomy level and comment filters at start time. Currently hardcoded to defaults. Add flags to the start command or a config wizard.

10. **Fix batching** — Don't push a separate commit for each lint fix. Batch fixes within a single poll cycle into one commit.

11. **Cross-PR awareness** — If monitoring related PRs (e.g., API and desktop), understand that a desktop CI failure might be caused by the API PR not being merged yet.

12. **Tests** — Unit tests for `differ.ts`, `classifier.ts`, and `types.ts` (these are pure functions, easy to test). Integration tests for `gh.ts` would need mocking.

## Architecture decisions already made

- **Polling, not webhooks.** The monitor polls `gh` CLI every 60 seconds. No webhook server needed.
- **Filesystem communication.** The polling loop and the main agent communicate via `.gsd/pr-pilot/` files. No IPC, no sockets.
- **Separate process for polling.** `poll.ts` compiles to `poll.js` and runs as a standalone Node process via bg_shell. It has no LLM — just data fetching and classification.
- **Separate process for fixes.** Fix agents will be spawned as separate `pi` processes with isolated context windows. The main conversation is never blocked.
- **Extension, not core.** This is a GSD extension installed to `~/.gsd/agent/extensions/pr-pilot/`, not part of pi core.
- **`gh` CLI, not GitHub API tokens.** All GitHub interaction goes through `gh` which handles auth. No tokens to manage.

## Key patterns from the codebase

- Comment source classification is in `gh.ts` (`classifyCommentSource`). Known AI bot authors are in `AI_REVIEW_AUTHORS`. "Simplify Code" workflow detection uses regex patterns.
- State uses `Map` and `Set` internally but serialises to plain objects/arrays for JSON persistence. `serialiseState`/`deserialiseState` in `types.ts` handle the conversion.
- The polling loop re-reads state from disk every cycle (`loadState`) so external changes (like the extension writing `status: "stopped"`) take effect without IPC.
- All `gh` CLI calls go through the `gh()` and `ghJson()` helpers in `gh.ts`. They return `null` on any failure — never throw.

## The original brief

The full feature brief is at `.gsd/briefs/pr-monitor-agent.md` in the dosevision project (`C:\Users\Rob\code\dosevision`). It contains the complete requirements, UX examples, architecture options, and pseudocode. Worth reading for the full picture, but the scaffold already incorporates its key decisions.

## Build & test

```bash
npm install
npm run build          # TypeScript → dist/
npm run watch          # dev mode
node scripts/install.js          # install to GSD extensions
node scripts/install.js --status # check install state
```
