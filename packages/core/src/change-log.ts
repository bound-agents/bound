import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
	type SyncedTableName,
	type SyncedTableRowMap,
	type TypedEventEmitter,
	generateHlc,
	mergeHlc,
} from "@bound/shared";

// Validate column names to prevent SQL injection
// Only allow lowercase letters, numbers, and underscores
const VALID_COLUMN_NAME = /^[a-z_]+$/;

// Module-level event bus for emitting changelog:written events (optional)
let changelogEventBus: TypedEventEmitter | null = null;

/**
 * Set the event bus for emitting changelog:written events.
 * Called once at startup when WS transport is active.
 */
export function setChangelogEventBus(eventBus: TypedEventEmitter | null): void {
	changelogEventBus = eventBus;
}

// Primary key column per synced table. Defaults to "id" for all others.
const TABLE_PK_COLUMN: Partial<Record<SyncedTableName, string>> = {
	hosts: "site_id",
	cluster_config: "key",
};

export function getPkColumn(table: SyncedTableName): string {
	return TABLE_PK_COLUMN[table] ?? "id";
}

export function validateColumnName(name: string): void {
	if (!VALID_COLUMN_NAME.test(name)) {
		throw new Error(`Invalid column name: ${name}`);
	}
}

export function createChangeLogEntry(
	db: Database,
	tableName: SyncedTableName,
	rowId: string,
	siteId: string,
	rowData: Record<string, unknown>,
	remoteHlc?: string,
): string {
	const now = new Date().toISOString();
	const rowDataJson = JSON.stringify(rowData);

	// Get last HLC for monotonicity
	const lastRow = db.query("SELECT hlc FROM change_log ORDER BY hlc DESC LIMIT 1").get() as {
		hlc: string;
	} | null;

	let hlc: string;
	if (remoteHlc) {
		hlc = mergeHlc(lastRow?.hlc ?? "0000-00-00T00:00:00.000Z_0000_0000", remoteHlc, siteId);
	} else {
		hlc = generateHlc(now, lastRow?.hlc ?? null, siteId);
	}

	db.run(
		`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
		VALUES (?, ?, ?, ?, ?, ?)`,
		[hlc, tableName, rowId, siteId, now, rowDataJson],
	);

	// Return HLC for caller to emit event after transaction commits
	return hlc;
}

export function withChangeLog<T>(
	db: Database,
	siteId: string,
	fn: () => {
		tableName: SyncedTableName;
		rowId: string;
		rowData: Record<string, unknown>;
		result: T;
	},
): T {
	const transaction = db.transaction(() => {
		const result_obj = fn();
		const hlc = createChangeLogEntry(
			db,
			result_obj.tableName,
			result_obj.rowId,
			siteId,
			result_obj.rowData,
		);
		return { result: result_obj.result, hlc, tableName: result_obj.tableName };
	});

	const { result, hlc, tableName } = transaction() as {
		result: T;
		hlc: string;
		tableName: SyncedTableName;
	};

	// Emit event after transaction commits
	if (changelogEventBus) {
		changelogEventBus.emit("changelog:written", { hlc, tableName, siteId });
	}

	return result;
}

export function insertRow<T extends SyncedTableName>(
	db: Database,
	table: T,
	row: SyncedTableRowMap[T],
	siteId: string,
): void {
	const rowData = row as unknown as Record<string, unknown>;

	// Invariant #19: role='system' is reserved for the LLM driver layer
	// (stable-prefix system prompt). Persisting it into `messages` is silently
	// invisible to the agent — Stage 2.5 of context assembly drops such rows.
	// Reject loudly at the write boundary so the failure surfaces in tests/CI.
	if (table === "messages" && rowData.role === "system") {
		throw new Error(
			"Invariant: role='system' is not permitted in the messages table. " +
				"Use role='developer' for injected system-generated context intended for the agent.",
		);
	}

	const pkColumn = getPkColumn(table);
	const rowId = rowData[pkColumn] as string;
	const columns = Object.keys(rowData);
	// Validate all column names to prevent SQL injection
	columns.forEach(validateColumnName);
	const placeholders = columns.map(() => "?").join(", ");
	const values = columns.map((c) => rowData[c] ?? null) as Array<string | number | null | boolean>;

	const txFn = db.transaction(() => {
		db.run(
			`INSERT INTO ${table} (${columns.join(", ")})
			VALUES (${placeholders})`,
			values,
		);

		return createChangeLogEntry(db, table, rowId, siteId, rowData);
	});

	const hlc = txFn();

	// Emit event after transaction commits
	if (changelogEventBus) {
		changelogEventBus.emit("changelog:written", { hlc, tableName: table, siteId });
	}
}

export function updateRow<T extends SyncedTableName>(
	db: Database,
	table: T,
	id: string,
	updates: Partial<SyncedTableRowMap[T]>,
	siteId: string,
): void {
	const txFn = db.transaction(() => {
		const now = new Date().toISOString();
		const updatesWithModified = { ...updates, modified_at: now };

		const updateKeys = Object.keys(updatesWithModified);
		// Validate all column names to prevent SQL injection
		updateKeys.forEach(validateColumnName);

		const setClause = updateKeys.map((k) => `${k} = ?`).join(", ");

		const values = [...Object.values(updatesWithModified), id];

		const pkColumn = getPkColumn(table);
		db.run(`UPDATE ${table} SET ${setClause} WHERE ${pkColumn} = ?`, values);

		// Fetch the updated row to get the full snapshot
		const updatedRow = db.query(`SELECT * FROM ${table} WHERE ${pkColumn} = ?`).get(id) as Record<
			string,
			unknown
		> | null;
		if (!updatedRow) {
			throw new Error(`updateRow: Row ${id} disappeared from ${table} after update`);
		}

		return createChangeLogEntry(db, table, id, siteId, updatedRow);
	});

	const hlc = txFn();

	// Emit event after transaction commits
	if (changelogEventBus) {
		changelogEventBus.emit("changelog:written", { hlc, tableName: table, siteId });
	}
}

export function softDelete(db: Database, table: SyncedTableName, id: string, siteId: string): void {
	const txFn = db.transaction(() => {
		const now = new Date().toISOString();

		const pkColumn = getPkColumn(table);
		db.run(`UPDATE ${table} SET deleted = 1, modified_at = ? WHERE ${pkColumn} = ?`, [now, id]);

		// Fetch the deleted row to get the full snapshot
		const deletedRow = db.query(`SELECT * FROM ${table} WHERE ${pkColumn} = ?`).get(id) as Record<
			string,
			unknown
		> | null;
		if (!deletedRow) {
			throw new Error(`softDelete: Row ${id} disappeared from ${table} after update`);
		}

		return createChangeLogEntry(db, table, id, siteId, deletedRow);
	});

	const hlc = txFn();

	// Emit event after transaction commits
	if (changelogEventBus) {
		changelogEventBus.emit("changelog:written", { hlc, tableName: table, siteId });
	}
}

export function insertMessage(
	db: Database,
	params: {
		threadId: string;
		role: import("@bound/shared").MessageRole;
		content: string;
		modelId?: string | null;
		toolName?: string | null;
		hostOrigin: string;
	},
	siteId: string,
): string {
	const id = randomUUID();
	const now = new Date().toISOString();
	insertRow(
		db,
		"messages",
		{
			id,
			thread_id: params.threadId,
			role: params.role,
			content: params.content,
			model_id: params.modelId ?? null,
			tool_name: params.toolName ?? null,
			created_at: now,
			modified_at: now,
			host_origin: params.hostOrigin,
			deleted: 0,
			exit_code: null,
			metadata: null,
		},
		siteId,
	);
	return id;
}

/**
 * Read the opaque platform-scoped metadata property bag from a message.
 * Returns null when the message does not exist or has no metadata.
 *
 * Convention: platform connectors prefix their keys (discord_*, slack_*)
 * to avoid collisions. This field is invisible to the agent loop and
 * context assembly; only platform-specific code reads or writes it.
 */
export function readMessageMetadata(
	db: Database,
	messageId: string,
): Record<string, unknown> | null {
	const row = db.query("SELECT metadata FROM messages WHERE id = ?").get(messageId) as {
		metadata: string | null;
	} | null;
	if (!row || row.metadata === null) {
		return null;
	}
	try {
		return JSON.parse(row.metadata) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * Merge the given entries into the message's metadata property bag.
 * Existing keys not mentioned in `entries` are preserved; mentioned keys
 * are overwritten. Flows through updateRow() so a change_log entry is
 * created for sync and modified_at is bumped.
 *
 * Throws if the message row does not exist.
 */
export function writeMessageMetadata(
	db: Database,
	messageId: string,
	entries: Record<string, unknown>,
	siteId: string,
): void {
	const existing = readMessageMetadata(db, messageId) ?? {};
	const merged = { ...existing, ...entries };
	updateRow(db, "messages", messageId, { metadata: JSON.stringify(merged) }, siteId);
}
