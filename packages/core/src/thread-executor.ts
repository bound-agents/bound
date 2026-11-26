import type { Database } from "bun:sqlite";
import type { Logger } from "@bound/shared";
import { formatError } from "@bound/shared";
import {
	hasPending,
	resetProcessingDurableDispatchForThread,
	resetProcessingForThread,
} from "./dispatch";

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
	 *  executor requests cancellation. The lock remains held until the
	 *  callback settles so a late callback cannot overlap a replacement run. */
	runTimeoutMs?: number;
}

class ExecutorTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExecutorTimeoutError";
	}
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
	 * @param runFn - Inference callback; receives shouldYield and an abort signal
	 *   that fires when the executor timeout is reached
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
		runFn: (shouldYield: () => boolean, abortSignal: AbortSignal) => Promise<ExecutorRunResult>,
		onComplete?: (result: ExecutorRunResult) => Promise<void>,
		onTimeout?: (error: Error) => boolean | undefined,
	): Promise<boolean> {
		if (this.activeLocks.has(threadId)) return false;
		this.activeLocks.add(threadId);

		try {
			while (true) {
				const shouldYield = () => hasPending(this.db, threadId);
				const abortController = new AbortController();
				const runPromise = Promise.resolve().then(() => runFn(shouldYield, abortController.signal));
				let retryAfterTimeout = true;

				try {
					const result = await this.withTimeout(runPromise, threadId, abortController, (error) => {
						this.logger.error(
							`[thread-executor] ${threadId}: ${formatError(error)}; cancellation requested, lock retained until runFn settles`,
							{ threadId, runTimeoutMs: this.runTimeoutMs },
						);
						try {
							retryAfterTimeout = onTimeout?.(error) !== false;
						} catch (handlerError) {
							this.logger.error(
								`[thread-executor] ${threadId}: timeout handler failed: ${formatError(handlerError)}`,
							);
						}
					});

					if (result.yielded) {
						resetProcessingForThread(this.db, threadId);
						resetProcessingDurableDispatchForThread(this.db, threadId);
						continue;
					}

					if (onComplete) await onComplete(result);
					if (!hasPending(this.db, threadId)) break;
				} catch (error) {
					// A timeout only requests cancellation. Keep the executor lock until
					// the callback settles so a late callback cannot overlap a replacement
					// run or acknowledge work claimed by that replacement.
					if (error instanceof ExecutorTimeoutError) {
						await runPromise.catch(() => undefined);
						if (!retryAfterTimeout) break;
					} else {
						this.logger.error(`[thread-executor] ${threadId}: ${formatError(error)}`);
					}
					// Reset any processing entries so they can be re-claimed on next attempt
					resetProcessingForThread(this.db, threadId);
					resetProcessingDurableDispatchForThread(this.db, threadId);
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
	 * Race a promise against a timeout. If the timeout fires first, request
	 * cancellation and reject; the caller still waits for the original callback
	 * to settle before releasing the thread lock.
	 */
	private withTimeout(
		promise: Promise<ExecutorRunResult>,
		threadId: string,
		abortController: AbortController,
		onTimeout: (error: ExecutorTimeoutError) => void,
	): Promise<ExecutorRunResult> {
		if (this.runTimeoutMs <= 0) return promise;

		return new Promise<ExecutorRunResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				const error = new ExecutorTimeoutError(
					`runFn timeout after ${this.runTimeoutMs}ms for thread ${threadId}`,
				);
				abortController.abort(error);
				onTimeout(error);
				reject(error);
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
