import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { InMemoryTurnStateStore } from "../turn-state-store";

describe("InMemoryTurnStateStore", () => {
	afterEach(() => {
		// Undo any faked clock from individual tests.
		setSystemTime();
	});

	describe("get / set / delete round-trips", () => {
		let store: InMemoryTurnStateStore<{ n: number }>;

		beforeEach(() => {
			store = new InMemoryTurnStateStore<{ n: number }>();
		});

		it("returns undefined for an unknown key", () => {
			expect(store.get("nope")).toBeUndefined();
		});

		it("returns the stored state after set", () => {
			store.set("t1", { n: 1 });
			expect(store.get("t1")).toEqual({ n: 1 });
		});

		it("overwrites an existing entry on a second set", () => {
			store.set("t1", { n: 1 });
			store.set("t1", { n: 2 });
			expect(store.get("t1")).toEqual({ n: 2 });
		});

		it("delete removes the entry", () => {
			store.set("t1", { n: 1 });
			store.delete("t1");
			expect(store.get("t1")).toBeUndefined();
		});

		it("delete of an absent key is a no-op", () => {
			expect(() => store.delete("ghost")).not.toThrow();
			expect(store.size()).toBe(0);
		});

		it("size reflects the number of live entries", () => {
			expect(store.size()).toBe(0);
			store.set("a", { n: 1 });
			store.set("b", { n: 2 });
			expect(store.size()).toBe(2);
			store.delete("a");
			expect(store.size()).toBe(1);
		});
	});

	describe("TTL-based lazy eviction on read", () => {
		it("returns the entry while inside the TTL window", () => {
			setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const store = new InMemoryTurnStateStore<string>(1000);
			store.set("t1", "warm");
			// advance 999ms — still inside the 1000ms TTL
			setSystemTime(new Date("2026-01-01T00:00:00.999Z"));
			expect(store.get("t1")).toBe("warm");
		});

		it("evicts (returns undefined) once the TTL has elapsed", () => {
			setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const store = new InMemoryTurnStateStore<string>(1000);
			store.set("t1", "cold");
			// advance 1001ms — past the 1000ms TTL
			setSystemTime(new Date("2026-01-01T00:00:01.001Z"));
			expect(store.get("t1")).toBeUndefined();
		});

		it("drops the evicted entry from the map so size shrinks after an expired read", () => {
			setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const store = new InMemoryTurnStateStore<string>(1000);
			store.set("t1", "cold");
			expect(store.size()).toBe(1);
			setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
			expect(store.get("t1")).toBeUndefined();
			// lazy eviction happened on read
			expect(store.size()).toBe(0);
		});

		it("uses the default 4-minute TTL when none is supplied", () => {
			setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const store = new InMemoryTurnStateStore<string>();
			store.set("t1", "warm");
			// 3m59s — still warm under the 4m default
			setSystemTime(new Date("2026-01-01T00:03:59.000Z"));
			expect(store.get("t1")).toBe("warm");
			// 4m01s — evicted
			setSystemTime(new Date("2026-01-01T00:04:01.000Z"));
			expect(store.get("t1")).toBeUndefined();
		});
	});
});
