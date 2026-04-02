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
		try {
			const platform = c.req.param("platform");

			// Validate platform parameter (alphanumeric + hyphens only)
			if (!/^[a-z0-9-]+$/.test(platform)) {
				return c.text("Bad Request", 400);
			}

			// Guard against oversized payloads (1 MB limit)
			const contentLength = Number(c.req.header("content-length") ?? 0);
			if (contentLength > 1_048_576) {
				return c.text("Payload Too Large", 413);
			}

			const rawBody = await c.req.text();
			if (rawBody.length > 1_048_576) {
				return c.text("Payload Too Large", 413);
			}

			const headers: Record<string, string> = {};
			for (const [key, value] of Object.entries(c.req.header())) {
				if (value !== undefined) {
					headers[key] = value;
				}
			}

			eventBus.emit("platform:webhook", { platform, rawBody, headers });

			return c.text("OK", 200);
		} catch {
			return c.text("Internal Server Error", 500);
		}
	});

	return app;
}
