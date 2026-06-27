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

/**
 * Scale the max number of silence-timeout retries. With long timeouts each retry
 * is expensive, so the count is kept flat regardless of context size to avoid
 * multi-hour stalls; callers pass the base ceiling they want enforced.
 */
export function scaledMaxRetries(_estimatedTokens: number, maxRetries: number): number {
	return maxRetries;
}

export async function* withSilenceTimeout<T>(
	source: AsyncIterable<T>,
	timeoutMs: number,
	onHeartbeat?: () => void,
	heartbeatIntervalMs: number = SILENCE_HEARTBEAT_INTERVAL_MS,
): AsyncGenerator<T> {
	const iterator = source[Symbol.asyncIterator]();
	let innerFinalized = false;
	try {
		while (true) {
			const nextChunkPromise = iterator.next();
			let timerId: ReturnType<typeof setTimeout> | null = null;
			let heartbeatId: ReturnType<typeof setInterval> | null = null;
			const timeoutPromise = new Promise<never>((_, reject) => {
				timerId = setTimeout(() => {
					reject(new Error(`LLM silence timeout: no chunk received for ${timeoutMs}ms`));
				}, timeoutMs);
			});
			if (onHeartbeat) {
				heartbeatId = setInterval(() => {
					try {
						onHeartbeat();
					} catch {
						// Heartbeat callbacks should never break the stream.
					}
				}, heartbeatIntervalMs);
			}

			let result: IteratorResult<T>;
			try {
				result = await Promise.race([nextChunkPromise, timeoutPromise]);
				if (timerId) clearTimeout(timerId);
				if (heartbeatId) clearInterval(heartbeatId);
			} catch (err) {
				if (timerId) clearTimeout(timerId);
				if (heartbeatId) clearInterval(heartbeatId);
				innerFinalized = true;
				if (typeof iterator.return === "function") {
					await iterator.return(undefined).catch(() => {});
				}
				throw err;
			}

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
