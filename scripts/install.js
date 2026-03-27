#!/usr/bin/env node

/**
 * gsd-pr-pilot install script
 *
 * Copies the compiled extension into the GSD extensions directory so
 * pi can load it on startup.
 *
 * Usage:
 *   npx gsd-pr-pilot            # install (or update)
 *   npx gsd-pr-pilot --status   # check what's installed
 *   npx gsd-pr-pilot --remove   # remove the extension
 */

import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgRoot = join(__dirname, "..");

const gsdHome = process.env.GSD_HOME || join(homedir(), ".gsd");
const extensionsDir = join(gsdHome, "agent", "extensions");
const targetDir = join(extensionsDir, "pr-pilot");
const MARKER = "// gsd-pr-pilot";

// ── Helpers ────────────────────────────────────────────────────────

function log(msg) {
    console.log(`  gsd-pr-pilot: ${msg}`);
}

function readPkgVersion() {
    try {
        const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));
        return pkg.version ?? "0.0.0";
    } catch {
        return "0.0.0";
    }
}

function isInstalled() {
    return existsSync(join(targetDir, "index.js"));
}

function installedVersion() {
    const pkgPath = join(targetDir, "package.json");
    if (!existsSync(pkgPath)) return null;
    try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        return pkg._pr_pilot_version ?? null;
    } catch {
        return null;
    }
}

// ── Install ────────────────────────────────────────────────────────

function install() {
    const version = readPkgVersion();
    log(`Installing gsd-pr-pilot v${version}...\n`);

    const distDir = join(pkgRoot, "dist");
    if (!existsSync(distDir)) {
        console.error("  ERROR: dist/ not found. Run `npm run build` first.");
        process.exit(1);
    }

    // Copy compiled dist files
    mkdirSync(targetDir, { recursive: true });
    cpSync(distDir, targetDir, { recursive: true, force: true });

    // Copy agent definitions
    const agentsSource = join(pkgRoot, "agents");
    if (existsSync(agentsSource)) {
        const agentsTarget = join(targetDir, "agents");
        cpSync(agentsSource, agentsTarget, { recursive: true, force: true });
    }

    // Write package.json marker
    const pkgJson = JSON.stringify({
        name: "@gsd/pr-pilot",
        private: true,
        type: "module",
        description: "gsd-pr-pilot — Background PR monitor for GSD/pi",
        _pr_pilot_version: version,
        pi: {
            extensions: ["./index.js"],
        },
    }, null, 2) + "\n";
    writeFileSync(join(targetDir, "package.json"), pkgJson);

    // Write extension manifest
    const manifest = JSON.stringify({
        id: "pr-pilot",
        name: "PR Pilot",
        version,
        description: "Background PR monitor — watches CI checks and review comments, auto-fixes deterministic failures, escalates the rest",
        tier: "user",
        requires: { platform: ">=2.29.0" },
        provides: {
            commands: ["pr-pilot"],
        },
    }, null, 2) + "\n";
    writeFileSync(join(targetDir, "extension-manifest.json"), manifest);

    log(`Installed to: ${targetDir}`);
    log("");
    log("✓ Installation complete. Restart pi to load the extension.");
    log("");
    log("  Usage:");
    log("    /pr-pilot start owner/repo#1 owner/repo#2");
    log("    /pr-pilot status");
    log("    /pr-pilot stop");
}

// ── Remove ─────────────────────────────────────────────────────────

function remove() {
    if (!isInstalled()) {
        log("Not installed — nothing to remove.");
        return;
    }

    rmSync(targetDir, { recursive: true, force: true });
    log("✓ Removed gsd-pr-pilot extension.");
}

// ── Status ─────────────────────────────────────────────────────────

function status() {
    const installed = isInstalled();
    const version = installedVersion();

    console.log(`gsd-pr-pilot: ${installed ? "installed" : "not installed"}`);
    console.log(`  Extension dir: ${targetDir}`);
    if (installed) {
        console.log(`  Version: ${version ?? "unknown"}`);
    }
    console.log(`  Package version: ${readPkgVersion()}`);
}

// ── CLI ────────────────────────────────────────────────────────────

const arg = process.argv[2];
if (arg === "--remove" || arg === "remove") {
    remove();
} else if (arg === "--status" || arg === "status") {
    status();
} else {
    install();
}
