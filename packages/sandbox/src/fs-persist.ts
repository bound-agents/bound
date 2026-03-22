import type Database from "bun:sqlite";
import type { TypedEventEmitter } from "@bound/shared";
import { type Result, err, ok } from "@bound/shared";
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
	_siteId: string,
	preSnapshot: Map<string, string>,
	postSnapshot: Map<string, string>,
	eventBus: TypedEventEmitter,
	options?: PersistOptions,
): Promise<Result<PersistResult, PersistError>> {
	const maxFileSize = options?.maxFileSizeBytes ?? 1024 * 1024; // 1MB default
	const maxTotalSize = options?.maxTotalSizeBytes ?? 50 * 1024 * 1024; // 50MB default

	// Compute diff
	const changes = await diffWorkspaceAsync(preSnapshot, postSnapshot);

	if (changes.length === 0) {
		return ok({
			changes: 0,
			conflicts: 0,
			conflictPaths: [],
		});
	}

	// Check size limits
	let totalSize = 0;
	const failedPaths: string[] = [];

	for (const change of changes) {
		if (change.sizeBytes !== undefined) {
			if (change.sizeBytes > maxFileSize) {
				failedPaths.push(change.path);
				continue;
			}
			totalSize += change.sizeBytes;
		}
	}

	if (failedPaths.length > 0) {
		const error = new Error("Files exceed size limit") as PersistError;
		error.failedPaths = failedPaths;
		return err(error);
	}

	if (totalSize > maxTotalSize) {
		const error = new Error("Total size exceeds limit") as PersistError;
		error.failedPaths = changes.map((c) => c.path);
		return err(error);
	}

	// Persist changes
	const conflictPaths: string[] = [];
	const conflictCount = 0;
	let changeCount = 0;

	db.exec("BEGIN IMMEDIATE");

	try {
		for (const change of changes) {
			changeCount++;
			eventBus.emit("file:changed", {
				path: change.path,
				operation: change.operation,
			});
		}

		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}

	return ok({
		changes: changeCount,
		conflicts: conflictCount,
		conflictPaths,
	});
}
