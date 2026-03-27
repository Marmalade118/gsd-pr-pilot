# gsd-pr-pilot

Background PR monitor for [GSD/pi](https://github.com/gsd-build/pi) — watches CI checks and review comments, auto-fixes deterministic failures, escalates the rest.

## What it does

After you create pull requests (manually or via GSD's milestone completion hook), PR Pilot monitors them in the background:

- **Polls** GitHub PRs for CI check status and new review comments
- **Auto-fixes** deterministic failures (lint errors, formatting, missing imports)
- **Escalates** issues that need judgment (architectural feedback, test failures, conflicting reviews)
- **Reports** what happened when monitoring ends

## Install

```bash
npm install -g gsd-pr-pilot
gsd-pr-pilot              # or: npx gsd-pr-pilot
```

Restart pi to load the extension.

## Usage

```bash
# Start monitoring PRs
/pr-pilot start owner/repo#1 owner/repo#2

# Shorthand — bare PR refs also start monitoring
/pr-pilot owner/repo#1 owner/repo#2

# Check status
/pr-pilot status

# Stop monitoring and generate report
/pr-pilot stop

# Generate report without stopping
/pr-pilot report
```

## How it works

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  /pr-pilot   │────▶│  poll.js     │────▶│  .gsd/      │
│  (command)   │     │  (bg_shell)  │     │  pr-pilot/  │
└─────────────┘     └──────┬───────┘     └──────┬──────┘
                           │                     │
                    polls gh CLI            writes state
                    every 60s              & events.jsonl
                           │                     │
                           ▼                     ▼
                    ┌──────────────┐     ┌─────────────┐
                    │  GitHub API  │     │  pi agent   │
                    │  (via gh)   │     │  reads &    │
                    └──────────────┘     │  acts       │
                                        └─────────────┘
```

1. `/pr-pilot start` initialises monitor state and spawns a background polling process
2. The poller runs `gh pr checks` and `gh pr view` every 60 seconds
3. Changes are diffed against the last known state
4. Events are classified: fix (autonomous), escalate (needs user), or notify (informational)
5. Events are written to `events.jsonl` for the main agent to consume
6. For autonomous fixes, a separate pi process is spawned with a focused fix prompt

## Configuration

### Autonomy levels

| Level | Behaviour |
|-------|-----------|
| `fix` (default) | Fix deterministic issues, escalate the rest |
| `ask` | Ask before every change |
| `notify` | Notify only, never change anything |

### Comment source filters

| Source | Default | Description |
|--------|---------|-------------|
| `ci_checks` | ✅ enabled | CI build/test/lint failures |
| `human_reviews` | ✅ enabled | Comments from human reviewers |
| `ai_reviews` | ❌ disabled | Comments from AI review bots |
| `simplify_code` | ❌ disabled | "Simplify Code" workflow suggestions |

## State files

All state lives in `.gsd/pr-pilot/` within your project:

| File | Purpose |
|------|---------|
| `monitor-state.json` | Current monitor config and per-PR tracking state |
| `events.jsonl` | Append-only log of classified events (trigger file) |
| `fixes.jsonl` | Append-only log of fix attempts and outcomes |
| `REPORT.md` | Summary report generated on stop |

## Prerequisites

- [GSD/pi](https://github.com/gsd-build/pi) installed
- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
- Node.js ≥ 18

## Development

```bash
git clone https://github.com/gsd-build/gsd-pr-pilot.git
cd gsd-pr-pilot
npm install
npm run build
node scripts/install.js     # install your local build
```

Watch mode:

```bash
npm run watch               # recompiles on save
node scripts/install.js     # re-install after changes
```

## Project structure

```
gsd-pr-pilot/
├── src/
│   ├── index.ts        # Extension entry point, /pr-pilot command
│   ├── types.ts        # All TypeScript types and serialisation
│   ├── gh.ts           # GitHub CLI integration (all gh calls)
│   ├── poll.ts         # Background polling loop (standalone process)
│   ├── differ.ts       # Snapshot diffing — what changed since last poll
│   ├── classifier.ts   # Event classification — fix vs escalate vs notify
│   └── state.ts        # State persistence (.gsd/pr-pilot/)
├── agents/
│   └── pr-fix.md       # Subagent prompt for autonomous fixes
├── scripts/
│   └── install.js      # CLI installer (npx gsd-pr-pilot)
└── dist/               # Compiled output
```

## License

MIT
