import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { v5 as uuidv5 } from "uuid";

export interface ScanResult {
	created: number;
	updated: number;
	tombstoned: number;
}

function computeContentHash(filePath: string): string {
	try {
		const content = readFileSync(filePath);
		return createHash("sha256").update(content).digest("hex");
	} catch {
		// Return empty hash if file cannot be read (permissions, deletion race, etc.)
		return "";
	}
}

function generateDeterministicId(_siteId: string, path: string): string {
	// Use UUID5 with site_id as namespace and path as name
	const BOUND_NAMESPACE = "550e8400-e29b-41d4-a716-446655440000";
	return uuidv5(path, BOUND_NAMESPACE);
}

function walkDirectory(dir: string, prefix = ""): Array<{ path: string; fullPath: string }> {
	const entries: Array<{ path: string; fullPath: string }> = [];

	try {
		const files = readdirSync(dir);
		for (const file of files) {
			const fullPath = join(dir, file);
			const relativePath = prefix ? `${prefix}/${file}` : file;

			try {
				const stat = statSync(fullPath);
				if (stat.isDirectory()) {
					entries.push(...walkDirectory(fullPath, relativePath));
				} else if (stat.isFile()) {
					entries.push({ path: relativePath, fullPath });
				}
			} catch {
				// Skip files we can't stat (permissions, symlink loops, etc.)
			}
		}
	} catch {
		// Skip directories we can't read (permissions, deleted during scan, etc.)
	}

	return entries;
}

export function scanOverlayIndex(
	db: Database,
	siteId: string,
	overlayMounts: Record<string, string>,
): ScanResult {
	let created = 0;
	let updated = 0;
	let tombstoned = 0;

	const scannedPaths = new Set<string>();

	// Scan each mounted directory
	for (const [, mountPath] of Object.entries(overlayMounts)) {
		const entries = walkDirectory(mountPath);

		for (const entry of entries) {
			scannedPaths.add(entry.path);

			const id = generateDeterministicId(siteId, entry.path);
			const now = new Date().toISOString();
			const stat = statSync(entry.fullPath);
			const contentHash = computeContentHash(entry.fullPath);

			// Check if entry exists
			const existing = db
				.prepare("SELECT content_hash FROM overlay_index WHERE id = ? AND deleted = 0")
				.get(id) as { content_hash: string } | undefined;

			if (!existing) {
				// New file
				db.prepare(
					"INSERT OR IGNORE INTO overlay_index (id, site_id, path, size_bytes, content_hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
				).run(id, siteId, entry.path, stat.size, contentHash, now);
				created++;
			} else if (existing.content_hash !== contentHash) {
				// File changed
				db.prepare(
					"UPDATE overlay_index SET size_bytes = ?, content_hash = ?, indexed_at = ? WHERE id = ?",
				).run(stat.size, contentHash, now, id);
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
			const now = new Date().toISOString();
			db.prepare("UPDATE overlay_index SET deleted = 1, indexed_at = ? WHERE id = ?").run(
				now,
				entry.id,
			);
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
): { stop: () => void } {
	let stopped = false;

	// Run initial scan immediately at startup
	scanOverlayIndex(db, siteId, overlayMounts);

	const interval = setInterval(() => {
		if (!stopped) {
			scanOverlayIndex(db, siteId, overlayMounts);
		}
	}, intervalMs);

	return {
		stop: () => {
			stopped = true;
			clearInterval(interval);
		},
	};
}
