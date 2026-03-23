import { LLMError } from "./types";

export interface RetryConfig {
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
	maxRetries: 3,
	baseDelayMs: 1000,
	maxDelayMs: 30000,
};

/**
 * Wraps an async operation with retry logic.
 * - 429 (rate limit) errors: retry with exponential backoff, max retries = maxRetries
 * - Connection errors: retry once
 * - Other errors: throw immediately (no retry)
 */
export async function withRetry<T>(
	fn: () => Promise<T>,
	config: Partial<RetryConfig> = {},
): Promise<T> {
	const { maxRetries, baseDelayMs, maxDelayMs } = { ...DEFAULT_RETRY_CONFIG, ...config };
	let lastError: Error | undefined;
	let attempt = 0;

	while (attempt <= maxRetries) {
		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			// Check if it's an LLMError with a status code
			const isRateLimit = error instanceof LLMError && error.statusCode === 429;
			const isConnectionError =
				error instanceof LLMError && error.statusCode === undefined && error.originalError;

			// Connection errors: retry once (attempt 0 → 1)
			if (isConnectionError && attempt === 0) {
				attempt++;
				const delay = Math.min(baseDelayMs, maxDelayMs);
				await sleep(delay);
				continue;
			}

			// Rate limit errors: retry with exponential backoff
			if (isRateLimit && attempt < maxRetries) {
				attempt++;
				const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
				await sleep(delay);
				continue;
			}

			// All other errors or max retries reached: throw
			throw error;
		}
	}

	// Should never reach here, but TypeScript needs it
	throw lastError || new Error("Retry logic failed unexpectedly");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
