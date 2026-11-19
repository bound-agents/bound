import { afterEach, describe, expect, it } from "bun:test";
import {
	clearTelemetryInstrumentCaches,
	counter,
	histogram,
	meter,
	upDownCounter,
} from "../telemetry-api";

afterEach(() => {
	clearTelemetryInstrumentCaches();
});

describe("instrument caches", () => {
	it("meter() returns the same Meter instance for a repeated name", () => {
		const a = meter("bound");
		const b = meter("bound");
		expect(a).toBe(b);
	});

	it("counter() memoizes by name", () => {
		const a = counter("my.counter");
		const b = counter("my.counter");
		expect(a).toBe(b);
	});

	it("histogram() memoizes by name", () => {
		const a = histogram("my.histogram");
		const b = histogram("my.histogram");
		expect(a).toBe(b);
	});

	it("upDownCounter() memoizes by name", () => {
		const a = upDownCounter("my.updown");
		const b = upDownCounter("my.updown");
		expect(a).toBe(b);
	});

	it("clearTelemetryInstrumentCaches drops cached instruments so a fresh one is built", () => {
		const first = counter("drop.me");
		clearTelemetryInstrumentCaches();
		const second = counter("drop.me");
		expect(second).not.toBe(first);
	});
});

describe("late-bound instruments", () => {
	it("a counter records without throwing before any meter provider is configured", () => {
		// The late-bound counter lazily resolves its delegate on first .add();
		// with the no-op default provider this must be a safe call, not a crash.
		const c = counter("lazy.counter");
		expect(() => c.add(1, { label: "x" })).not.toThrow();
		expect(() => c.add(2)).not.toThrow();
	});

	it("a histogram records without throwing", () => {
		const h = histogram("lazy.histogram");
		expect(() => h.record(42, { unit: "ms" })).not.toThrow();
	});

	it("an up-down counter adds without throwing", () => {
		const u = upDownCounter("lazy.updown");
		expect(() => u.add(-1)).not.toThrow();
		expect(() => u.add(3, { label: "y" })).not.toThrow();
	});
});
