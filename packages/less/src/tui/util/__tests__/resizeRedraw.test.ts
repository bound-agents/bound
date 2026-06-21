import { describe, expect, it } from "bun:test";
import {
	CLEAR_TERMINAL,
	RESIZE_REDRAW_DEBOUNCE_MS,
	createResizeRedrawHandler,
} from "../resizeRedraw.js";

/**
 * Manual timer queue so debounce behavior is deterministic without real time.
 * Mirrors the (fn, ms) => handle / clearTimeout(handle) contract.
 */
function makeFakeTimers() {
	type Entry = { id: number; fn: () => void; due: number };
	let now = 0;
	let nextId = 1;
	let queue: Entry[] = [];
	return {
		setTimeoutFn: (fn: () => void, ms: number) => {
			const id = nextId++;
			queue.push({ id, fn, due: now + ms });
			return id as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => {
			queue = queue.filter((e) => e.id !== (handle as unknown as number));
		},
		/** Advance the clock; fire everything due at or before the new time. */
		advance(ms: number) {
			now += ms;
			const due = queue.filter((e) => e.due <= now).sort((a, b) => a.due - b.due);
			queue = queue.filter((e) => e.due > now);
			for (const e of due) e.fn();
		},
		pendingCount() {
			return queue.length;
		},
	};
}

describe("createResizeRedrawHandler", () => {
	function setup(initialColumns: number) {
		const timers = makeFakeTimers();
		const calls: string[] = [];
		const handler = createResizeRedrawHandler({
			initialColumns,
			write: (data) => calls.push(`write:${data === CLEAR_TERMINAL ? "clear" : data}`),
			redraw: () => calls.push("redraw"),
			setTimeoutFn: timers.setTimeoutFn,
			clearTimeoutFn: timers.clearTimeoutFn,
		});
		return { timers, calls, handler };
	}

	it("does nothing for a height-only resize (columns unchanged)", () => {
		const { timers, calls, handler } = setup(120);
		handler.onResize(120); // same width, taller/shorter terminal
		timers.advance(RESIZE_REDRAW_DEBOUNCE_MS * 2);
		expect(calls).toEqual([]);
		expect(timers.pendingCount()).toBe(0);
	});

	it("clears then redraws after the debounce on a width change", () => {
		const { timers, calls, handler } = setup(120);
		handler.onResize(80);
		// Nothing fires until the settle window elapses.
		expect(calls).toEqual([]);
		timers.advance(RESIZE_REDRAW_DEBOUNCE_MS);
		// Clear MUST precede the repaint so the stale frame + scrollback are gone
		// before <Static> re-emits at the new width.
		expect(calls).toEqual(["write:clear", "redraw"]);
	});

	it("coalesces a rapid resize gesture into a single repaint", () => {
		const { timers, calls, handler } = setup(120);
		handler.onResize(110);
		timers.advance(RESIZE_REDRAW_DEBOUNCE_MS / 2);
		handler.onResize(100);
		timers.advance(RESIZE_REDRAW_DEBOUNCE_MS / 2);
		handler.onResize(90);
		// Still mid-gesture: no repaint yet.
		expect(calls).toEqual([]);
		timers.advance(RESIZE_REDRAW_DEBOUNCE_MS);
		expect(calls).toEqual(["write:clear", "redraw"]);
	});

	it("fires again on a subsequent width change after settling", () => {
		const { timers, calls, handler } = setup(120);
		handler.onResize(80);
		timers.advance(RESIZE_REDRAW_DEBOUNCE_MS);
		handler.onResize(100);
		timers.advance(RESIZE_REDRAW_DEBOUNCE_MS);
		expect(calls).toEqual(["write:clear", "redraw", "write:clear", "redraw"]);
	});

	it("treats a width change back to the original as a real change", () => {
		const { timers, calls, handler } = setup(120);
		handler.onResize(80); // 120 -> 80
		handler.onResize(120); // 80 -> 120 within the same gesture
		timers.advance(RESIZE_REDRAW_DEBOUNCE_MS);
		// Net width is unchanged, but the intermediate reflow may have stranded
		// junk, so a single repaint is still correct.
		expect(calls).toEqual(["write:clear", "redraw"]);
	});

	it("dispose() cancels a pending repaint", () => {
		const { timers, calls, handler } = setup(120);
		handler.onResize(80);
		handler.dispose();
		timers.advance(RESIZE_REDRAW_DEBOUNCE_MS * 2);
		expect(calls).toEqual([]);
		expect(timers.pendingCount()).toBe(0);
	});
});
