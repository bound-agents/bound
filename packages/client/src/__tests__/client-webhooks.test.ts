import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { BoundClient } from "../client.js";
import type {
	CreateWebhookOptions,
	UpdateWebhookOptions,
	WebhookCreateResponse,
	WebhookListEntry,
	WebhookRotateResponse,
	WebhookUrlsResponse,
} from "../types.js";

describe("BoundClient webhook methods", () => {
	const baseUrl = "http://bound-client-webhook-test.invalid";
	let originalFetch: typeof fetch;
	let mockFetch: ReturnType<typeof mock>;

	const webhookEntry: WebhookListEntry = {
		id: "test-id",
		name: "test-webhook",
		signature_format: "github",
		description: null,
		task_id: "task-123",
		thread_id: "thread-456",
		created_at: "2026-05-17T00:00:00Z",
		modified_at: "2026-05-17T00:00:00Z",
		prompt: null,
		model_hint: null,
		no_history: false,
	};

	beforeAll(() => {
		originalFetch = global.fetch;
	});

	afterAll(() => {
		global.fetch = originalFetch;
	});

	beforeEach(() => {
		mockFetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify(webhookEntry), {
					headers: { "Content-Type": "application/json" },
				}),
			),
		);
		global.fetch = mockFetch as unknown as typeof fetch;
	});

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
			prompt: null,
			model_hint: null,
			no_history: false,
		};
		expect(listEntry.id).toBe("test-id");
	});

	it("has webhook CRUD methods", () => {
		const client = new BoundClient(baseUrl);
		expect(typeof client.listWebhooks).toBe("function");
		expect(typeof client.getWebhook).toBe("function");
		expect(typeof client.createWebhook).toBe("function");
		expect(typeof client.updateWebhook).toBe("function");
		expect(typeof client.deleteWebhook).toBe("function");
		expect(typeof client.rotateWebhookSecret).toBe("function");
		expect(typeof client.listWebhookUrls).toBe("function");
	});

	it("listWebhooks fetches /api/webhooks", async () => {
		const client = new BoundClient(baseUrl);
		mockFetch.mockImplementation(() =>
			Promise.resolve(
				new Response(JSON.stringify([webhookEntry]), {
					headers: { "Content-Type": "application/json" },
				}),
			),
		);

		const result: WebhookListEntry[] = await client.listWebhooks();

		expect(result).toEqual([webhookEntry]);
		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url] = mockFetch.mock.calls[0] as [string];
		expect(url).toBe(`${baseUrl}/api/webhooks`);
	});

	it("getWebhook fetches /api/webhooks/:id", async () => {
		const client = new BoundClient(baseUrl);

		const result: WebhookListEntry = await client.getWebhook("test-id");

		expect(result).toEqual(webhookEntry);
		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url] = mockFetch.mock.calls[0] as [string];
		expect(url).toBe(`${baseUrl}/api/webhooks/test-id`);
	});

	it("createWebhook posts options and returns WebhookCreateResponse with secret", async () => {
		const client = new BoundClient(baseUrl);
		const options: CreateWebhookOptions = {
			name: "test",
			format: "github",
			description: "test webhook",
			prompt: "Handle GitHub events",
			model_hint: "opus",
			no_history: true,
		};
		const created = { ...webhookEntry, secret: "secret-123" };
		mockFetch.mockImplementation(() =>
			Promise.resolve(
				new Response(JSON.stringify(created), {
					status: 201,
					headers: { "Content-Type": "application/json" },
				}),
			),
		);

		const result: WebhookCreateResponse = await client.createWebhook(options);

		expect(result).toEqual(created);
		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${baseUrl}/api/webhooks`);
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({ "Content-Type": "application/json" });
		expect(JSON.parse(init.body as string)).toEqual(options);
	});

	it("updateWebhook patches options and returns WebhookListEntry", async () => {
		const client = new BoundClient(baseUrl);
		const options: UpdateWebhookOptions = {
			description: "updated",
			prompt: "new prompt",
			format: "generic",
			model_hint: null,
			no_history: false,
		};
		const updated = { ...webhookEntry, description: "updated", prompt: "new prompt" };
		mockFetch.mockImplementation(() =>
			Promise.resolve(
				new Response(JSON.stringify(updated), {
					headers: { "Content-Type": "application/json" },
				}),
			),
		);

		const result: WebhookListEntry = await client.updateWebhook("test-id", options);

		expect(result).toEqual(updated);
		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${baseUrl}/api/webhooks/test-id`);
		expect(init.method).toBe("PATCH");
		expect(init.headers).toEqual({ "Content-Type": "application/json" });
		expect(JSON.parse(init.body as string)).toEqual(options);
	});

	it("rotateWebhookSecret posts to /api/webhooks/:id/rotate and returns secret", async () => {
		const client = new BoundClient(baseUrl);
		mockFetch.mockImplementation(() =>
			Promise.resolve(
				new Response(JSON.stringify({ secret: "rotated-secret" }), {
					headers: { "Content-Type": "application/json" },
				}),
			),
		);

		const result: WebhookRotateResponse = await client.rotateWebhookSecret("test-id");

		expect(result).toEqual({ secret: "rotated-secret" });
		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${baseUrl}/api/webhooks/test-id/rotate`);
		expect(init.method).toBe("POST");
	});

	it("deleteWebhook deletes /api/webhooks/:id", async () => {
		const client = new BoundClient(baseUrl);
		mockFetch.mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));

		const result: undefined = await client.deleteWebhook("test-id");

		expect(result).toBeUndefined();
		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${baseUrl}/api/webhooks/test-id`);
		expect(init.method).toBe("DELETE");
	});

	it("listWebhookUrls fetches /api/webhooks/:id/urls", async () => {
		const client = new BoundClient(baseUrl);
		const urls: WebhookUrlsResponse = {
			name: "test-webhook",
			urls: [{ url: "https://example.com/webhook/test-webhook", source: "hub" }],
		};
		mockFetch.mockImplementation(() =>
			Promise.resolve(
				new Response(JSON.stringify(urls), {
					headers: { "Content-Type": "application/json" },
				}),
			),
		);

		const result: WebhookUrlsResponse = await client.listWebhookUrls("test-id");

		expect(result).toEqual(urls);
		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url] = mockFetch.mock.calls[0] as [string];
		expect(url).toBe(`${baseUrl}/api/webhooks/test-id/urls`);
	});
	describe("connector binding methods", () => {
		it("has connector binding methods", () => {
			const client = new BoundClient(baseUrl);
			expect(typeof client.listConnectorBindings).toBe("function");
			expect(typeof client.detachConnectorBinding).toBe("function");
		});

		it("listConnectorBindings fetches /api/connectors/bindings", async () => {
			const client = new BoundClient(baseUrl);
			const body = { bindings: [] };
			mockFetch.mockImplementation(() =>
				Promise.resolve(
					new Response(JSON.stringify(body), {
						headers: { "Content-Type": "application/json" },
					}),
				),
			);

			const result = await client.listConnectorBindings();

			expect(result).toEqual(body);
			expect(mockFetch).toHaveBeenCalledTimes(1);
			const [url] = mockFetch.mock.calls[0] as [string];
			expect(url).toBe(`${baseUrl}/api/connectors/bindings`);
		});

		it("detachConnectorBinding deletes /api/connectors/bindings/:id", async () => {
			const client = new BoundClient(baseUrl);
			mockFetch.mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));

			const result: undefined = await client.detachConnectorBinding("handle-1");

			expect(result).toBeUndefined();
			expect(mockFetch).toHaveBeenCalledTimes(1);
			const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
			expect(url).toBe(`${baseUrl}/api/connectors/bindings/handle-1`);
			expect(init.method).toBe("DELETE");
		});
	});
});
