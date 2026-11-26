import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { listWorkspaceFiles, listWorkspaceFilesModifiedSince } from "@bound/core";
import { type IFileSystem, InMemoryFs, MountableFs } from "just-bash";

/**
 * Check whether an error is an expected filesystem error (ENOENT or EISDIR).
 * just-bash's VFS throws Error objects without the Node.js `.code` property,
 * so we also inspect `.message` for the error code strings.
 */
function isExpectedFsError(err: unknown): boolean {
	const code = (err as NodeJS.ErrnoException)?.code;
	if (code === "ENOENT" || code === "EISDIR") return true;
	const msg = err instanceof Error ? err.message : "";
	return msg.startsWith("ENOENT:") || msg.startsWith("EISDIR:");
}

export interface ClusterFsConfig {
	hostName: string;
	syncEnabled: boolean;
	db?: Database;
	siteId?: string;
}

export interface ClusterFsResult {
	fs: MountableFs;
	/**
	 * Enumerate all paths that exist in the in-memory filesystem instances
	 * (baseFs and homeUserFs). Used by snapshotWorkspace to diff only
	 * agent-written paths.
	 */
	getInMemoryPaths: () => string[];
}

export interface FileChange {
	path: string;
	operation: "created" | "modified" | "deleted";
	content?: string;
	sizeBytes?: number;
}

export function createClusterFs(config: ClusterFsConfig): MountableFs;
export function createClusterFs(
	config: ClusterFsConfig & { db: Database; siteId: string },
): ClusterFsResult;
export function createClusterFs(config: ClusterFsConfig): MountableFs | ClusterFsResult {
	const baseFs = new InMemoryFs();
	const fs = new MountableFs({ base: baseFs });

	const homeUserFs = new InMemoryFs();
	fs.mount("/home/user", homeUserFs);

	if (config.db && config.siteId) {
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

		return { fs, getInMemoryPaths };
	}

	return fs;
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
			if (!isExpectedFsError(err)) throw err;
		}
	}

	return snapshot;
}

export function diffWorkspace(
	before: Map<string, string>,
	after: Map<string, string>,
): FileChange[] {
	const changes: FileChange[] = [];
	for (const path of new Set([...before.keys(), ...after.keys()])) {
		const beforeHash = before.get(path);
		const afterHash = after.get(path);
		if (!beforeHash && afterHash) {
			changes.push({ path, operation: "created" });
		} else if (beforeHash && !afterHash) {
			changes.push({ path, operation: "deleted" });
		} else if (beforeHash && afterHash && beforeHash !== afterHash) {
			changes.push({ path, operation: "modified" });
		}
	}
	return changes;
}

/** Like {@link diffWorkspace}, but also reads content for created/modified paths when `fs` is given. */
export async function diffWorkspaceAsync(
	before: Map<string, string>,
	after: Map<string, string>,
	fs?: IFileSystem,
): Promise<FileChange[]> {
	const changes = diffWorkspace(before, after);
	if (!fs) return changes;
	for (const change of changes) {
		if (change.operation === "deleted") continue;
		try {
			change.content = await fs.readFile(change.path);
			change.sizeBytes = Buffer.byteLength(change.content);
		} catch (err: unknown) {
			if (!isExpectedFsError(err)) throw err;
		}
	}
	return changes;
}

/**
 * Decode a `files` row's stored content into the VFS representation.
 *
 * `is_binary = 1` rows store base64 in `files.content` (the web upload path does
 * `Buffer.from(data).toString("base64")`); the VFS holds binary as a latin1
 * "binary string" (1 char = 1 byte), which the read tool re-encodes via
 * `Buffer.from(raw, "binary").toString("base64")`. So binary rows are decoded
 * base64 -> binary string here, the symmetric inverse. Text rows pass through.
 *
 * Shared by both hydration paths so boot-time and per-turn re-hydration cannot
 * drift on binary handling.
 */
function decodeFileContent(content: string | null, isBinary: number): string {
	const raw = content ?? "";
	return isBinary === 1 ? Buffer.from(raw, "base64").toString("binary") : raw;
}

export async function hydrateWorkspace(fs: MountableFs, db: Database): Promise<void> {
	for (const row of listWorkspaceFiles(db)) {
		await fs.writeFile(row.path, decodeFileContent(row.content, row.is_binary));
	}
}

/**
 * Incrementally re-hydrate the live VFS from `files` rows modified since a
 * cursor. `hydrateWorkspace` runs exactly once at startup, so files written to
 * the `files` table *after* boot (e.g. an upload through the web Files tab, or a
 * peer's change syncing in) never reach the live sandbox until this runs.
 *
 * Called from the agent loop's HYDRATE_FS stage, BEFORE `capturePreSnapshot`,
 * so the OCC baseline includes the re-hydrated content and FS_PERSIST does not
 * mistake a re-pull for an agent edit (Invariant #5).
 *
 * Binary rows are decoded via {@link decodeFileContent}.
 *
 * Returns the new cursor: the wall-clock time captured BEFORE the SELECT. Any
 * row written during the scan is therefore re-pulled on the next pass rather
 * than skipped — re-pulls are idempotent (same bytes, before the OCC snapshot),
 * so the only cost of the overlap is a redundant write, never a lost update.
 */
export async function rehydrateWorkspaceIncremental(
	fs: MountableFs,
	db: Database,
	sinceIso: string,
): Promise<string> {
	const cursor = new Date().toISOString();
	for (const row of listWorkspaceFilesModifiedSince(db, sinceIso)) {
		await fs.writeFile(row.path, decodeFileContent(row.content, row.is_binary));
	}

	return cursor;
}

/**
 * Build a cursor-managing re-hydration closure for the agent loop's HYDRATE_FS
 * stage. The returned function pulls `files` rows written since the previous
 * call into the live VFS and advances its own cursor, so each turn picks up
 * only what arrived since the last one.
 *
 * The cursor lives in this closure for the lifetime of the process, NOT per
 * agent-loop invocation: the VFS (`fs`) is a per-host singleton shared by every
 * thread, so "what has already been pulled" is host-global state. A per-loop
 * cursor would re-scan from scratch on every new conversation. It seeds to
 * `sinceIso` (defaulting to construction time, ~boot, just after the one-shot
 * `hydrateWorkspace`); the first turn then pulls anything written post-boot.
 */
export function createVfsRehydrator(
	fs: MountableFs,
	db: Database,
	sinceIso: string = new Date().toISOString(),
): () => Promise<void> {
	let cursor = sinceIso;
	return async (): Promise<void> => {
		cursor = await rehydrateWorkspaceIncremental(fs, db, cursor);
	};
}
