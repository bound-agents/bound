import { describe, expect, it, vi } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { ChatView, type ChatViewProps } from "../tui/views/ChatView";

/** Let React effects flush */
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

function makeProps(overrides: Partial<ChatViewProps> = {}): ChatViewProps {
	return {
		client: null,
		threadId: "thread-123",
		model: "gpt-4",
		connectionState: "connected",
		messages: [],
		inFlightTools: new Map(),
		mcpServerCount: 0,
		bannerMessage: null,
		bannerType: null,
		ctrlCHint: null,
		isProcessing: false,
		onModelChange: vi.fn(),
		onModelPicker: vi.fn(),
		onAttachThread: vi.fn(),
		onMcpView: vi.fn(),
		onClear: vi.fn(),
		onBannerDismiss: vi.fn(),
		onSendMessage: vi.fn(),
		...overrides,
	};
}

async function typeAndSubmit(stdin: NodeJS.WritableStream, text: string) {
	stdin.write(text);
	await tick();
	// Carriage return submits the TextInput
	stdin.write("\r");
	await tick();
}

describe("ChatView slash commands", () => {
	it("bare /model opens the model picker", async () => {
		const onModelPicker = vi.fn();
		const onModelChange = vi.fn();
		const props = makeProps({ onModelPicker, onModelChange });

		const { stdin } = render(React.createElement(ChatView, props));
		await tick();

		await typeAndSubmit(stdin, "/model");

		expect(onModelPicker).toHaveBeenCalledTimes(1);
		expect(onModelChange).not.toHaveBeenCalled();
	});

	it("/model <name> sets the model directly without opening picker", async () => {
		const onModelPicker = vi.fn();
		const onModelChange = vi.fn();
		const props = makeProps({ onModelPicker, onModelChange });

		const { stdin } = render(React.createElement(ChatView, props));
		await tick();

		await typeAndSubmit(stdin, "/model claude-sonnet");

		expect(onModelChange).toHaveBeenCalledTimes(1);
		expect(onModelChange).toHaveBeenCalledWith("claude-sonnet");
		expect(onModelPicker).not.toHaveBeenCalled();
	});

	it("bare /attach opens the thread picker", async () => {
		const onAttachThread = vi.fn();
		const props = makeProps({ onAttachThread });

		const { stdin } = render(React.createElement(ChatView, props));
		await tick();

		await typeAndSubmit(stdin, "/attach");

		expect(onAttachThread).toHaveBeenCalledTimes(1);
	});

	it("/help lists /model without requiring an argument", async () => {
		const props = makeProps();
		const { stdin, lastFrame } = render(React.createElement(ChatView, props));
		await tick();

		await typeAndSubmit(stdin, "/help");

		const frame = lastFrame() ?? "";
		// Help entry for /model should not make <name> look required.
		// Accept either "/model" alone or "/model [name]" (optional-arg convention).
		expect(frame).toContain("/model");
		expect(frame).not.toContain("/model <name>");
	});
});
