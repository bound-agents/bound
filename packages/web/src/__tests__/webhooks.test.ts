import { describe, expect, it } from "bun:test";
import { TypedEventEmitter } from "@bound/shared";
import { createWebhookRoutes } from "../server/routes/webhooks";

describe("platform-connectors Phase 4 — webhook route", () => {
	it("AC7.3: POST /hooks/discord returns 200 and emits platform:webhook", async () => {
		const eventBus = new TypedEventEmitter();
		const emittedEvents: Array<{
			platform: string;
			rawBody: string;
			headers: Record<string, string>;
		}> = [];

		// Listen for platform:webhook events
		eventBus.on("platform:webhook", (payload) => {
			emittedEvents.push(payload);
		});

		const app = createWebhookRoutes(eventBus);

		// Make POST request to /discord
		const res = await app.request("/discord", {
			method: "POST",
			body: '{"type":"MESSAGE_CREATE"}',
			headers: { "Content-Type": "application/json" },
		});

		// Assert: response status is 200
		expect(res.status).toBe(200);

		// Assert: response body is OK
		const text = await res.text();
		expect(text).toBe("OK");

		// Assert: platform:webhook was emitted with correct payload
		expect(emittedEvents).toHaveLength(1);
		expect(emittedEvents[0].platform).toBe("discord");
		expect(emittedEvents[0].rawBody).toBe('{"type":"MESSAGE_CREATE"}');
	});

	it("AC7.3: POST /hooks/telegram returns 200 and emits platform:webhook", async () => {
		const eventBus = new TypedEventEmitter();
		const emittedEvents: Array<{ platform: string; rawBody: string }> = [];

		eventBus.on("platform:webhook", (payload) => {
			emittedEvents.push(payload);
		});

		const app = createWebhookRoutes(eventBus);

		const res = await app.request("/telegram", {
			method: "POST",
			body: '{"update_id":123}',
			headers: { "Content-Type": "application/json" },
		});

		expect(res.status).toBe(200);
		expect(emittedEvents).toHaveLength(1);
		expect(emittedEvents[0].platform).toBe("telegram");
		expect(emittedEvents[0].rawBody).toBe('{"update_id":123}');
	});

	it("AC7.3: includes headers in platform:webhook event", async () => {
		const eventBus = new TypedEventEmitter();
		let emittedPayload: {
			platform: string;
			rawBody: string;
			headers: Record<string, string>;
		} | null = null;

		eventBus.on("platform:webhook", (payload) => {
			emittedPayload = payload;
		});

		const app = createWebhookRoutes(eventBus);

		const res = await app.request("/slack", {
			method: "POST",
			body: '{"type":"event_callback"}',
			headers: {
				"Content-Type": "application/json",
				"X-Slack-Request-Timestamp": "1234567890",
				"X-Slack-Signature": "v0=abc123",
			},
		});

		expect(res.status).toBe(200);
		expect(emittedPayload).not.toBeNull();
		expect(emittedPayload?.platform).toBe("slack");
		expect(emittedPayload?.headers["x-slack-request-timestamp"]).toBe("1234567890");
		expect(emittedPayload?.headers["x-slack-signature"]).toBe("v0=abc123");
	});

	it("AC7.3: handles empty body", async () => {
		const eventBus = new TypedEventEmitter();
		const emittedEvents: Array<{ rawBody: string }> = [];

		eventBus.on("platform:webhook", (payload) => {
			emittedEvents.push(payload);
		});

		const app = createWebhookRoutes(eventBus);

		const res = await app.request("/discord", {
			method: "POST",
			body: "",
		});

		expect(res.status).toBe(200);
		expect(emittedEvents).toHaveLength(1);
		expect(emittedEvents[0].rawBody).toBe("");
	});
});
