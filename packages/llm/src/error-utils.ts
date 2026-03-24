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
		throw new LLMError(
			`${provider} request failed with status ${response.status}: ${body}`,
			provider,
			response.status,
		);
	}
}
