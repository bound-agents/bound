import { afterEach, beforeEach, describe, expect, it } from "bun:test";

describe("Component Tests", () => {
	it("MessageBubble component module imports without error", async () => {
		const MessageBubble = await import("../components/MessageBubble.svelte");
		expect(MessageBubble).toBeDefined();
	});

	it("TopBar component module imports without error", async () => {
		const TopBar = await import("../components/TopBar.svelte");
		expect(TopBar).toBeDefined();
	});

	it("ModelSelector component module imports without error", async () => {
		const ModelSelector = await import("../components/ModelSelector.svelte");
		expect(ModelSelector).toBeDefined();
	});

	it("TaskDetailView component module imports without error", async () => {
		const TaskDetailView = await import("../views/TaskDetailView.svelte");
		expect(TaskDetailView).toBeDefined();
	});
});

describe("api.sendMessage", () => {
	let capturedBody: unknown;
	const originalFetch = global.fetch;

	beforeEach(() => {
		(global as any).fetch = async (_url: string, opts: RequestInit) => {
			capturedBody = JSON.parse(opts.body as string);
			return { ok: true, json: async () => ({ id: "msg-1", content: "ok" }) } as Response;
		};
	});

	afterEach(() => {
		global.fetch = originalFetch;
	});

	it("includes file_ids in request body when fileId is provided", async () => {
		const { api } = await import("../lib/api");
		await api.sendMessage("thread-1", "hello", undefined, "file-abc");
		expect((capturedBody as { file_ids?: string[] }).file_ids).toEqual(["file-abc"]);
	});

	it("omits file_ids when no fileId is provided", async () => {
		const { api } = await import("../lib/api");
		await api.sendMessage("thread-1", "hello");
		expect((capturedBody as Record<string, unknown>).file_ids).toBeUndefined();
	});
});
