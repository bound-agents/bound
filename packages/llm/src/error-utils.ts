import { formatError } from "@bound/shared";
import { LLMError } from "./types";

export function wrapFetchError(error: unknown, provider: string, endpoint: string): LLMError {
	return new LLMError(
		`Failed to connect to ${provider} at ${endpoint}: ${formatError(error)}`,
		provider,
		undefined,
		error instanceof Error ? error : new Error(String(error)),
	);
}

export async function checkHttpError(response: Response, provider: string): Promise<void> {
	if (!response.ok) {
		const body = await response.text();
		let retryAfterMs: number | undefined;

		// Parse Retry-After header for 429/529 responses
		if (response.status === 429 || response.status === 529) {
			const retryAfterHeader = response.headers.get("Retry-After");
			if (retryAfterHeader) {
				const retrySeconds = Number(retryAfterHeader);
				if (!Number.isNaN(retrySeconds)) {
					retryAfterMs = retrySeconds * 1000;
				} else {
					// Non-numeric Retry-After (date format) — use default
					retryAfterMs = 60_000;
				}
			} else {
				retryAfterMs = 60_000;
			}
		}

		throw new LLMError(
			`${provider} request failed with status ${response.status}: ${body}`,
			provider,
			response.status,
			undefined,
			retryAfterMs,
		);
	}
}
