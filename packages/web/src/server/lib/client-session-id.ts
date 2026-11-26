/** `client_sessions.id` is `${connectionId}::${threadId}`; the reaper parses it back. */
const SEPARATOR = "::";

export function formatClientSessionId(connectionId: string, threadId: string): string {
	return `${connectionId}${SEPARATOR}${threadId}`;
}

export function parseClientSessionId(id: string): { connectionId: string; threadId: string } {
	const at = id.indexOf(SEPARATOR);
	if (at === -1) return { connectionId: id, threadId: "" };
	return { connectionId: id.slice(0, at), threadId: id.slice(at + SEPARATOR.length) };
}
