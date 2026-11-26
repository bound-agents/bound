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
	let innerFinalized = false;
	try {
		while (true) {
			const nextChunkPromise = iterator.next();
			let timerId: ReturnType<typeof setTimeout> | null = null;
			let heartbeatId: ReturnType<typeof setInterval> | null = null;
			const timeoutPromise = new Promise<never>((_, reject) => {
				timerId = setTimeout(() => {
					onTimeout?.();
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

			const clearTimers = () => {
				if (timerId) clearTimeout(timerId);
				if (heartbeatId) clearInterval(heartbeatId);
			};

			let result: IteratorResult<T>;
			try {
				result = await Promise.race([nextChunkPromise, timeoutPromise]);
			} catch (err) {
				// Clear before awaiting the source's return(): a slow or hung return()
				// must not keep heartbeating or let the pending timeout fire onTimeout().
				clearTimers();
				innerFinalized = true;
				if (typeof iterator.return === "function") {
					await iterator.return(undefined).catch(() => {});
				}
				throw err;
			}
			clearTimers();

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
