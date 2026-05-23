import { describe, expect, it } from "bun:test";
import { getWebhookEndpointUrl } from "../lib/webhook-utils";

describe("getWebhookEndpointUrl", () => {
	it("constructs endpoint URL from id and origin", () => {
		expect(getWebhookEndpointUrl("abc123", "https://example.com")).toBe(
			"https://example.com/api/webhooks/abc123",
		);
	});

	it("works with localhost origins", () => {
		expect(getWebhookEndpointUrl("def456", "http://localhost:8080")).toBe(
			"http://localhost:8080/api/webhooks/def456",
		);
	});

	it("strips trailing slash from origin", () => {
		expect(getWebhookEndpointUrl("xyz789", "https://example.com/")).toBe(
			"https://example.com/api/webhooks/xyz789",
		);
	});
});
