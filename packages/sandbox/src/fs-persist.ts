import type Database from "bun:sqlite";
import { insertRow, softDelete, updateRow } from "@bound/core";
import type { TypedEventEmitter } from "@bound/shared";
import { type Result, err, ok } from "@bound/shared";
import type { IFileSystem } from "just-bash";
import { diffWorkspaceAsync } from "./cluster-fs";

export interface PersistResult {
	changes: number;
	conflicts: number;
	conflictPaths: string[];
}

export interface PersistError extends Error {
	failedPaths: string[];
}

export interface PersistOptions {
	maxFileSizeBytes?: number;
	maxTotalSizeBytes?: number;
}

export async function persistWorkspaceChanges(
	db: Database,
	siteId: string,
	preSnapshot: Map<string, string>,
	postSnapshot: Map<string, string>,
	eventBus: TypedEventEmitter,
	options?: PersistOptions,
	fs?: IFileSystem,
): Promise<Result<PersistResult, PersistError>> {
	const maxFileSize = options?.maxFileSizeBytes ?? 1024 * 1024; // 1MB default
	const maxTotalSize = options?.maxTotalSizeBytes ?? 50 * 1024 * 1024; // 50MB default

	// Compute diff
	const changes = await diffWorkspaceAsync(preSnapshot, postSnapshot, fs);

	if (changes.length === 0) {
		return ok({
			changes: 0,
			conflicts: 0,
			conflictPaths: [],
		});
	}

	// Check individual file size limits
	const failedPaths: string[] = [];
	for (const change of changes) {
		const sizeBytes = change.sizeBytes ?? 0;
		if (sizeBytes > maxFileSize) {
			failedPaths.push(change.path);
		}
	}

	if (failedPaths.length > 0) {
		const error = new Error("Files exceed individual size limit") as PersistError;
		error.failedPaths = failedPaths;
		return err(error);
	}

	// Check total size limit across workspace
	let totalSize = 0;
	for (const change of changes) {
		const sizeBytes = change.sizeBytes ?? 0;
		totalSize += sizeBytes;
	}

	if (totalSize > maxTotalSize) {
		const error = new Error("Total workspace size exceeds limit") as PersistError;
		error.failedPaths = changes.map((c) => c.path);
		return err(error);
	}

	// Persist changes via database
	const conflictPaths: string[] = [];
	let conflictCount = 0;
	let changeCount = 0;

	db.exec("BEGIN IMMEDIATE");

	const pendingEvents: Array<{ path: string; operation: "created" | "modified" | "deleted" }> = [];

	try {
		for (const change of changes) {
			// Read current DB state for OCC check
			const dbRow = db.query("SELECT * FROM files WHERE path = ?").get(change.path) as
				| { path: string; content: string; modified_at: string }
				| undefined;

			const preSnapshotHash = preSnapshot.get(change.path);

			// OCC conflict detection: DB state differs from pre-snapshot
			if (dbRow && preSnapshotHash) {
				// Hash the DB content for apples-to-apples comparison with pre-snapshot hash
				const hasher = new Bun.CryptoHasher("sha256");
				hasher.update(dbRow.content);
				const dbContentHash = hasher.digest("hex");
				const isConflict = preSnapshotHash !== dbContentHash;
				if (isConflict) {
					conflictPaths.push(change.path);
					conflictCount++;
					// LWW: use newer modified_at timestamp
					const dbModifiedAt = new Date(dbRow.modified_at).getTime();
					const now = Date.now();
					if (dbModifiedAt > now) {
						// DB is newer, skip update
						continue;
					}
				}
			}

			// Apply the change
			if (change.operation === "created" || change.operation === "modified") {
				if (change.content !== undefined) {
					const now = new Date().toISOString();
					if (dbRow) {
						// Update existing file
						updateRow(
							db,
							"files",
							change.path,
							{
								content: change.content,
								modified_at: now,
								size_bytes: change.sizeBytes ?? 0,
							},
							siteId,
						);
					} else {
						// Insert new file
						insertRow(
							db,
							"files",
							{
								id: change.path,
								path: change.path,
								content: change.content,
								deleted: 0,
								size_bytes: change.sizeBytes ?? 0,
								created_at: now,
								modified_at: now,
							},
							siteId,
						);
					}
					changeCount++;
				}
			} else if (change.operation === "deleted") {
				if (dbRow) {
					softDelete(db, "files", change.path, siteId);
					changeCount++;
				}
			}

			// Collect events to emit after commit
			pendingEvents.push({
				path: change.path,
				operation: change.operation,
			});
		}

		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}

	// Emit events AFTER successful commit
	for (const event of pendingEvents) {
		eventBus.emit("file:changed", event);
	}

	return ok({
		changes: changeCount,
		conflicts: conflictCount,
		conflictPaths,
	});
}
