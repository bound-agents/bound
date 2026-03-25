import type { RelayInboxEntry, RelayOutboxEntry } from "@bound/shared";

/**
 * Callback for executing relay requests locally on the hub.
 * Phase 4 provides the real implementation that dispatches to local MCP clients.
 * Returns inbox entries (results/errors) to send back to the requester,
 * or an empty array if the request kind is not supported yet.
 */
export type RelayExecutor = (
	request: RelayOutboxEntry,
	hubSiteId: string,
) => Promise<RelayInboxEntry[]>;

/**
 * Default no-op executor that returns an error for all requests.
 * Used until Phase 4 provides a real implementation.
 */
export const noopRelayExecutor: RelayExecutor = async (request, hubSiteId) => {
	const now = new Date().toISOString();
	return [
		{
			id: crypto.randomUUID(),
			source_site_id: hubSiteId,
			kind: "error",
			ref_id: request.id,
			idempotency_key: null,
			payload: JSON.stringify({
				error: "Hub-local relay execution not yet implemented",
				retriable: false,
			}),
			expires_at: request.expires_at,
			received_at: now,
			processed: 0,
		},
	];
};
