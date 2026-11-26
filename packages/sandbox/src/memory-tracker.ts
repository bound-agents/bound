import type { IFileSystem } from "just-bash";

const DEFAULT_MEMORY_THRESHOLD_BYTES = 500 * 1024 * 1024;

export interface MemoryThresholdResult {
	overThreshold: boolean;
	usageBytes: number;
	thresholdBytes: number;
}

/**
 * Tracks total memory usage across all files in a filesystem.
 *
 * Wraps an IFileSystem and intercepts writeFile/appendFile/rm to
 * maintain an accurate running total of content size in bytes.
 */
export class MemoryTracker {
	private fileSizes = new Map<string, number>();
	private totalBytes = 0;
	private readonly thresholdBytes: number;

	constructor(thresholdBytes: number = DEFAULT_MEMORY_THRESHOLD_BYTES) {
		this.thresholdBytes = thresholdBytes;
	}

	trackWrite(path: string, content: string | Uint8Array): void {
		const newSize = typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
		const oldSize = this.fileSizes.get(path) ?? 0;
		this.totalBytes += newSize - oldSize;
		this.fileSizes.set(path, newSize);
	}

	trackRemove(path: string): void {
		const oldSize = this.fileSizes.get(path) ?? 0;
		this.totalBytes -= oldSize;
		this.fileSizes.delete(path);
	}

	/** Whether this file has an authoritative size from a tracked write or append. */
	hasTrackedFile(path: string): boolean {
		return this.fileSizes.has(path);
	}

	/** Track bytes appended to a file with a known prior size. */
	trackAppend(path: string, content: string | Uint8Array): void {
		const appendedBytes =
			typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
		this.totalBytes += appendedBytes;
		this.fileSizes.set(path, (this.fileSizes.get(path) ?? 0) + appendedBytes);
	}

	checkMemoryThreshold(): MemoryThresholdResult {
		return {
			overThreshold: this.totalBytes > this.thresholdBytes,
			usageBytes: this.totalBytes,
			thresholdBytes: this.thresholdBytes,
		};
	}
}

/**
 * Wrap a filesystem with memory tracking.
 * Intercepts writeFile, appendFile, and rm to maintain usage tracking.
 * Returns the same filesystem reference with the interceptors attached.
 */
export function wrapWithMemoryTracking(fs: IFileSystem, tracker: MemoryTracker): IFileSystem {
	const originalWriteFile = fs.writeFile.bind(fs);
	const originalAppendFile = fs.appendFile.bind(fs);
	const originalRm = fs.rm.bind(fs);

	fs.writeFile = async (
		path: string,
		content: string | Uint8Array,
		options?: unknown,
	): Promise<void> => {
		await originalWriteFile(path, content, options as undefined);
		tracker.trackWrite(path, content);
	};

	fs.appendFile = async (
		path: string,
		content: string | Uint8Array,
		options?: unknown,
	): Promise<void> => {
		await originalAppendFile(path, content, options as undefined);
		if (tracker.hasTrackedFile(path)) {
			// A prior tracked write or append established the file size, so avoid
			// rereading an ever-growing file after every append.
			tracker.trackAppend(path, content);
			return;
		}

		// This file existed before tracking began. Read once to establish its
		// complete post-append size; treating it as empty would undercount it.
		const fullContent = await fs.readFile(path);
		tracker.trackWrite(path, fullContent);
	};

	fs.rm = async (path: string, options?: unknown): Promise<void> => {
		const rmOpts = options as { recursive?: boolean; force?: boolean } | undefined;
		if (rmOpts?.recursive) {
			try {
				const allPaths = fs.getAllPaths();
				for (const p of allPaths) {
					if (p === path || p.startsWith(`${path}/`)) {
						tracker.trackRemove(p);
					}
				}
			} catch {
				// Undercounts freed bytes for a recursive delete, but never corrupts the total.
				tracker.trackRemove(path);
			}
		} else {
			tracker.trackRemove(path);
		}
		await originalRm(path, rmOpts);
	};

	return fs;
}
