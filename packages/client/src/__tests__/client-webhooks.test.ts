import { describe, expect, it } from "bun:test";
import { BoundClient } from "../client.js";
import type {
	CreateWebhookOptions,
	UpdateWebhookOptions,
	WebhookCreateResponse,
	WebhookListEntry,
	WebhookRotateResponse,
} from "../types.js";

describe("BoundClient webhook methods", () => {
	const client = new BoundClient("http://localhost:3001");

	it("exports webhook types", () => {
		// This test verifies types are exported correctly
		const listEntry: WebhookListEntry = {
			id: "test-id",
			name: "test-webhook",
			signature_format: "github",
			description: null,
			task_id: "task-123",
			thread_id: "thread-456",
			created_at: "2026-05-17T00:00:00Z",
			modified_at: "2026-05-17T00:00:00Z",
		};
		expect(listEntry.id).toBe("test-id");
	});

	it("has webhook CRUD methods", () => {
		expect(typeof client.listWebhooks).toBe("function");
		expect(typeof client.getWebhook).toBe("function");
		expect(typeof client.createWebhook).toBe("function");
		expect(typeof client.updateWebhook).toBe("function");
		expect(typeof client.deleteWebhook).toBe("function");
		expect(typeof client.rotateWebhookSecret).toBe("function");
	});

	it("listWebhooks returns WebhookListEntry[]", () => {
		// Type check: this should compile if the return type is correct
		const promise: Promise<WebhookListEntry[]> = client.listWebhooks();
		expect(promise).toBeDefined();
	});

	it("createWebhook returns WebhookCreateResponse with secret", () => {
		const options: CreateWebhookOptions = {
			name: "test",
			format: "github",
			description: "test webhook",
			prompt: "Handle GitHub events",
		};
		const promise: Promise<WebhookCreateResponse> = client.createWebhook(options);
		expect(promise).toBeDefined();
	});

	it("updateWebhook accepts UpdateWebhookOptions", () => {
		const options: UpdateWebhookOptions = {
			description: "updated",
			prompt: "new prompt",
			format: "generic",
		};
		const promise: Promise<WebhookListEntry> = client.updateWebhook("id", options);
		expect(promise).toBeDefined();
	});

	it("rotateWebhookSecret returns secret", () => {
		const promise: Promise<WebhookRotateResponse> = client.rotateWebhookSecret("id");
		expect(promise).toBeDefined();
	});

	it("deleteWebhook returns void", () => {
		const promise: Promise<void> = client.deleteWebhook("id");
		expect(promise).toBeDefined();
	});
});
