/**
 * Pure route parsing utilities — no svelte/browser dependencies, fully testable.
 */

/**
 * Returns the route string for navigating to a thread (line).
 * e.g. lineRoute("abc") → "/line/abc"
 * Use as href={`#${lineRoute(thread.id)}`} on anchor elements.
 */
export function lineRoute(threadId: string): string {
	return `/line/${threadId}`;
}

/**
 * Returns the route string for navigating to a task detail view.
 * e.g. taskRoute("abc") → "/task/abc"
 */
export function taskRoute(taskId: string): string {
	return `/task/${taskId}`;
}

/**
 * Extracts the taskId from a `/task/:taskId` route.
 */
export function parseTaskRoute(route: string): { taskId: string } {
	const parts = route.split("?");
	const taskId = parts[0].split("/")[2] ?? "";
	return { taskId };
}

export function parseLineRoute(route: string): { threadId: string; from?: string } {
	const [path, queryStr] = route.split("?");
	const threadId = path.split("/")[2] ?? "";
	const fromParam = queryStr ? new URLSearchParams(queryStr).get("from") : null;
	const from = fromParam || undefined;
	return { threadId, from };
}
