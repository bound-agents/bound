import { useInput, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";

export interface ScrollableResult<T> {
	/** The slice of messages currently visible in the viewport */
	visibleMessages: T[];
	/** How many messages we're scrolled up from the bottom (0 = at bottom) */
	scrollOffset: number;
	/** Whether we're at the very bottom (newest messages visible) */
	isAtBottom: boolean;
	/** How many messages are hidden above the viewport */
	hiddenAbove: number;
}

/** Parse SGR mouse button number from "btn;x;yM" string. Returns btn or null. */
function parseSgrMouse(s: string): number | null {
	const semi = s.indexOf(";");
	if (semi < 1) return null;
	const btn = Number.parseInt(s.slice(0, semi), 10);
	return Number.isNaN(btn) ? null : btn;
}

/**
 * Hook that provides scrollable viewport over a messages array.
 *
 * - Starts at the bottom (newest messages visible)
 * - Mouse wheel scrolls through history (enables terminal mouse reporting)
 * - Up/PageUp scrolls backward, Down/PageDown scrolls forward
 * - Auto-scrolls to bottom when new messages arrive IF already at bottom
 * - Does NOT auto-scroll if user has scrolled up (preserves reading position)
 *
 * @param messages Full messages array
 * @param viewportRows Available rows for message display
 * @param rowsPerMessage Estimated rows consumed per message (default 3)
 */
export function useScrollableMessages<T extends { id: string }>(
	messages: T[],
	viewportRows: number,
	rowsPerMessage = 3,
): ScrollableResult<T> {
	const maxVisible = Math.max(1, Math.floor(viewportRows / rowsPerMessage));
	const [scrollOffset, setScrollOffset] = useState(0);
	const prevLengthRef = useRef(messages.length);
	const wasAtBottomRef = useRef(true);
	const { stdout } = useStdout();

	// Track whether we're at the bottom for auto-scroll decisions
	const isAtBottom = scrollOffset === 0;
	wasAtBottomRef.current = isAtBottom;

	// Auto-scroll to bottom when new messages arrive (only if was at bottom)
	useEffect(() => {
		if (messages.length > prevLengthRef.current && wasAtBottomRef.current) {
			setScrollOffset(0);
		}
		prevLengthRef.current = messages.length;
	}, [messages.length]);

	// Enable mouse reporting for scroll wheel support.
	// \x1B[?1000h = basic mouse tracking, \x1B[?1006h = SGR extended mode
	// Only enable on real TTYs (not in test environments)
	useEffect(() => {
		if (!process.stdout.isTTY) return;
		stdout.write("\x1B[?1000h\x1B[?1006h");
		return () => {
			stdout.write("\x1B[?1000l\x1B[?1006l");
		};
	}, [stdout]);

	// Refs for scroll helpers — avoids re-registering stdin listener on every render
	const messagesRef = useRef(messages);
	const maxVisibleRef = useRef(maxVisible);
	messagesRef.current = messages;
	maxVisibleRef.current = maxVisible;

	const scrollUpRef = useRef((count = 1) => {
		setScrollOffset((prev) => {
			const maxOffset = Math.max(0, messagesRef.current.length - maxVisibleRef.current);
			return Math.min(prev + count, maxOffset);
		});
	});

	const scrollDownRef = useRef((count = 1) => {
		setScrollOffset((prev) => Math.max(0, prev - count));
	});

	// Listen for raw mouse escape sequences on stdin for scroll wheel.
	// SGR format: ESC[<64;x;yM (scroll up) / ESC[<65;x;yM (scroll down)
	// Legacy format: ESC[M + bytes where byte0-32: 96=up, 97=down
	// biome-ignore lint/correctness/useExhaustiveDependencies: refs are stable
	useEffect(() => {
		if (!process.stdin.isTTY) return;
		const stdin = process.stdin;
		const handleData = (data: Buffer) => {
			const str = data.toString();

			// SGR extended mouse mode: ESC[<btn;x;yM or ESC[<btn;x;ym (release)
			const sgrPrefix = "\x1B[<";
			const sgrIdx = str.indexOf(sgrPrefix);
			if (sgrIdx >= 0) {
				const sgrBtn = parseSgrMouse(str.slice(sgrIdx + sgrPrefix.length));
				if (sgrBtn === 64) {
					scrollUpRef.current();
				} else if (sgrBtn === 65) {
					scrollDownRef.current();
				}
				// Consume ALL SGR mouse events (clicks, drags, releases) —
				// prevents them from leaking into Ink's input handler as text
				return;
			}

			// Legacy mouse mode: ESC[M followed by 3 bytes
			if (str.startsWith("\x1B[M") && str.length >= 6) {
				const btn = str.charCodeAt(3) - 32;
				if (btn === 64) {
					scrollUpRef.current();
				} else if (btn === 65) {
					scrollDownRef.current();
				}
				// Consume all legacy mouse events
				return;
			}
		};

		stdin.on("data", handleData);
		return () => {
			stdin.off("data", handleData);
		};
	}, []);

	// Keyboard navigation
	useInput((_input, key) => {
		if (key.upArrow) {
			scrollUpRef.current();
		} else if (key.downArrow) {
			scrollDownRef.current();
		} else if (key.pageUp) {
			scrollUpRef.current(maxVisible);
		} else if (key.pageDown) {
			scrollDownRef.current(maxVisible);
		}
	});

	// Compute the visible window
	const total = messages.length;
	const endIdx = total - scrollOffset;
	const startIdx = Math.max(0, endIdx - maxVisible);
	const visibleMessages = messages.slice(startIdx, endIdx);
	const hiddenAbove = startIdx;

	return {
		visibleMessages,
		scrollOffset,
		isAtBottom,
		hiddenAbove,
	};
}
