import type { TypedEventEmitter } from "@bound/shared";
import { Hono } from "hono";

/**
 * Generic webhook ingress for exclusive-delivery platform connectors.
 * Receives platform webhook payloads (Telegram, Slack, etc.) and emits
 * "platform:webhook" on the eventBus for connectors to handle.
 *
 * No authentication middleware — platform-specific signature verification
 * is handled by each connector's handleWebhookPayload() implementation.
 */
export function createWebhookRoutes(eventBus: TypedEventEmitter): Hono {
	const app = new Hono();

	app.post("/:platform", async (c) => {
		const platform = c.req.param("platform");
		const rawBody = await c.req.text();
		const headers: Record<string, string> = {};

		for (const [key, value] of Object.entries(c.req.header())) {
			if (value !== undefined) {
				headers[key] = value;
			}
		}

		eventBus.emit("platform:webhook", { platform, rawBody, headers });

		return c.text("OK", 200);
	});

	return app;
}
