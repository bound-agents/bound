import { describe, expect, it } from "bun:test";
import { TypedEventEmitter } from "../event-emitter";

// Use a real event name from EventMap. "file:changed" carries a structured payload.
describe("TypedEventEmitter", () => {
	it("delivers emitted data to a registered listener", () => {
		const bus = new TypedEventEmitter();
		const seen: unknown[] = [];
		bus.on("file:changed", (data) => seen.push(data));
		const payload = { path: "/a", changeType: "modified" } as never;
		bus.emit("file:changed", payload);
		expect(seen).toEqual([payload]);
	});

	it("off() detaches a listener so it stops receiving events", () => {
		const bus = new TypedEventEmitter();
		let count = 0;
		const listener = () => {
			count++;
		};
		bus.on("file:changed", listener);
		bus.emit("file:changed", {} as never);
		bus.off("file:changed", listener);
		bus.emit("file:changed", {} as never);
		expect(count).toBe(1);
	});

	it("once() fires exactly one time then auto-detaches", () => {
		const bus = new TypedEventEmitter();
		let count = 0;
		bus.once("file:changed", () => {
			count++;
		});
		bus.emit("file:changed", {} as never);
		bus.emit("file:changed", {} as never);
		expect(count).toBe(1);
	});

	it("emit returns false when there are no listeners", () => {
		const bus = new TypedEventEmitter();
		expect(bus.emit("file:changed", {} as never)).toBe(false);
	});

	it("on/off/once return the emitter for chaining", () => {
		const bus = new TypedEventEmitter();
		const noop = () => {};
		expect(bus.on("file:changed", noop)).toBe(bus);
		expect(bus.once("file:changed", noop)).toBe(bus);
		expect(bus.off("file:changed", noop)).toBe(bus);
	});
});
