import type { PlatformConnector } from "../connector.js";

/**
 * Stub connector that validates the exclusive-delivery contract.
 * Exists solely to test that PlatformLeaderElection and PlatformConnectorRegistry
 * correctly handle exclusive-delivery connectors (webhook URL rotation on leader promotion).
 *
 * @remarks DELETE when first real exclusive-delivery connector (Slack, Telegram, etc.) ships.
 * @see docs/design-plans/2026-03-27-platform-connectors.md
 */
export class WebhookStubConnector implements PlatformConnector {
	readonly platform = "webhook-stub";
	readonly delivery = "exclusive" as const;

	async connect(_hostBaseUrl?: string): Promise<void> {
		// no-op — stub only
	}

	async disconnect(): Promise<void> {
		// no-op — stub only
	}

	async deliver(
		_threadId: string,
		_messageId: string,
		_content: string,
		_attachments?: unknown[],
	): Promise<void> {
		throw new Error("not implemented — stub only");
	}

	async handleWebhookPayload(_rawBody: string, _headers: Record<string, string>): Promise<void> {
		// no-op — stub only
	}
}
