import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { observeWidth } from "../responsive-svg";

// observeWidth is a Svelte action: it measures the element width synchronously
// on attach, then re-measures on every ResizeObserver callback, and disconnects
// the observer on destroy. These tests drive both the ResizeObserver-present
// and ResizeObserver-absent code paths without a real browser.

type ResizeCb = () => void;

class FakeResizeObserver {
	static instances: FakeResizeObserver[] = [];
	readonly observed: unknown[] = [];
	disconnected = false;
	constructor(private readonly cb: ResizeCb) {
		FakeResizeObserver.instances.push(this);
	}
	observe(node: unknown): void {
		this.observed.push(node);
	}
	disconnect(): void {
		this.disconnected = true;
	}
	/** Simulate the browser firing a resize. */
	fire(): void {
		this.cb();
	}
}

/** A node stub whose getBoundingClientRect width is caller-controlled. */
function nodeWithWidth(getWidth: () => number): HTMLElement {
	return {
		getBoundingClientRect: () => ({ width: getWidth() }) as DOMRect,
	} as unknown as HTMLElement;
}

const savedResizeObserver = (globalThis as Record<string, unknown>).ResizeObserver;

describe("observeWidth with ResizeObserver present", () => {
	beforeEach(() => {
		FakeResizeObserver.instances = [];
		(globalThis as Record<string, unknown>).ResizeObserver =
			FakeResizeObserver as unknown as typeof ResizeObserver;
	});

	afterEach(() => {
		(globalThis as Record<string, unknown>).ResizeObserver = savedResizeObserver;
	});

	it("reports the rounded, non-negative width once synchronously on attach", () => {
		const widths: number[] = [];
		observeWidth(
			nodeWithWidth(() => 123.4),
			(w) => widths.push(w),
		);
		expect(widths).toEqual([123]);
	});

	it("observes the node and re-measures on each resize callback", () => {
		let current = 100.6;
		const widths: number[] = [];
		const node = nodeWithWidth(() => current);
		observeWidth(node, (w) => widths.push(w));

		expect(FakeResizeObserver.instances).toHaveLength(1);
		const obs = FakeResizeObserver.instances[0];
		expect(obs.observed).toEqual([node]);

		current = 250.2;
		obs.fire();
		current = 0;
		obs.fire();
		expect(widths).toEqual([101, 250, 0]);
	});

	it("clamps a negative rect width to zero", () => {
		const widths: number[] = [];
		observeWidth(
			nodeWithWidth(() => -40),
			(w) => widths.push(w),
		);
		expect(widths).toEqual([0]);
	});

	it("disconnects the observer on destroy", () => {
		const { destroy } = observeWidth(
			nodeWithWidth(() => 10),
			() => {},
		);
		const obs = FakeResizeObserver.instances[0];
		expect(obs.disconnected).toBe(false);
		destroy();
		expect(obs.disconnected).toBe(true);
	});
});

describe("observeWidth without ResizeObserver", () => {
	beforeEach(() => {
		(globalThis as Record<string, unknown>).ResizeObserver = undefined;
	});

	afterEach(() => {
		(globalThis as Record<string, unknown>).ResizeObserver = savedResizeObserver;
	});

	it("measures once and returns a no-op destroy", () => {
		const widths: number[] = [];
		const handle = observeWidth(
			nodeWithWidth(() => 77),
			(w) => widths.push(w),
		);
		expect(widths).toEqual([77]);
		// destroy is a no-op but must be callable.
		expect(() => handle.destroy()).not.toThrow();
	});
});
