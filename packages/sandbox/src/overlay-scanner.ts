import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { dangerouslyExecuteRawWrite } from "@bound/core";
import type { Logger } from "@bound/shared";
import { v5 as uuidv5 } from "uuid";

export interface ScanResult {
	created: number;
	updated: number;
	tombstoned: number;
}

/**
 * Optional outbox writer for synced table operations. When provided,
 * all overlay_index writes go through the change-log outbox. When absent,
 * direct SQL is used (backward compat for environments without @bound/core).
 */
export interface OverlayOutbox {
	insertRow: (db: Database, table: string, row: Record<string, unknown>, siteId: string) => void;
	updateRow: (
		db: Database,
		table: string,
		id: string,
		changes: Record<string, unknown>,
		siteId: string,
	) => void;
	softDelete: (db: Database, table: string, id: string, siteId: string) => void;
}

function computeContentHash(filePath: string): string | null {
	try {
		const content = readFileSync(filePath);
		return createHash("sha256").update(content).digest("hex");
	} catch {
		// Return null when file cannot be read (permissions, deletion race, etc.)
		// Caller should skip this file rather than treating it as changed
		return null;
	}
}

function generateDeterministicId(_siteId: string, path: string): string {
	// Fixed namespace keeps IDs path-based and site-independent so the same
	// overlay file gets the same ID regardless of which host scanned it.
	const BOUND_NAMESPACE = "550e8400-e29b-41d4-a716-446655440000";
	return uuidv5(path, BOUND_NAMESPACE);
}

function walkDirectory(
	dir: string,
	prefix = "",
	logger?: Logger,
): Array<{ path: string; fullPath: string }> {
	const entries: Array<{ path: string; fullPath: string }> = [];

	try {
		const files = readdirSync(dir);
		for (const file of files) {
			const fullPath = join(dir, file);
			const relativePath = prefix ? `${prefix}/${file}` : file;

			try {
				const stat = statSync(fullPath);
				if (stat.isDirectory()) {
					entries.push(...walkDirectory(fullPath, relativePath, logger));
				} else if (stat.isFile()) {
					entries.push({ path: relativePath, fullPath });
				}
			} catch (entryError) {
				// Expected: file deleted between readdir and stat (TOCTOU race).
				// Unexpected: permission errors. Log so the latter is observable;
				// best-effort scan still skips the entry either way.
				logger?.debug("[overlay] Skipping unstatable entry during scan", {
					path: fullPath,
					error: entryError instanceof Error ? entryError.message : String(entryError),
				});
			}
		}
	} catch (dirError) {
		// Expected: directory deleted during scan (TOCTOU race).
		// Unexpected: permission errors. Log so the latter is observable;
		// silent skip remains acceptable — overlay scanner is best-effort.
		logger?.debug("[overlay] Skipping unreadable directory during scan", {
			dir,
			error: dirError instanceof Error ? dirError.message : String(dirError),
		});
	}

	return entries;
}

export function scanOverlayIndex(
	db: Database,
	siteId: string,
	overlayMounts: Record<string, string>,
	outbox?: OverlayOutbox,
	logger?: Logger,
): ScanResult {
	let created = 0;
	let updated = 0;
	let tombstoned = 0;

	const scannedPaths = new Set<string>();

	// Scan each mounted directory
	for (const [, mountPath] of Object.entries(overlayMounts)) {
		const entries = walkDirectory(mountPath, "", logger);

		for (const entry of entries) {
			scannedPaths.add(entry.path);

			const id = generateDeterministicId(siteId, entry.path);
			const now = new Date().toISOString();
			const stat = statSync(entry.fullPath);
			const contentHash = computeContentHash(entry.fullPath);

			// Skip files that cannot be read (permissions, etc.)
			if (contentHash === null) {
				continue;
			}

			// Check if entry exists
			const existing = db
				.prepare("SELECT content_hash FROM overlay_index WHERE id = ? AND deleted = 0")
				.get(id) as { content_hash: string } | null;

			if (!existing) {
				// New file
				if (outbox) {
					outbox.insertRow(
						db,
						"overlay_index",
						{
							id,
							site_id: siteId,
							path: entry.path,
							size_bytes: stat.size,
							content_hash: contentHash,
							indexed_at: now,
							modified_at: now,
							deleted: 0,
						},
						siteId,
					);
				} else {
					dangerouslyExecuteRawWrite(db, {
						sql: "INSERT OR IGNORE INTO overlay_index (id, site_id, path, size_bytes, content_hash, indexed_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
						params: [id, siteId, entry.path, stat.size, contentHash, now, now],
						reason:
							"overlay_index scan without an injected outbox (backward compat); local index rebuilt from filesystem on every scan",
					});
				}
				created++;
			} else if (existing.content_hash !== contentHash) {
				// File changed
				if (outbox) {
					outbox.updateRow(
						db,
						"overlay_index",
						id,
						{
							size_bytes: stat.size,
							content_hash: contentHash,
							indexed_at: now,
						},
						siteId,
					);
				} else {
					dangerouslyExecuteRawWrite(db, {
						sql: "UPDATE overlay_index SET size_bytes = ?, content_hash = ?, indexed_at = ? WHERE id = ?",
						params: [stat.size, contentHash, now, id],
						reason:
							"overlay_index scan without an injected outbox (backward compat); local index rebuilt from filesystem on every scan",
					});
				}
				updated++;
			}
		}
	}

	// Tombstone files that no longer exist
	const allEntries = db
		.prepare("SELECT id, path FROM overlay_index WHERE site_id = ? AND deleted = 0")
		.all(siteId) as Array<{ id: string; path: string }>;

	for (const entry of allEntries) {
		if (!scannedPaths.has(entry.path)) {
			if (outbox) {
				outbox.softDelete(db, "overlay_index", entry.id, siteId);
			} else {
				const now = new Date().toISOString();
				dangerouslyExecuteRawWrite(db, {
					sql: "UPDATE overlay_index SET deleted = 1, indexed_at = ? WHERE id = ?",
					params: [now, entry.id],
					reason:
						"overlay_index tombstone without an injected outbox (backward compat); local index rebuilt from filesystem on every scan",
				});
			}
			tombstoned++;
		}
	}

	return { created, updated, tombstoned };
}

export function startOverlayScanLoop(
	db: Database,
	siteId: string,
	overlayMounts: Record<string, string>,
	intervalMs: number = 5 * 60 * 1000,
	outbox?: OverlayOutbox,
	logger?: Logger,
): { stop: () => void } {
	let stopped = false;

	// Run initial scan immediately at startup
	scanOverlayIndex(db, siteId, overlayMounts, outbox, logger);

	const interval = setInterval(() => {
		if (!stopped) {
			scanOverlayIndex(db, siteId, overlayMounts, outbox, logger);
		}
	}, intervalMs);

	return {
		stop: () => {
			stopped = true;
			clearInterval(interval);
		},
	};
}
