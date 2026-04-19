import { describe, expect, it } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import { useScrollableMessages } from "../tui/hooks/useScrollableMessages";

/** Let React effects flush */
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

function makeMessages(count: number) {
	return Array.from({ length: count }, (_, i) => ({
		id: `msg-${i}`,
		role: "user" as const,
		content: `Message ${i}`,
		thread_id: "t-1",
		created_at: new Date(Date.now() + i * 1000).toISOString(),
	}));
}

/**
 * Test harness that exposes scroll state and renders visible messages.
 */
function ScrollHarness({
	messages,
	viewportHeight = 12,
}: {
	messages: Array<{
		id: string;
		role: string;
		content: string;
		thread_id: string;
		created_at: string;
	}>;
	viewportHeight?: number;
}) {
	const scroll = useScrollableMessages(messages, viewportHeight);

	return React.createElement(
		React.Fragment,
		null,
		React.createElement(
			Text,
			null,
			`visible:${scroll.visibleMessages.length} offset:${scroll.scrollOffset} bottom:${scroll.isAtBottom} hidden:${scroll.hiddenAbove}`,
		),
		...scroll.visibleMessages.map((msg) => React.createElement(Text, { key: msg.id }, msg.content)),
	);
}

describe("useScrollableMessages", () => {
	it("shows all messages when they fit in viewport", async () => {
		const messages = makeMessages(3);
		const { lastFrame } = render(
			React.createElement(ScrollHarness, { messages, viewportHeight: 20 }),
		);
		await tick();

		const frame = lastFrame();
		expect(frame).toContain("visible:3");
		expect(frame).toContain("offset:0");
		expect(frame).toContain("bottom:true");
		expect(frame).toContain("hidden:0");
	});

	it("shows only the most recent messages when there are more than viewport fits", async () => {
		const messages = makeMessages(20);
		const { lastFrame } = render(
			React.createElement(ScrollHarness, { messages, viewportHeight: 12 }),
		);
		await tick();

		const frame = lastFrame();
		// Should show ~4 messages (12 rows / 3 rows per message)
		expect(frame).toContain("bottom:true");
		// Should contain the newest messages
		expect(frame).toContain("Message 19");
	});

	it("scrolls up when up arrow is pressed", async () => {
		const messages = makeMessages(20);
		const { lastFrame, stdin } = render(
			React.createElement(ScrollHarness, { messages, viewportHeight: 12 }),
		);
		await tick();

		// Press up arrow
		stdin.write("\x1B[A");
		await tick();

		const frame = lastFrame();
		// Should no longer be at bottom
		expect(frame).toContain("bottom:false");
		expect(frame).not.toContain("offset:0");
	});

	it("scrolls down back to bottom", async () => {
		const messages = makeMessages(20);
		const { lastFrame, stdin } = render(
			React.createElement(ScrollHarness, { messages, viewportHeight: 12 }),
		);
		await tick();

		// Scroll up
		stdin.write("\x1B[A");
		stdin.write("\x1B[A");
		await tick();

		let frame = lastFrame();
		expect(frame).toContain("bottom:false");

		// Scroll back down
		stdin.write("\x1B[B");
		stdin.write("\x1B[B");
		await tick();

		frame = lastFrame();
		expect(frame).toContain("bottom:true");
	});

	it("auto-scrolls to bottom when new messages arrive and was at bottom", async () => {
		const messages = makeMessages(20);
		const { lastFrame, rerender } = render(
			React.createElement(ScrollHarness, { messages, viewportHeight: 12 }),
		);
		await tick();

		let frame = lastFrame();
		expect(frame).toContain("bottom:true");
		expect(frame).toContain("Message 19");

		// Add a new message — re-render with updated messages
		const newMessages = [
			...messages,
			{
				id: "msg-20",
				role: "user" as const,
				content: "Message 20",
				thread_id: "t-1",
				created_at: new Date().toISOString(),
			},
		];
		rerender(React.createElement(ScrollHarness, { messages: newMessages, viewportHeight: 12 }));
		await tick();

		frame = lastFrame();
		expect(frame).toContain("bottom:true");
		expect(frame).toContain("Message 20");
	});

	it("does not auto-scroll when scrolled up and new messages arrive", async () => {
		const messages = makeMessages(20);
		const { lastFrame, stdin, rerender } = render(
			React.createElement(ScrollHarness, { messages, viewportHeight: 12 }),
		);
		await tick();

		// Scroll up
		stdin.write("\x1B[A");
		stdin.write("\x1B[A");
		stdin.write("\x1B[A");
		await tick();

		let frame = lastFrame();
		expect(frame).toContain("bottom:false");

		// Add new message
		const newMessages = [
			...messages,
			{
				id: "msg-20",
				role: "user" as const,
				content: "Message 20",
				thread_id: "t-1",
				created_at: new Date().toISOString(),
			},
		];
		rerender(React.createElement(ScrollHarness, { messages: newMessages, viewportHeight: 12 }));
		await tick();

		frame = lastFrame();
		// Should stay scrolled up, NOT jump to bottom
		expect(frame).toContain("bottom:false");
	});

	it("cannot scroll past the beginning of messages", async () => {
		const messages = makeMessages(5);
		const { lastFrame, stdin } = render(
			React.createElement(ScrollHarness, { messages, viewportHeight: 12 }),
		);
		await tick();

		// Press up many times
		for (let i = 0; i < 20; i++) {
			stdin.write("\x1B[A");
		}
		await tick();

		const frame = lastFrame();
		// Should show the first message
		expect(frame).toContain("Message 0");
		expect(frame).toContain("hidden:0");
	});
});
