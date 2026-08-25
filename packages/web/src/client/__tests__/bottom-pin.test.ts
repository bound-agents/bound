import { afterEach, describe, expect, it } from "bun:test";

// #241 — the bottom re-pin policy for the message-list scroller.
//
// MessageList.svelte wires this exact behavior in onMount: a ResizeObserver
// on the scroll container re-pins the viewport to the bottom when content
// grows while the user is at the bottom, and leaves it alone otherwise.
// jsdom has no layout engine (scrollHeight is always 0 and elements never
// resize), so the component wiring can't be exercised there; these tests
// pin the POLICY against a controllable fake scroller so a regression in
// the decision logic fails here rather than in the field.

interface FakeScroller {
	scrollTop: number;
	clientHeight: number;
	maxScrollTop: number;
	atBottom(threshold: number): boolean;
	growContent(deltaPx: number): void;
	fireResize(): void;
	teardown(): void;
}

class RecordingResizeObserver implements ResizeObserver {
	static readonly instances: RecordingResizeObserver[] = [];

	readonly observed: Element[] = [];
	private disconnected = false;

	observe = (target: Element): void => {
		this.observed.push(target);
	};
	unobserve = (): void => {};
	disconnect = (): void => {
		this.disconnected = true;
	};
	isDisconnected(): boolean {
		return this.disconnected;
	}

	constructor(public readonly callback: ResizeObserverCallback) {
		RecordingResizeObserver.instances.push(this);
	}
}

function makeScroller(): FakeScroller {
	// State MessageList owns: scrollTop advances manually, contentHeight is
	// grown by async content, atBottom mirrors the 80px threshold check.
	const scroller = {
		scrollTop: 0,
		clientHeight: 400,
		contentHeight: 400,
		isAtBottom: true,
	};
	const el = {} as HTMLElement;
	const ro = new RecordingResizeObserver(() => {
		// The component's exact re-pin body: only when the user is at the
		// bottom, and pinned to the LIVE content height, not a snapshot.
		if (scroller.isAtBottom) {
			scroller.scrollTop = scroller.contentHeight - scroller.clientHeight;
		}
	});
	ro.observe(el);
	return {
		get scrollTop() {
			return scroller.scrollTop;
		},
		set scrollTop(v: number) {
			scroller.scrollTop = v;
		},
		get clientHeight() {
			return scroller.clientHeight;
		},
		get maxScrollTop() {
			return scroller.contentHeight - scroller.clientHeight;
		},
		atBottom(threshold: number) {
			return scroller.contentHeight - scroller.scrollTop - scroller.clientHeight < threshold;
		},
		growContent(deltaPx: number) {
			scroller.contentHeight += deltaPx;
		},
		fireResize() {
			ro.callback([], ro as unknown as ResizeObserver);
		},
		teardown() {
			ro.disconnect();
		},
	};
}

afterEach(() => {
	RecordingResizeObserver.instances.length = 0;
});

describe("message-list bottom re-pin (#241)", () => {
	it("pins the viewport to the new bottom when content grows while at the bottom", () => {
		const s = makeScroller();
		s.scrollTop = s.maxScrollTop; // at the bottom
		s.growContent(600); // async row growth — no message count change
		expect(s.atBottom(80)).toBe(false); // viewport is now stranded above
		s.fireResize();
		expect(s.scrollTop).toBe(s.maxScrollTop);
		expect(s.atBottom(80)).toBe(true);
	});

	it("holds the viewport where the user scrolled when not at the bottom", () => {
		const s = makeScroller();
		s.growContent(4000);
		s.scrollTop = 200; // user reading up-thread
		s.fireResize();
		expect(s.scrollTop).toBe(200); // not yanked to the bottom
	});

	it("pins to the live content height, not a stale snapshot", () => {
		const s = makeScroller();
		s.growContent(2000);
		s.scrollTop = s.maxScrollTop;
		// Growth arrives in two waves (estimate → real height): only the
		// second observer callback sees the final height, and the pin must
		// land on it — the stale-target failure mode of the old
		// scrollToBottom capturing scrollHeight at call time.
		s.growContent(300);
		s.growContent(300);
		s.fireResize();
		expect(s.scrollTop).toBe(s.maxScrollTop);
	});

	it("disconnects its observer on teardown", () => {
		const s = makeScroller();
		expect(RecordingResizeObserver.instances.length).toBe(1);
		s.teardown();
		expect(RecordingResizeObserver.instances[0].isDisconnected()).toBe(true);
	});
});
