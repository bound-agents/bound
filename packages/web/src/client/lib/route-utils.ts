/**
 * Pure route parsing utilities — no svelte/browser dependencies, fully testable.
 */

export function parseLineRoute(route: string): { threadId: string; from?: string } {
	const [path, queryStr] = route.split("?");
	const threadId = path.split("/")[2] ?? "";
	const fromParam = queryStr ? new URLSearchParams(queryStr).get("from") : null;
	const from = fromParam || undefined;
	return { threadId, from };
}
