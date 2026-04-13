#!/usr/bin/env bun
// Main entry for `boundctl` command
// Handles: boundctl set-hub, boundctl stop, boundctl resume, boundctl restore, boundctl config, boundctl sync-status, boundctl drain
import "reflect-metadata";

import { getSiteId } from "@bound/core";
import { runConfigReload } from "./commands/config-reload.js";
import { runDrain } from "./commands/drain.js";
import { runRestore } from "./commands/restore.js";
import { runSetHub } from "./commands/set-hub.js";
import { skillImport, skillList, skillRetire, skillView } from "./commands/skill.js";
import { runResume, runStop } from "./commands/stop-resume.js";
import { runSyncStatus } from "./commands/sync-status.js";
import { openBoundDB } from "./lib/db.js";

function getArgValue(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	return idx !== -1 ? args[idx + 1] : undefined;
}

async function main() {
	const args = process.argv.slice(2);
	const command = args[0];

	if (!command || command === "--help" || command === "-h") {
		console.log(`
boundctl - Bound orchestrator management CLI

USAGE:
  boundctl <command> [options]

COMMANDS:
  set-hub <host-name>       Set the cluster hub host
  stop                       Emergency stop all hosts
  resume                     Resume operations after emergency stop
  restore                    Point-in-time recovery
  config reload <target>     Hot-reload configuration
  sync-status                Show sync status for all peers
  drain <new-hub>            Graceful hub decommissioning
  skill list                 List all skills with status and telemetry
  skill view <name>          View SKILL.md and file listing for a skill
  skill retire <name>        Retire a skill (operator); use --reason "..." to explain
  skill import <path>        Import a skill from a local directory
  --help                     Show this help message

OPTIONS:
  boundctl set-hub <host-name> [--wait] [--timeout <seconds>]
    Set the cluster hub and optionally wait for all peers to confirm

  boundctl stop
    Set emergency stop flag. All hosts halt autonomous operations on next sync.

  boundctl resume
    Clear emergency stop flag. Normal operations resume.

  boundctl restore --before <timestamp> [--preview] [--tables ...]
    Restore to point-in-time state. Use --preview to see changes without executing.

  boundctl config reload <target>
    Hot-reload configuration. Supported targets: mcp

  boundctl sync-status
    Display write propagation status for all peers

  boundctl drain <new-hub> [--timeout <seconds>]
    Gracefully drain current hub and switch to new hub (default timeout: 120s)

EXAMPLES:
  boundctl set-hub primary-host
  boundctl set-hub primary-host --wait
  boundctl stop
  boundctl resume
  boundctl restore --before "2024-01-01T12:00:00Z" --preview
  boundctl config reload mcp
  boundctl sync-status
  boundctl drain new-hub --timeout 180
`);
		process.exit(0);
	}

	if (command === "set-hub") {
		const hostName = args[1];
		if (!hostName) {
			console.error("Error: host-name is required");
			process.exit(1);
		}

		const timeoutStr = getArgValue(args, "--timeout");
		let timeout: number | undefined;
		if (timeoutStr) {
			const parsed = Number.parseInt(timeoutStr, 10);
			if (Number.isNaN(parsed) || parsed <= 0) {
				console.error("Error: --timeout must be a positive integer");
				process.exit(1);
			}
			timeout = parsed;
		}

		const setHubArgs = {
			hostName,
			wait: args.includes("--wait"),
			timeout,
			configDir: getArgValue(args, "--config-dir") || "config",
		};

		try {
			await runSetHub(setHubArgs);
		} catch (error) {
			console.error("set-hub failed:", error);
			process.exit(1);
		}
		process.exit(0);
	}

	if (command === "stop") {
		const stopArgs = {
			configDir: getArgValue(args, "--config-dir") || "config",
		};

		try {
			await runStop(stopArgs);
		} catch (error) {
			console.error("stop failed:", error);
			process.exit(1);
		}
		process.exit(0);
	}

	if (command === "resume") {
		const resumeArgs = {
			configDir: getArgValue(args, "--config-dir") || "config",
		};

		try {
			await runResume(resumeArgs);
		} catch (error) {
			console.error("resume failed:", error);
			process.exit(1);
		}
		process.exit(0);
	}

	if (command === "restore") {
		const beforeIndex = args.indexOf("--before");
		if (beforeIndex === -1) {
			console.error("Error: --before <timestamp> is required");
			process.exit(1);
		}

		const restoreArgs: {
			before: string;
			preview: boolean;
			tables: string[];
			configDir: string;
		} = {
			before: args[beforeIndex + 1],
			preview: args.includes("--preview"),
			tables: [],
			configDir: getArgValue(args, "--config-dir") || "config",
		};

		// Parse --tables if provided
		const tablesIndex = args.indexOf("--tables");
		if (tablesIndex !== -1) {
			restoreArgs.tables = args.slice(tablesIndex + 1).filter((a) => !a.startsWith("--"));
		}

		try {
			await runRestore(restoreArgs);
		} catch (error) {
			console.error("restore failed:", error);
			process.exit(1);
		}
		process.exit(0);
	}

	if (command === "config") {
		const subCommand = args[1];
		if (subCommand !== "reload") {
			console.error("Error: unknown config subcommand. Use 'config reload <target>'");
			process.exit(1);
		}

		const target = args[2];
		if (!target) {
			console.error("Error: target is required. Example: boundctl config reload mcp");
			process.exit(1);
		}

		const configReloadArgs = {
			target,
			configDir: getArgValue(args, "--config-dir") || "config",
		};

		try {
			await runConfigReload(configReloadArgs);
		} catch (error) {
			console.error("config reload failed:", error);
			process.exit(1);
		}
		process.exit(0);
	}

	if (command === "sync-status") {
		const syncStatusArgs = {
			configDir: getArgValue(args, "--config-dir") || "config",
		};

		try {
			await runSyncStatus(syncStatusArgs);
		} catch (error) {
			console.error("sync-status failed:", error);
			process.exit(1);
		}
		process.exit(0);
	}

	if (command === "drain") {
		const newHub = args[1];
		if (!newHub) {
			console.error("Error: new-hub is required");
			process.exit(1);
		}

		const timeoutStr = getArgValue(args, "--timeout");
		let timeout: number | undefined;
		if (timeoutStr) {
			const parsed = Number.parseInt(timeoutStr, 10);
			if (Number.isNaN(parsed) || parsed <= 0) {
				console.error("Error: --timeout must be a positive integer");
				process.exit(1);
			}
			timeout = parsed;
		}

		const drainArgs = {
			newHub,
			timeout,
			configDir: getArgValue(args, "--config-dir") || "config",
		};

		try {
			await runDrain(drainArgs);
		} catch (error) {
			console.error("drain failed:", error);
			process.exit(1);
		}
		process.exit(0);
	}

	if (command === "skill") {
		const subcommand = args[1];
		const dataDir = getArgValue(args, "--data-dir") || "data";
		const db = openBoundDB(dataDir);

		try {
			if (subcommand === "list") {
				const statusFilter = getArgValue(args, "--status");
				const verbose = args.includes("--verbose");
				skillList(db, { status: statusFilter, verbose });
				db.close();
				process.exit(0);
			}

			if (subcommand === "view") {
				const name = args[2];
				if (!name) {
					console.error("Error: skill name is required. Usage: boundctl skill view <name>");
					db.close();
					process.exit(1);
				}
				skillView(db, name);
				db.close();
				process.exit(0);
			}

			if (subcommand === "retire") {
				const name = args[2];
				if (!name) {
					console.error(
						'Error: skill name is required. Usage: boundctl skill retire <name> [--reason "..."]',
					);
					db.close();
					process.exit(1);
				}
				const reason = getArgValue(args, "--reason");
				const siteId = getSiteId(db);
				skillRetire(db, siteId, name, reason);
				db.close();
				process.exit(0);
			}

			if (subcommand === "import") {
				const localPath = args[2];
				if (!localPath) {
					console.error("Error: path is required. Usage: boundctl skill import <path>");
					db.close();
					process.exit(1);
				}
				const siteId = getSiteId(db);
				skillImport(db, siteId, localPath);
				db.close();
				process.exit(0);
			}

			// Unknown subcommand
			console.error(`Error: unknown skill subcommand '${subcommand}'.`);
			console.error("Available: list, view, retire, import");
			db.close();
			process.exit(1);
		} catch (error) {
			console.error("skill command failed:", error);
			db.close();
			process.exit(1);
		}
	}

	console.error(`Unknown command: ${command}`);
	console.error('Run "boundctl --help" for usage information');
	process.exit(1);
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
