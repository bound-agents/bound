import type { Database } from "bun:sqlite";
import type { Logger } from "@bound/shared";
import { hasPending, resetProcessingForThread } from "./dispatch";
import { formatError } from "@bound/shared";

export interface ExecutorRunResult {
	yielded?: boolean;
	error?: string;
	[key: string]: unknown;
}

export class ThreadExecutor {
	private activeLocks = new Set<string>();

	constructor(
		private db: Database,
		private logger: Logger,
	) {}

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
	async execute(
		threadId: string,
		runFn: (shouldYield: () => boolean) => Promise<ExecutorRunResult>,
		onComplete?: (result: ExecutorRunResult) => Promise<void>,
	): Promise<void> {
		if (this.activeLocks.has(threadId)) return;
		this.activeLocks.add(threadId);

		try {
			while (true) {
				const shouldYield = () => hasPending(this.db, threadId);

				try {
					const result = await runFn(shouldYield);

					if (result.yielded) {
						resetProcessingForThread(this.db, threadId);
						continue;
					}

					if (onComplete) await onComplete(result);
					if (!hasPending(this.db, threadId)) break;
				} catch (error) {
					this.logger.error(`[thread-executor] ${threadId}: ${formatError(error)}`);
					break;
				}
			}
		} finally {
			this.activeLocks.delete(threadId);
		}
	}
}
