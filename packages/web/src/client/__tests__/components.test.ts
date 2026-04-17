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

	it("TaskDetailView component module imports without error", async () => {
		const TaskDetailView = await import("../views/TaskDetailView.svelte");
		expect(TaskDetailView).toBeDefined();
	});
});
