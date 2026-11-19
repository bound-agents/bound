import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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

	// Regression: the mouse-reporting enable sequence (\x1B[?1000h\x1B[?1006h)
	// must be gated on the TTY-ness of Ink's injected stdout — the stream we
	// write to — not the global process.stdout. When the suite runs with an
	// ambient TTY stdout (e.g. an interactive `git commit` driving the
	// pre-commit hook) the old `process.stdout.isTTY` check fired even under
	// ink-testing-library's non-TTY capture stream, writing the control bytes
	// into the very frame lastFrame() reads and corrupting every assertion.
	it("does not leak mouse-enable control bytes into the captured frame on an ambient TTY", async () => {
		const originalIsTTY = process.stdout.isTTY;
		try {
			// Simulate the interactive-terminal launch that flipped this on.
			process.stdout.isTTY = true;
			const messages = makeMessages(3);
			const { lastFrame } = render(
				React.createElement(ScrollHarness, { messages, viewportHeight: 20 }),
			);
			await tick();

			const frame = lastFrame() ?? "";
			// The rendered content is present...
			expect(frame).toContain("visible:3");
			// ...and the mouse-tracking escapes are NOT — Ink's capture stream is
			// not a TTY, so the write is correctly skipped.
			expect(frame).not.toContain("\x1B[?1000h");
			expect(frame).not.toContain("\x1B[?1006h");
		} finally {
			process.stdout.isTTY = originalIsTTY;
		}
	});

	it("scrolls with PageUp and PageDown by a full viewport page", async () => {
		const messages = makeMessages(40);
		const { lastFrame, stdin } = render(
			React.createElement(ScrollHarness, { messages, viewportHeight: 12 }),
		);
		await tick();
		expect(lastFrame()).toContain("offset:0");

		// PageUp: ESC[5~. maxVisible = floor(12/3) = 4, so one page = +4 offset.
		stdin.write("\x1B[5~");
		await tick();
		expect(lastFrame()).toContain("offset:4");
		expect(lastFrame()).toContain("bottom:false");

		// PageDown: ESC[6~ brings it back down a full page to the bottom.
		stdin.write("\x1B[6~");
		await tick();
		expect(lastFrame()).toContain("offset:0");
		expect(lastFrame()).toContain("bottom:true");
	});

	// The scroll-wheel path attaches a raw `data` listener to the *real*
	// process.stdin (not Ink's capture stdin), gated on process.stdin.isTTY.
	// ink-testing-library's stdin.write() feeds Ink's useInput, not this
	// listener, so these cases drive process.stdin directly with the TTY flag on.
	describe("mouse-wheel scrolling on a raw TTY stdin", () => {
		let originalIsTTY: boolean | undefined;
		beforeEach(() => {
			originalIsTTY = process.stdin.isTTY;
			(process.stdin as unknown as { isTTY: boolean }).isTTY = true;
		});
		afterEach(() => {
			(process.stdin as unknown as { isTTY: boolean | undefined }).isTTY = originalIsTTY;
		});

		it("SGR wheel-up (btn 64) scrolls backward and wheel-down (btn 65) forward", async () => {
			const messages = makeMessages(30);
			const { lastFrame } = render(
				React.createElement(ScrollHarness, { messages, viewportHeight: 12 }),
			);
			await tick();
			expect(lastFrame()).toContain("offset:0");

			// SGR wheel up: ESC[<64;x;yM
			process.stdin.emit("data", Buffer.from("\x1B[<64;10;10M"));
			await tick();
			expect(lastFrame()).toContain("offset:1");
			expect(lastFrame()).toContain("bottom:false");

			// SGR wheel down: ESC[<65;x;yM
			process.stdin.emit("data", Buffer.from("\x1B[<65;10;10M"));
			await tick();
			expect(lastFrame()).toContain("offset:0");
			expect(lastFrame()).toContain("bottom:true");
		});

		it("consumes a non-wheel SGR mouse event without scrolling", async () => {
			const messages = makeMessages(30);
			const { lastFrame } = render(
				React.createElement(ScrollHarness, { messages, viewportHeight: 12 }),
			);
			await tick();

			// SGR left-click press (btn 0) — neither 64 nor 65, so offset unchanged.
			process.stdin.emit("data", Buffer.from("\x1B[<0;5;5M"));
			await tick();
			expect(lastFrame()).toContain("offset:0");
		});

		it("legacy mouse-wheel up (byte 96) scrolls backward and down (byte 97) forward", async () => {
			const messages = makeMessages(30);
			const { lastFrame } = render(
				React.createElement(ScrollHarness, { messages, viewportHeight: 12 }),
			);
			await tick();

			// Legacy: ESC[M then (btn+32),(x+32),(y+32). Wheel up = 64 → char 96.
			process.stdin.emit("data", Buffer.from("\x1B[M\x60\x21\x21"));
			await tick();
			expect(lastFrame()).toContain("offset:1");

			// Wheel down = 65 → char 97.
			process.stdin.emit("data", Buffer.from("\x1B[M\x61\x21\x21"));
			await tick();
			expect(lastFrame()).toContain("offset:0");
		});

		it("ignores a legacy mouse event that is not a wheel button", async () => {
			const messages = makeMessages(30);
			const { lastFrame } = render(
				React.createElement(ScrollHarness, { messages, viewportHeight: 12 }),
			);
			await tick();

			// Legacy left-click (btn 0 → char 32), not a wheel — offset unchanged.
			process.stdin.emit("data", Buffer.from("\x1B[M\x20\x21\x21"));
			await tick();
			expect(lastFrame()).toContain("offset:0");
		});
	});
});
