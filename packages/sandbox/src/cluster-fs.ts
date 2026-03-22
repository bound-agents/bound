import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { type IFileSystem, InMemoryFs, MountableFs, OverlayFs } from "just-bash";

export interface ClusterFsConfig {
	hostName: string;
	overlayMounts?: Record<string, string>;
	syncEnabled: boolean;
}

export interface FileChange {
	path: string;
	operation: "created" | "modified" | "deleted";
	content?: string;
	sizeBytes?: number;
}

export function createClusterFs(config: ClusterFsConfig): MountableFs {
	const baseFs = new InMemoryFs();
	const fs = new MountableFs({ base: baseFs });

	// Create /home/user as InMemoryFs
	const homeUserFs = new InMemoryFs();
	fs.mount("/home/user", homeUserFs);

	// Mount overlay filesystems if provided
	if (config.overlayMounts) {
		for (const [realPath, mountPath] of Object.entries(config.overlayMounts)) {
			const overlayFs = new OverlayFs({
				root: realPath,
				mountPoint: mountPath,
				readOnly: false,
			});
			fs.mount(mountPath, overlayFs);
		}
	}

	return fs;
}

export function snapshotWorkspaceSync(fs: IFileSystem): Map<string, string> {
	const snapshot = new Map<string, string>();
	const paths = fs.getAllPaths();

	for (const path of paths) {
		if (path.startsWith("/home/user/")) {
			// This is a synchronous snapshot - we'll use getAllPaths which returns file paths
			// We need to hash based on path existence in the filesystem
			snapshot.set(path, "placeholder");
		}
	}

	return snapshot;
}

export async function snapshotWorkspace(fs: IFileSystem): Promise<Map<string, string>> {
	const snapshot = new Map<string, string>();
	const paths = fs.getAllPaths();

	for (const path of paths) {
		if (path.startsWith("/home/user/")) {
			try {
				const content = await fs.readFile(path);
				const hash = createHash("sha256").update(content).digest("hex");
				snapshot.set(path, hash);
			} catch (_error) {
				// Ignore directories and other non-readable entries
			}
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
				} catch (_error) {
					// Content not available
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
				} catch (_error) {
					// Content not available
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
		WHERE path LIKE '/home/user/%' AND deleted = 0
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
