import type { IFileSystem } from "just-bash";

const DEFAULT_MEMORY_THRESHOLD_BYTES = 500 * 1024 * 1024; // 500MB

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

	/**
	 * Track a file write. Adjusts the running total.
	 */
	trackWrite(path: string, content: string | Uint8Array): void {
		const newSize = typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
		const oldSize = this.fileSizes.get(path) ?? 0;
		this.totalBytes += newSize - oldSize;
		this.fileSizes.set(path, newSize);
	}

	/**
	 * Track a file removal. Subtracts from the running total.
	 */
	trackRemove(path: string): void {
		const oldSize = this.fileSizes.get(path) ?? 0;
		this.totalBytes -= oldSize;
		this.fileSizes.delete(path);
	}

	/**
	 * Get total memory usage in bytes.
	 */
	getMemoryUsage(): number {
		return this.totalBytes;
	}

	/**
	 * Check if memory usage exceeds the configured threshold.
	 */
	isOverThreshold(): boolean {
		return this.totalBytes > this.thresholdBytes;
	}

	/**
	 * Get full memory threshold status.
	 */
	checkMemoryThreshold(): MemoryThresholdResult {
		return {
			overThreshold: this.totalBytes > this.thresholdBytes,
			usageBytes: this.totalBytes,
			thresholdBytes: this.thresholdBytes,
		};
	}

	/**
	 * Get the configured threshold in bytes.
	 */
	getThresholdBytes(): number {
		return this.thresholdBytes;
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
		// For append, we need to read the full content to get the actual size
		try {
			const fullContent = await fs.readFile(path);
			tracker.trackWrite(path, fullContent);
		} catch {
			// If read fails, track the appended content as-is
			tracker.trackWrite(path, content);
		}
	};

	fs.rm = async (path: string, options?: unknown): Promise<void> => {
		// Track removal of all files under this path if recursive
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
				tracker.trackRemove(path);
			}
		} else {
			tracker.trackRemove(path);
		}
		await originalRm(path, rmOpts);
	};

	return fs;
}
