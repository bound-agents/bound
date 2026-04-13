import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { insertRow, updateRow } from "@bound/core";
import { type IFileSystem, InMemoryFs, MountableFs, OverlayFs } from "just-bash";

export interface ClusterFsConfig {
	hostName: string;
	overlayMounts?: Record<string, string>;
	syncEnabled: boolean;
	db?: Database;
	siteId?: string;
}

export interface ClusterFsResult {
	fs: MountableFs;
	/**
	 * Check staleness of a cached file against the overlay index.
	 * Returns null if the path is not found in either the files table or overlay index.
	 */
	checkStaleness: (path: string) => StalenessResult | null;
	/**
	 * Enumerate all paths that exist in the in-memory filesystem instances
	 * (baseFs and homeUserFs). Never touches OverlayFs instances.
	 * Used by snapshotWorkspace to diff only agent-written paths.
	 */
	getInMemoryPaths: () => string[];
}

export interface StalenessResult {
	stale: boolean;
	cachedHash: string;
	indexHash: string;
}

export interface FileChange {
	path: string;
	operation: "created" | "modified" | "deleted";
	content?: string;
	sizeBytes?: number;
}

/**
 * Create a ClusterFs with optional auto-caching of overlay reads.
 *
 * When syncEnabled is true and db/siteId are provided, files read from
 * overlay mounts are automatically cached to the files table for sync.
 */
export function createClusterFs(config: ClusterFsConfig): MountableFs;
export function createClusterFs(
	config: ClusterFsConfig & { db: Database; siteId: string },
): ClusterFsResult;
export function createClusterFs(config: ClusterFsConfig): MountableFs | ClusterFsResult {
	const baseFs = new InMemoryFs();
	const fs = new MountableFs({ base: baseFs });

	// Create /home/user as InMemoryFs
	const homeUserFs = new InMemoryFs();
	fs.mount("/home/user", homeUserFs);

	// Track overlay mount points for auto-cache path detection
	const overlayMountPoints = new Set<string>();

	// Mount overlay filesystems if provided.
	// MountableFs strips the mount prefix and passes relative paths to the
	// sub-filesystem, so the OverlayFs mountPoint must be "/" to match.
	if (config.overlayMounts) {
		for (const [realPath, mountPath] of Object.entries(config.overlayMounts)) {
			const overlayFs = new OverlayFs({
				root: realPath,
				mountPoint: "/",
				readOnly: false,
			});
			fs.mount(mountPath, overlayFs);
			overlayMountPoints.add(mountPath);
		}
	}

	// If db and siteId are provided, enable auto-cache and staleness checking
	if (config.db && config.siteId) {
		const db = config.db;
		const siteId = config.siteId;

		// Wrap readFile to auto-cache overlay reads when sync is enabled
		if (config.syncEnabled && overlayMountPoints.size > 0) {
			const originalReadFile = fs.readFile.bind(fs);
			fs.readFile = async (path: string, options?: unknown): Promise<string> => {
				const content = await originalReadFile(path, options as undefined);

				// Check if this path belongs to an overlay mount
				const isOverlayPath = isUnderOverlayMount(path, overlayMountPoints);
				if (isOverlayPath) {
					autoCacheFile(db, siteId, path, content);
				}

				return content;
			};
		}

		const checkStaleness = (path: string): StalenessResult | null => {
			return checkFileStaleness(db, path);
		};

		const getInMemoryPaths = (): string[] => {
			const paths: string[] = [];
			for (const p of baseFs.getAllPaths()) {
				paths.push(p);
			}
			for (const p of homeUserFs.getAllPaths()) {
				// homeUserFs stores paths with the /home/user prefix stripped,
				// e.g., "/foo.txt" for the VFS path "/home/user/foo.txt".
				paths.push(`/home/user${p}`);
			}
			return paths;
		};

		return { fs, checkStaleness, getInMemoryPaths };
	}

	return fs;
}

/**
 * Check if a virtual path falls under any overlay mount point.
 */
function isUnderOverlayMount(path: string, overlayMountPoints: Set<string>): boolean {
	for (const mount of overlayMountPoints) {
		if (path === mount || path.startsWith(`${mount}/`)) {
			return true;
		}
	}
	return false;
}

/**
 * Auto-cache a file read from an overlay into the files table.
 * Uses insertRow/updateRow from @bound/core to maintain the change-log outbox.
 */
function autoCacheFile(db: Database, siteId: string, path: string, content: string): void {
	const contentHash = createHash("sha256").update(content).digest("hex");
	const sizeBytes = Buffer.byteLength(content);
	const now = new Date().toISOString();

	// Check if already cached with the same hash
	const existing = db
		.query("SELECT id, content FROM files WHERE path = ? AND deleted = 0")
		.get(path) as { id: string; content: string } | null;

	if (existing) {
		const existingHash = createHash("sha256").update(existing.content).digest("hex");
		if (existingHash === contentHash) {
			// Content unchanged, skip update
			return;
		}
		updateRow(
			db,
			"files",
			existing.id,
			{
				content,
				size_bytes: sizeBytes,
			},
			siteId,
		);
	} else {
		insertRow(
			db,
			"files",
			{
				id: path,
				path,
				content,
				deleted: 0,
				size_bytes: sizeBytes,
				created_at: now,
				modified_at: now,
			},
			siteId,
		);
	}
}

/**
 * Check staleness of a cached file by comparing its content hash
 * against the overlay_index entry's content_hash.
 *
 * Returns null if the path is not found in both the files table and overlay index.
 */
function checkFileStaleness(db: Database, path: string): StalenessResult | null {
	const cachedFile = db
		.query("SELECT content FROM files WHERE path = ? AND deleted = 0")
		.get(path) as { content: string } | null;

	if (!cachedFile) {
		return null;
	}

	// Look up overlay index entry by path
	const indexEntry = db
		.query("SELECT content_hash FROM overlay_index WHERE path = ? AND deleted = 0")
		.get(path) as { content_hash: string } | null;

	if (!indexEntry || !indexEntry.content_hash) {
		return null;
	}

	const cachedHash = createHash("sha256").update(cachedFile.content).digest("hex");
	const indexHash = indexEntry.content_hash;

	return {
		stale: cachedHash !== indexHash,
		cachedHash,
		indexHash,
	};
}

export async function snapshotWorkspace(
	fs: IFileSystem,
	options?: { paths?: string[] },
): Promise<Map<string, string>> {
	const snapshot = new Map<string, string>();
	const toSnapshot: Iterable<string> =
		options?.paths !== undefined
			? options.paths
			: [...fs.getAllPaths()].filter((p) => p.startsWith("/home/user/"));

	for (const path of toSnapshot) {
		try {
			const content = await fs.readFile(path);
			const hash = createHash("sha256").update(content).digest("hex");
			snapshot.set(path, hash);
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code !== "ENOENT" && code !== "EISDIR") {
				// Re-throw unexpected errors (permission denied, etc.)
				throw err;
			}
			// Expected: file doesn't exist or is a directory
		}
	}

	return snapshot;
}

export async function diffWorkspaceAsync(
	before: Map<string, string>,
	after: Map<string, string>,
	fs?: IFileSystem,
): Promise<FileChange[]> {
	const changes: FileChange[] = [];
	const allPaths = new Set([...before.keys(), ...after.keys()]);

	for (const path of allPaths) {
		const beforeHash = before.get(path);
		const afterHash = after.get(path);

		if (!beforeHash && afterHash) {
			let content: string | undefined;
			let sizeBytes: number | undefined;
			if (fs) {
				try {
					content = await fs.readFile(path);
					sizeBytes = Buffer.byteLength(content);
				} catch (err: unknown) {
					const code = (err as NodeJS.ErrnoException)?.code;
					if (code !== "ENOENT" && code !== "EISDIR") {
						// Re-throw unexpected errors (permission denied, etc.)
						throw err;
					}
					// Expected: file doesn't exist or is a directory
				}
			}
			changes.push({
				path,
				operation: "created",
				content,
				sizeBytes,
			});
		} else if (beforeHash && !afterHash) {
			changes.push({
				path,
				operation: "deleted",
			});
		} else if (beforeHash !== afterHash && beforeHash && afterHash) {
			let content: string | undefined;
			let sizeBytes: number | undefined;
			if (fs) {
				try {
					content = await fs.readFile(path);
					sizeBytes = Buffer.byteLength(content);
				} catch (err: unknown) {
					const code = (err as NodeJS.ErrnoException)?.code;
					if (code !== "ENOENT" && code !== "EISDIR") {
						// Re-throw unexpected errors (permission denied, etc.)
						throw err;
					}
					// Expected: file doesn't exist or is a directory
				}
			}
			changes.push({
				path,
				operation: "modified",
				content,
				sizeBytes,
			});
		}
	}

	return changes;
}

export function diffWorkspace(
	before: Map<string, string>,
	after: Map<string, string>,
): FileChange[] {
	const changes: FileChange[] = [];
	const allPaths = new Set([...before.keys(), ...after.keys()]);

	for (const path of allPaths) {
		const beforeHash = before.get(path);
		const afterHash = after.get(path);

		if (!beforeHash && afterHash) {
			changes.push({
				path,
				operation: "created",
			});
		} else if (beforeHash && !afterHash) {
			changes.push({
				path,
				operation: "deleted",
			});
		} else if (beforeHash !== afterHash && beforeHash && afterHash) {
			changes.push({
				path,
				operation: "modified",
			});
		}
	}

	return changes;
}

export async function hydrateWorkspace(fs: MountableFs, db: Database): Promise<void> {
	const query = db.prepare(`
		SELECT path, content FROM files
		WHERE deleted = 0 AND path NOT LIKE '/mnt/%'
	`);

	for (const row of query.all() as Array<{ path: string; content: string }>) {
		await fs.writeFile(row.path, row.content);
	}
}

export async function hydrateRemoteCache(
	fs: MountableFs,
	db: Database,
	hostName: string,
): Promise<void> {
	const query = db.prepare(`
		SELECT path, content FROM files
		WHERE path LIKE ? AND deleted = 0
	`);

	const pattern = `/mnt/${hostName}/%`;
	for (const row of query.all(pattern) as Array<{ path: string; content: string }>) {
		await fs.writeFile(row.path, row.content);
	}
}
