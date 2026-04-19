import { useInput } from "ink";
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

/**
 * Hook that provides scrollable viewport over a messages array.
 *
 * - Starts at the bottom (newest messages visible)
 * - Up/PageUp scrolls backward through history
 * - Down/PageDown scrolls forward; End jumps to bottom
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

	// Keyboard navigation
	useInput((_input, key) => {
		if (key.upArrow) {
			setScrollOffset((prev) => {
				const maxOffset = Math.max(0, messages.length - maxVisible);
				return Math.min(prev + 1, maxOffset);
			});
		} else if (key.downArrow) {
			setScrollOffset((prev) => Math.max(0, prev - 1));
		} else if (key.pageUp) {
			setScrollOffset((prev) => {
				const maxOffset = Math.max(0, messages.length - maxVisible);
				return Math.min(prev + maxVisible, maxOffset);
			});
		} else if (key.pageDown) {
			setScrollOffset((prev) => Math.max(0, prev - maxVisible));
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
