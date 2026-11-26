import { TimeoutStrategy, isTaskCancelledError, timeout } from "cockatiel";

export const SILENCE_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Scale a silence timeout based on estimated context size. With a base timeout
 * sized for typical contexts, only very large contexts (100k+ tokens) need
 * additional time for cold-cache processing on the first chunk.
 */
export function scaledSilenceTimeout(baseMs: number, estimatedTokens: number): number {
	if (estimatedTokens <= 100_000) return baseMs;
	// Large context: add 1 minute per 50k tokens over 100k.
	const extraMs = Math.floor((estimatedTokens - 100_000) / 50_000) * 60_000;
	return baseMs + extraMs;
}

export async function* withSilenceTimeout<T>(
	source: AsyncIterable<T>,
	timeoutMs: number,
	onHeartbeat?: () => void,
	heartbeatIntervalMs: number = SILENCE_HEARTBEAT_INTERVAL_MS,
	onTimeout?: () => void,
): AsyncGenerator<T> {
	const iterator = source[Symbol.asyncIterator]();
	// Aggressive: the wait for the next chunk rejects at the deadline even when
	// the source ignores cancellation, which is the only way to break a stall.
	const chunkDeadline = timeout(timeoutMs, TimeoutStrategy.Aggressive);
	let innerFinalized = false;
	try {
		while (true) {
			const heartbeatId = onHeartbeat
				? setInterval(() => {
						try {
							onHeartbeat();
						} catch {
							// Heartbeat callbacks should never break the stream.
						}
					}, heartbeatIntervalMs)
				: null;

			let result: IteratorResult<T>;
			try {
				result = await chunkDeadline.execute(() => iterator.next());
			} catch (err) {
				// The policy has already cleared its deadline timer. Clear the
				// heartbeat before awaiting the source's return(): a slow or hung
				// return() must not keep heartbeating.
				if (heartbeatId) clearInterval(heartbeatId);
				const timedOut = isTaskCancelledError(err);
				// onTimeout runs only after the deadline has settled the wait, so a
				// caller that aborts its backend here cannot let a late chunk win.
				if (timedOut) onTimeout?.();
				innerFinalized = true;
				if (typeof iterator.return === "function") {
					await iterator.return(undefined).catch(() => {});
				}
				if (timedOut) {
					throw new Error(`LLM silence timeout: no chunk received for ${timeoutMs}ms`);
				}
				throw err;
			}
			if (heartbeatId) clearInterval(heartbeatId);

			if (result.done) {
				innerFinalized = true;
				return;
			}

			yield result.value;
		}
	} finally {
		if (!innerFinalized && typeof iterator.return === "function") {
			await iterator.return(undefined).catch(() => {});
		}
	}
}
