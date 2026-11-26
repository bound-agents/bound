#!/usr/bin/env bun
// Implementation of the `boundctl` command; boundctl.ts is the binary entry
// point. Arguments are parsed by Stricli: one route per command, nested route
// maps for the `config`/`skill`/`webhook`/`task`/`db` families.

import type { Database } from "bun:sqlite";
import { getSiteId } from "@bound/core";
import { buildApplication, buildCommand, buildRouteMap } from "@stricli/core";
import { runConfigReload } from "./commands/config-reload.js";
import { runConsistencyCheck } from "./commands/consistency-check.js";
import { runDrain } from "./commands/drain.js";
import { runRestore } from "./commands/restore.js";
import { runSetHub } from "./commands/set-hub.js";
import { runSetPersona } from "./commands/set-persona.js";
import { skillDelete, skillImport, skillList, skillView } from "./commands/skill.js";
import { runResume, runStop } from "./commands/stop-resume.js";
import { runSyncStatus } from "./commands/sync-status.js";
import { type TaskUpdateOptions, taskUpdate } from "./commands/task.js";
import {
	type WebhookCreateOptions,
	type WebhookUpdateOptions,
	webhookCreate,
	webhookDelete,
	webhookList,
	webhookRotateSecret,
	webhookSetUnauthenticated,
	webhookUpdate,
} from "./commands/webhook.js";
import {
	type CliContext,
	type CliIO,
	booleanFlag,
	defaultCliIO,
	defaultedStringFlag,
	errorMessage,
	exitWith,
	optionalBooleanFlag,
	optionalPositional,
	restPositionals,
	runCliApp,
	stringFlag,
	unknownCommandText,
} from "./lib/cli-app.js";
import { openBoundDB } from "./lib/db.js";

export { type CliIO, defaultCliIO } from "./lib/cli-app.js";

const ROOT_HELP = `
boundctl - Bound orchestrator management CLI

USAGE:
  boundctl <command> [options]
  boundctl <command> --help  Show the flags for one command or command family

COMMANDS:
  set-hub <host-name>       Set the cluster hub host
  set-persona [--file <path>]  Set the cluster-wide operator persona (stdin if no --file)
  stop                       Emergency stop all hosts
  resume                     Resume operations after emergency stop
  restore                    Point-in-time recovery
  config reload <target>     Hot-reload configuration
  sync-status                Show sync status for all peers
  consistency-check          Compare local DB against hub via sync protocol
  drain <new-hub>            Graceful hub decommissioning
  skill list                 List all skills with usage telemetry
  skill view <name>          View SKILL.md and file listing for a skill
  skill delete <name>        Delete a skill; use --reason "..." to explain
  skill import <path>        Import a skill from a local directory
  webhook list               List all webhooks
  webhook create             Create a new webhook
  webhook delete <name>      Delete a webhook
  webhook update             Update a webhook (--name, --prompt, --description, --format)
  webhook rotate-secret <name>  Rotate webhook secret
  task update <id>           Update a task's history, model, or alert threshold
  db vacuum                  Run VACUUM to reclaim disk space
  --help                     Show this help message

OPTIONS:
  boundctl set-hub <host-name> [--wait] [--timeout <seconds>]
    Set the cluster hub and optionally wait for all peers to confirm

  boundctl set-persona [--file <path>]
    Set the cluster-wide operator persona. Reads from <path> with --file, or
    from stdin otherwise. Stored as a single synced cluster_config row, read
    live at assembly time, so it propagates to every host and takes effect on
    the next turn. Capped at 64 KB.

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

  boundctl consistency-check [--spoke-url <url>] [--tables <t1,t2,...>] [--verbose]
    Compare synced table row sets between local spoke and remote hub.

  boundctl drain <new-hub> [--timeout <seconds>]
    Gracefully drain current hub and switch to new hub (default timeout: 120s)

  boundctl db vacuum
    Run a full VACUUM to reclaim disk space immediately

EXAMPLES:
  boundctl set-hub primary-host
  boundctl set-hub primary-host --wait
  boundctl set-persona --file my-persona.md
  cat my-persona.md | boundctl set-persona
  boundctl stop
  boundctl resume
  boundctl restore --before "2024-01-01T12:00:00Z" --preview
  boundctl config reload mcp
  boundctl sync-status
  boundctl drain new-hub --timeout 180
  boundctl db vacuum
`;

interface ConfigDirFlags {
	readonly configDir: string;
}
interface DataDirFlags {
	readonly dataDir: string;
}

const configDirFlag = defaultedStringFlag("Config directory", "config", "dir");
const dataDirFlag = defaultedStringFlag("Data directory holding bound.db", "data", "dir");

/** Runs `body`, mapping a throw to `<label> failed: <message>` and exit 1. */
async function guarded(
	io: CliIO,
	label: string,
	body: () => Promise<void> | void,
): Promise<number> {
	try {
		await body();
		return 0;
	} catch (error) {
		io.error(`${label} failed: ${errorMessage(error)}`);
		return 1;
	}
}

/**
 * Opens bound.db under `dataDir`, runs `body`, and always closes the handle. A
 * throw maps to `<label> failed: <message>` and exit 1.
 */
async function withDb(
	io: CliIO,
	dataDir: string,
	label: string,
	body: (db: Database) => Promise<number> | number,
): Promise<number> {
	const db = openBoundDB(dataDir);
	try {
		return await body(db);
	} catch (error) {
		io.error(`${label} failed: ${errorMessage(error)}`);
		return 1;
	} finally {
		db.close();
	}
}

/** Parses an optional `--timeout` value; undefined when absent, null when invalid. */
function parseTimeout(raw: string | undefined): number | undefined | null {
	if (!raw) return undefined;
	const parsed = Number.parseInt(raw, 10);
	return Number.isNaN(parsed) || parsed <= 0 ? null : parsed;
}

/**
 * Catch-all for a command family: registered as the route map's hidden
 * default command, so an unknown or missing subcommand reaches it (with the
 * unmatched word as a positional) and prints the family's own usage error.
 */
function unknownSubcommand(
	flags: Record<string, ReturnType<typeof defaultedStringFlag>>,
	report: (io: CliIO, input: string | undefined) => void,
) {
	return buildCommand({
		docs: { brief: "Unknown subcommand" },
		parameters: { flags, positional: restPositionals("input", "Unrecognized subcommand") },
		func(this: CliContext, _flags: Record<string, string>, ...input: string[]) {
			report(this.io, input[0]);
			exitWith(this, 1);
		},
	});
}

const UNKNOWN_ROUTE = "unknown-subcommand";
const HIDE_UNKNOWN = { [UNKNOWN_ROUTE]: true } as const;

// ---------------------------------------------------------------------------
// Cluster commands
// ---------------------------------------------------------------------------

const setHubCommand = buildCommand({
	docs: { brief: "Set the cluster hub host" },
	parameters: {
		flags: {
			wait: booleanFlag("Wait for all peers to confirm the new hub"),
			timeout: stringFlag("Seconds to wait with --wait", "seconds"),
			configDir: configDirFlag,
		},
		positional: optionalPositional("host-name", "Host to make the hub"),
	},
	async func(
		this: CliContext,
		flags: { wait: boolean; timeout?: string; configDir: string },
		hostName?: string,
	) {
		if (!hostName) {
			this.io.error("Error: host-name is required");
			return exitWith(this, 1);
		}
		const timeout = parseTimeout(flags.timeout);
		if (timeout === null) {
			this.io.error("Error: --timeout must be a positive integer");
			return exitWith(this, 1);
		}
		const args = { hostName, wait: flags.wait, timeout, configDir: flags.configDir };
		exitWith(this, await guarded(this.io, "set-hub", () => runSetHub(args)));
	},
});

const setPersonaCommand = buildCommand({
	docs: { brief: "Set the cluster-wide operator persona (stdin if no --file)" },
	parameters: {
		flags: {
			file: stringFlag("Read the persona from this file", "path"),
			configDir: configDirFlag,
		},
	},
	async func(this: CliContext, flags: { file?: string; configDir: string }) {
		exitWith(this, await guarded(this.io, "set-persona", () => runSetPersona(flags)));
	},
});

const stopCommand = buildCommand({
	docs: { brief: "Emergency stop all hosts" },
	parameters: { flags: { configDir: configDirFlag } },
	async func(this: CliContext, flags: ConfigDirFlags) {
		exitWith(this, await guarded(this.io, "stop", () => runStop(flags)));
	},
});

const resumeCommand = buildCommand({
	docs: { brief: "Resume operations after emergency stop" },
	parameters: { flags: { configDir: configDirFlag } },
	async func(this: CliContext, flags: ConfigDirFlags) {
		exitWith(this, await guarded(this.io, "resume", () => runResume(flags)));
	},
});

const restoreCommand = buildCommand({
	docs: { brief: "Point-in-time recovery" },
	parameters: {
		flags: {
			before: stringFlag("Restore to the state before this timestamp", "timestamp"),
			preview: booleanFlag("Show the changes without executing"),
			tables: {
				kind: "parsed",
				parse: String,
				brief: "Limit the restore to these tables",
				optional: true,
				variadic: true,
				placeholder: "table",
			},
			configDir: configDirFlag,
		},
		positional: restPositionals("table", "Further tables for --tables"),
	},
	async func(
		this: CliContext,
		flags: { before?: string; preview: boolean; tables?: string[]; configDir: string },
		...moreTables: string[]
	) {
		if (flags.before === undefined) {
			this.io.error("Error: --before <timestamp> is required");
			return exitWith(this, 1);
		}
		// `--tables a b c`: Stricli binds `a` to the flag and the rest as
		// positionals; both belong to the table list.
		const tables = flags.tables ? [...flags.tables, ...moreTables] : [];
		const args = {
			before: flags.before,
			preview: flags.preview,
			tables,
			configDir: flags.configDir,
		};
		exitWith(this, await guarded(this.io, "restore", () => runRestore(args)));
	},
});

const configRoutes = buildRouteMap({
	docs: { brief: "Hot-reload configuration", hideRoute: HIDE_UNKNOWN },
	defaultCommand: UNKNOWN_ROUTE,
	routes: {
		reload: buildCommand({
			docs: { brief: "Hot-reload configuration. Supported targets: mcp" },
			parameters: {
				flags: { configDir: configDirFlag },
				positional: optionalPositional("target", "Configuration to reload (mcp)"),
			},
			async func(this: CliContext, flags: ConfigDirFlags, target?: string) {
				if (!target) {
					this.io.error("Error: target is required. Example: boundctl config reload mcp");
					return exitWith(this, 1);
				}
				const args = { target, configDir: flags.configDir };
				exitWith(this, await guarded(this.io, "config reload", () => runConfigReload(args)));
			},
		}),
		[UNKNOWN_ROUTE]: unknownSubcommand({ configDir: configDirFlag }, (io) => {
			io.error("Error: unknown config subcommand. Use 'config reload <target>'");
		}),
	},
});

const syncStatusCommand = buildCommand({
	docs: { brief: "Show sync status for all peers" },
	parameters: { flags: { configDir: configDirFlag } },
	async func(this: CliContext, flags: ConfigDirFlags) {
		exitWith(this, await guarded(this.io, "sync-status", () => runSyncStatus(flags)));
	},
});

const consistencyCheckCommand = buildCommand({
	docs: { brief: "Compare local DB against hub via sync protocol" },
	parameters: {
		flags: {
			spokeUrl: stringFlag("Spoke URL (default http://localhost:3001)", "url"),
			tables: stringFlag("Comma-separated tables to compare", "t1,t2"),
			verbose: booleanFlag("Print per-row differences"),
		},
	},
	async func(this: CliContext, flags: { spokeUrl?: string; tables?: string; verbose: boolean }) {
		exitWith(this, await guarded(this.io, "consistency-check", () => runConsistencyCheck(flags)));
	},
});

const drainCommand = buildCommand({
	docs: { brief: "Graceful hub decommissioning" },
	parameters: {
		flags: {
			timeout: stringFlag("Seconds to wait for the drain (default 120)", "seconds"),
			configDir: configDirFlag,
		},
		positional: optionalPositional("new-hub", "Host to switch the hub to"),
	},
	async func(this: CliContext, flags: { timeout?: string; configDir: string }, newHub?: string) {
		if (!newHub) {
			this.io.error("Error: new-hub is required");
			return exitWith(this, 1);
		}
		const timeout = parseTimeout(flags.timeout);
		if (timeout === null) {
			this.io.error("Error: --timeout must be a positive integer");
			return exitWith(this, 1);
		}
		const args = { newHub, timeout, configDir: flags.configDir };
		exitWith(this, await guarded(this.io, "drain", () => runDrain(args)));
	},
});

// ---------------------------------------------------------------------------
// skill
// ---------------------------------------------------------------------------

const skillRoutes = buildRouteMap({
	docs: { brief: "Manage skills", hideRoute: HIDE_UNKNOWN },
	defaultCommand: UNKNOWN_ROUTE,
	routes: {
		list: buildCommand({
			docs: { brief: "List all skills with usage telemetry" },
			parameters: {
				flags: { verbose: booleanFlag("Show full telemetry"), dataDir: dataDirFlag },
			},
			async func(this: CliContext, flags: { verbose: boolean; dataDir: string }) {
				const code = await withDb(this.io, flags.dataDir, "skill command", (db) => {
					skillList(db, { verbose: flags.verbose });
					return 0;
				});
				exitWith(this, code);
			},
		}),
		view: buildCommand({
			docs: { brief: "View SKILL.md and file listing for a skill" },
			parameters: {
				flags: { dataDir: dataDirFlag },
				positional: optionalPositional("name", "Skill name"),
			},
			async func(this: CliContext, flags: DataDirFlags, name?: string) {
				if (!name) {
					this.io.error("Error: skill name is required. Usage: boundctl skill view <name>");
					return exitWith(this, 1);
				}
				const code = await withDb(this.io, flags.dataDir, "skill command", (db) => {
					skillView(db, name);
					return 0;
				});
				exitWith(this, code);
			},
		}),
		delete: buildCommand({
			docs: { brief: "Delete a skill" },
			parameters: {
				flags: { reason: stringFlag("Why the skill is deleted", "text"), dataDir: dataDirFlag },
				positional: optionalPositional("name", "Skill name"),
			},
			async func(this: CliContext, flags: { reason?: string; dataDir: string }, name?: string) {
				if (!name) {
					this.io.error(
						'Error: skill name is required. Usage: boundctl skill delete <name> [--reason "..."]',
					);
					return exitWith(this, 1);
				}
				const code = await withDb(this.io, flags.dataDir, "skill command", (db) => {
					skillDelete(db, getSiteId(db), name, flags.reason);
					return 0;
				});
				exitWith(this, code);
			},
		}),
		import: buildCommand({
			docs: { brief: "Import a skill from a local directory" },
			parameters: {
				flags: { dataDir: dataDirFlag },
				positional: optionalPositional("path", "Skill directory"),
			},
			async func(this: CliContext, flags: DataDirFlags, localPath?: string) {
				if (!localPath) {
					this.io.error("Error: path is required. Usage: boundctl skill import <path>");
					return exitWith(this, 1);
				}
				const code = await withDb(this.io, flags.dataDir, "skill command", async (db) => {
					await skillImport(db, getSiteId(db), localPath);
					return 0;
				});
				exitWith(this, code);
			},
		}),
		[UNKNOWN_ROUTE]: unknownSubcommand({ dataDir: dataDirFlag }, (io, input) => {
			io.error(`Error: unknown skill subcommand '${input ?? ""}'.`);
			io.error("Available: list, view, delete, import");
		}),
	},
});

// ---------------------------------------------------------------------------
// webhook
// ---------------------------------------------------------------------------

const WEBHOOK_USAGE =
	"Usage: boundctl webhook {create|list|delete|update|rotate-secret|allow-unauthenticated|disallow-unauthenticated}";

const webhookModelFlag = stringFlag(
	'Model for the webhook task; --model "" restores the default',
	"id",
);

/** A webhook subcommand that only needs the DB and its site id. */
function webhookDbCommand(brief: string, body: (db: Database, siteId: string) => void) {
	return buildCommand({
		docs: { brief },
		parameters: { flags: { dataDir: dataDirFlag } },
		async func(this: CliContext, flags: DataDirFlags) {
			const code = await withDb(this.io, flags.dataDir, "webhook command", (db) => {
				body(db, getSiteId(db));
				return 0;
			});
			exitWith(this, code);
		},
	});
}

/** A webhook subcommand addressed by a positional `<name>`. */
function webhookNamedCommand(
	brief: string,
	usage: string,
	body: (db: Database, siteId: string, name: string) => void,
) {
	return buildCommand({
		docs: { brief },
		parameters: {
			flags: { dataDir: dataDirFlag },
			positional: optionalPositional("name", "Webhook name"),
		},
		async func(this: CliContext, flags: DataDirFlags, name?: string) {
			if (!name) {
				this.io.error(usage);
				return exitWith(this, 1);
			}
			const code = await withDb(this.io, flags.dataDir, "webhook command", (db) => {
				body(db, getSiteId(db), name);
				return 0;
			});
			exitWith(this, code);
		},
	});
}

const webhookRoutes = buildRouteMap({
	docs: { brief: "Manage webhooks", hideRoute: HIDE_UNKNOWN },
	defaultCommand: UNKNOWN_ROUTE,
	routes: {
		create: buildCommand({
			docs: { brief: "Create a new webhook" },
			parameters: {
				flags: {
					name: stringFlag("Webhook name (lowercase, digits, _ and -)", "name"),
					format: stringFlag("Signature format: github|stripe|slack|raw|none", "format"),
					description: stringFlag("Description", "text"),
					prompt: stringFlag("System prompt addition for the webhook task", "text"),
					model: webhookModelFlag,
					noHistory: optionalBooleanFlag("Run each delivery with a clean context window"),
					dataDir: dataDirFlag,
				},
			},
			async func(this: CliContext, { dataDir, ...options }: WebhookCreateOptions & DataDirFlags) {
				const code = await withDb(this.io, dataDir, "webhook command", (db) => {
					webhookCreate(db, getSiteId(db), options);
					return 0;
				});
				exitWith(this, code);
			},
		}),
		list: webhookDbCommand("List all webhooks", (db) => webhookList(db)),
		delete: webhookNamedCommand(
			"Delete a webhook",
			"Usage: boundctl webhook delete <name>",
			webhookDelete,
		),
		update: buildCommand({
			docs: { brief: "Update a webhook" },
			parameters: {
				flags: {
					name: stringFlag("Webhook to update", "name"),
					prompt: stringFlag("New system prompt addition", "text"),
					description: stringFlag('New description; --description "" clears it', "text"),
					format: stringFlag("New signature format", "format"),
					model: webhookModelFlag,
					noHistory: optionalBooleanFlag("Disable history for future deliveries"),
					history: optionalBooleanFlag("Re-enable history for future deliveries"),
					dataDir: dataDirFlag,
				},
			},
			async func(this: CliContext, { dataDir, ...options }: WebhookUpdateOptions & DataDirFlags) {
				const code = await withDb(this.io, dataDir, "webhook command", (db) => {
					webhookUpdate(db, getSiteId(db), options);
					return 0;
				});
				exitWith(this, code);
			},
		}),
		"rotate-secret": webhookNamedCommand(
			"Rotate webhook secret",
			"Usage: boundctl webhook rotate-secret <name>",
			webhookRotateSecret,
		),
		"allow-unauthenticated": webhookDbCommand(
			"Allow --format none webhooks cluster-wide",
			(db, siteId) => webhookSetUnauthenticated(db, siteId, true),
		),
		"disallow-unauthenticated": webhookDbCommand(
			"Disallow --format none webhooks cluster-wide (default)",
			(db, siteId) => webhookSetUnauthenticated(db, siteId, false),
		),
		[UNKNOWN_ROUTE]: unknownSubcommand({ dataDir: dataDirFlag }, (io) => {
			io.error(WEBHOOK_USAGE);
		}),
	},
});

// ---------------------------------------------------------------------------
// task
// ---------------------------------------------------------------------------

const taskRoutes = buildRouteMap({
	docs: { brief: "Change settings on scheduled tasks", hideRoute: HIDE_UNKNOWN },
	defaultCommand: UNKNOWN_ROUTE,
	routes: {
		update: buildCommand({
			docs: { brief: "Update a task's history, model, or alert threshold" },
			parameters: {
				flags: {
					id: stringFlag("Task id (alternative to the positional)", "id"),
					noHistory: optionalBooleanFlag("Disable history"),
					history: optionalBooleanFlag("Re-enable history"),
					model: stringFlag('Model hint; --model "" restores the default', "id"),
					alertThreshold: stringFlag("Consecutive failures before an advisory (> 0)", "n"),
					dataDir: dataDirFlag,
				},
				positional: optionalPositional("id", "Task id"),
			},
			async func(
				this: CliContext,
				{ dataDir, id, ...options }: TaskUpdateOptions & DataDirFlags,
				positionalId?: string,
			) {
				const code = await withDb(this.io, dataDir, "task command", (db) => {
					taskUpdate(db, getSiteId(db), { id: id ?? positionalId, ...options });
					return 0;
				});
				exitWith(this, code);
			},
		}),
		[UNKNOWN_ROUTE]: unknownSubcommand({ dataDir: dataDirFlag }, (io) => {
			io.error(
				"Usage: boundctl task update <id> [--no-history|--history] [--model <id>] [--alert-threshold <n>]",
			);
		}),
	},
});

// ---------------------------------------------------------------------------
// db
// ---------------------------------------------------------------------------

function vacuum(io: CliIO, db: Database): void {
	io.log("Running VACUUM...");
	// Raw read justification: PRAGMA page_count reads SQLite file metadata.
	const before = db.query("PRAGMA page_count").get() as { page_count: number };
	// Raw read justification: PRAGMA freelist_count reads SQLite file metadata.
	const freeListBefore = db.query("PRAGMA freelist_count").get() as {
		freelist_count: number;
	};
	db.run("VACUUM");
	// Raw read justification: PRAGMA page_count reads SQLite file metadata.
	const after = db.query("PRAGMA page_count").get() as { page_count: number };
	// Raw read justification: PRAGMA page_size reads SQLite file metadata.
	const pageSize = (db.query("PRAGMA page_size").get() as { page_size: number }).page_size;
	const reclaimedPages = before.page_count - after.page_count;
	const reclaimedBytes = reclaimedPages * pageSize;
	io.log("VACUUM complete.");
	io.log(`  Pages before: ${before.page_count} (${freeListBefore.freelist_count} free)`);
	io.log(`  Pages after:  ${after.page_count}`);
	io.log(
		`  Reclaimed:    ${reclaimedPages} pages (${(reclaimedBytes / 1024 / 1024).toFixed(1)}MB)`,
	);
}

const dbRoutes = buildRouteMap({
	docs: { brief: "Database maintenance", hideRoute: HIDE_UNKNOWN },
	defaultCommand: UNKNOWN_ROUTE,
	routes: {
		vacuum: buildCommand({
			docs: { brief: "Run VACUUM to reclaim disk space" },
			parameters: { flags: { dataDir: dataDirFlag } },
			async func(this: CliContext, flags: DataDirFlags) {
				const code = await withDb(this.io, flags.dataDir, "VACUUM", (db) => {
					vacuum(this.io, db);
					return 0;
				});
				exitWith(this, code);
			},
		}),
		[UNKNOWN_ROUTE]: unknownSubcommand({ dataDir: dataDirFlag }, (io, input) => {
			io.error(`Unknown db subcommand: ${input}`);
			io.error("Available: vacuum");
		}),
	},
});

const app = buildApplication<CliContext>(
	buildRouteMap({
		docs: { brief: "Bound orchestrator management CLI" },
		routes: {
			"set-hub": setHubCommand,
			"set-persona": setPersonaCommand,
			stop: stopCommand,
			resume: resumeCommand,
			restore: restoreCommand,
			config: configRoutes,
			"sync-status": syncStatusCommand,
			"consistency-check": consistencyCheckCommand,
			drain: drainCommand,
			skill: skillRoutes,
			webhook: webhookRoutes,
			task: taskRoutes,
			db: dbRoutes,
		},
	}),
	{
		name: "boundctl",
		scanner: { caseStyle: "allow-kebab-for-camel" },
		documentation: { caseStyle: "convert-camel-to-kebab" },
		localization: unknownCommandText("boundctl"),
	},
);

/**
 * Real `boundctl` entry point. Parses argv (WITHOUT the leading `node`/`bun` +
 * script path — pass `process.argv.slice(2)`), dispatches to the matching
 * command, and RETURNS an exit code instead of calling `process.exit` inside
 * the tested path. The thin {@link boundctl.ts} launcher maps the return to
 * `process.exit`. The bare / `--help` / `-h` overview is the curated text
 * above; `boundctl <command> --help` is generated from the command definition.
 */
export async function main(args: string[], io: CliIO = defaultCliIO()): Promise<number> {
	const command = args[0];
	if (!command || command === "--help" || command === "-h") {
		io.log(ROOT_HELP);
		return 0;
	}
	return runCliApp(app, args, io);
}
