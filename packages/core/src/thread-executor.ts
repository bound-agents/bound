import type { Database } from "bun:sqlite";
import type { Logger } from "@bound/shared";
import { formatError } from "@bound/shared";
import { hasPending, resetProcessingForThread } from "./dispatch";

/** Default timeout for a single runFn invocation (30 minutes).
 *  Must accommodate large cold-cache contexts (200k+ tokens) where
 *  the silence timeout retry loop alone can take 10+ minutes. */
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;

export interface ExecutorRunResult {
	yielded?: boolean;
	error?: string;
	[key: string]: unknown;
}

export interface ExecutorOptions {
	/** Maximum time (ms) a single runFn invocation may take before the
	 *  executor gives up and releases the lock. Default: 10 minutes. */
	runTimeoutMs?: number;
}

export class ThreadExecutor {
	private activeLocks = new Set<string>();
	private readonly runTimeoutMs: number;

	constructor(
		private db: Database,
		private logger: Logger,
		options?: ExecutorOptions,
	) {
		this.runTimeoutMs = options?.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
	}

	/**
	 * Read-only view of currently active thread IDs.
	 * Used by the web server to check loop status via `.has()`.
	 */
	get activeThreads(): ReadonlySet<string> {
		return this.activeLocks;
	}

	/**
	 * Check whether a thread currently has an active executor lock.
	 */
	isActive(threadId: string): boolean {
		return this.activeLocks.has(threadId);
	}

	/**
	 * Execute the drain loop for a thread. If the thread is already locked,
	 * returns immediately (the active loop will pick up new messages).
	 *
	 * @param threadId - Thread to process
	 * @param runFn - Inference callback; receives shouldYield and returns result
	 * @param onComplete - Called after each successful (non-yielded) iteration
	 */
	/**
	 * Execute the drain loop for a thread. If the thread is already locked,
	 * returns immediately (the active loop will pick up new messages).
	 *
	 * Returns true if pending entries remain after the lock is released,
	 * signaling the caller should re-trigger dispatch.
	 */
	async execute(
		threadId: string,
		runFn: (shouldYield: () => boolean) => Promise<ExecutorRunResult>,
		onComplete?: (result: ExecutorRunResult) => Promise<void>,
	): Promise<boolean> {
		if (this.activeLocks.has(threadId)) return false;
		this.activeLocks.add(threadId);

		try {
			while (true) {
				const shouldYield = () => hasPending(this.db, threadId);

				try {
					const result = await this.withTimeout(runFn(shouldYield), threadId);

					if (result.yielded) {
						resetProcessingForThread(this.db, threadId);
						continue;
					}

					if (onComplete) await onComplete(result);
					if (!hasPending(this.db, threadId)) break;
				} catch (error) {
					this.logger.error(`[thread-executor] ${threadId}: ${formatError(error)}`);
					// Reset any processing entries so they can be re-claimed on next attempt
					resetProcessingForThread(this.db, threadId);
					break;
				}
			}
		} finally {
			this.activeLocks.delete(threadId);
		}

		// Check if entries accumulated during the run that weren't drained.
		// Caller should re-trigger dispatch if true.
		return hasPending(this.db, threadId);
	}

	/**
	 * Race a promise against a timeout. If the timeout fires first,
	 * the promise is abandoned and an error is thrown.
	 */
	private withTimeout(
		promise: Promise<ExecutorRunResult>,
		threadId: string,
	): Promise<ExecutorRunResult> {
		if (this.runTimeoutMs <= 0) return promise;

		return new Promise<ExecutorRunResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`runFn timeout after ${this.runTimeoutMs}ms for thread ${threadId}`));
			}, this.runTimeoutMs);

			promise.then(
				(result) => {
					clearTimeout(timer);
					resolve(result);
				},
				(error) => {
					clearTimeout(timer);
					reject(error);
				},
			);
		});
	}
}
