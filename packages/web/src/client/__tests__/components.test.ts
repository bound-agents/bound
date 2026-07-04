import { describe, expect, it } from "bun:test";

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

	it("MessageList component module imports without error", async () => {
		const MessageList = await import("../components/MessageList.svelte");
		expect(MessageList).toBeDefined();
	});

	it("LineView component module imports without error", async () => {
		const LineView = await import("../views/LineView.svelte");
		expect(LineView).toBeDefined();
	});
	it("ConnectorBindingsView module imports without error", async () => {
		const ConnectorBindingsView = await import("../views/ConnectorBindingsView.svelte");
		expect(ConnectorBindingsView).toBeDefined();
	});
});
