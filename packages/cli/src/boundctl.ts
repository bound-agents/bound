#!/usr/bin/env bun
// Main entry for `boundctl` command
// Handles: boundctl set-hub, boundctl stop, boundctl resume, boundctl restore, boundctl config, boundctl sync-status, boundctl drain

import { runConfigReload } from "./commands/config-reload.js";
import { runDrain } from "./commands/drain.js";
import { runRestore } from "./commands/restore.js";
import { runSetHub } from "./commands/set-hub.js";
import { runResume, runStop } from "./commands/stop-resume.js";
import { runSyncStatus } from "./commands/sync-status.js";

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
		const setHubArgs = {
			hostName,
			wait: args.includes("--wait"),
			timeout: timeoutStr ? Number.parseInt(timeoutStr, 10) : undefined,
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
			configDir: getArgValue(args, "--config-dir") || "data",
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
		const drainArgs = {
			newHub,
			timeout: timeoutStr ? Number.parseInt(timeoutStr, 10) : undefined,
			configDir: getArgValue(args, "--config-dir") || "data",
		};

		try {
			await runDrain(drainArgs);
		} catch (error) {
			console.error("drain failed:", error);
			process.exit(1);
		}
		process.exit(0);
	}

	console.error(`Unknown command: ${command}`);
	console.error('Run "boundctl --help" for usage information');
	process.exit(1);
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
