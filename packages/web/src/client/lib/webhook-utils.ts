/**
 * Constructs the full webhook endpoint URL for a given webhook ID.
 * This is the URL users should configure in external services (e.g. GitHub webhooks).
 */
export function getWebhookEndpointUrl(id: string, origin: string): string {
	const base = origin.endsWith("/") ? origin.slice(0, -1) : origin;
	return `${base}/api/webhooks/${id}`;
}
