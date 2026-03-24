export function formatError(error: unknown, fallback = "Unknown error"): string {
	return error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
}
