import { describe, expect, it } from "bun:test";
import { ConcurrentCap } from "../concurrent-cap";

describe("ConcurrentCap", () => {
	it("acquires slots up to the cap", () => {
		const cap = new ConcurrentCap(3);
		expect(cap.acquire()).toBe(true);
		expect(cap.acquire()).toBe(true);
		expect(cap.acquire()).toBe(true);
		expect(cap.current).toBe(3);
	});

	it("rejects acquire when cap is reached", () => {
		const cap = new ConcurrentCap(2);
		cap.acquire();
		cap.acquire();
		expect(cap.acquire()).toBe(false);
		expect(cap.current).toBe(2);
	});

	it("allows acquire after release", () => {
		const cap = new ConcurrentCap(1);
		cap.acquire();
		expect(cap.acquire()).toBe(false);
		cap.release();
		expect(cap.acquire()).toBe(true);
		expect(cap.current).toBe(1);
	});

	it("release does not go below zero", () => {
		const cap = new ConcurrentCap(2);
		cap.release();
		cap.release();
		expect(cap.current).toBe(0);
	});

	it("reports capacity", () => {
		const cap = new ConcurrentCap(20);
		expect(cap.capacity).toBe(20);
	});

	it("handles acquire/release cycle correctly", () => {
		const cap = new ConcurrentCap(3);
		// Fill all slots
		expect(cap.acquire()).toBe(true);
		expect(cap.acquire()).toBe(true);
		expect(cap.acquire()).toBe(true);
		expect(cap.acquire()).toBe(false);
		// Release one, acquire one
		cap.release();
		expect(cap.current).toBe(2);
		expect(cap.acquire()).toBe(true);
		expect(cap.current).toBe(3);
		expect(cap.acquire()).toBe(false);
		// Release all
		cap.release();
		cap.release();
		cap.release();
		expect(cap.current).toBe(0);
		// Can acquire again
		expect(cap.acquire()).toBe(true);
	});

	it("simulates concurrent invocations with try/finally pattern", async () => {
		const cap = new ConcurrentCap(2);
		const results: string[] = [];

		async function simulate(name: string, delayMs: number): Promise<void> {
			if (!cap.acquire()) {
				results.push(`${name}: rejected`);
				return;
			}
			try {
				await new Promise((r) => setTimeout(r, delayMs));
				results.push(`${name}: done`);
			} finally {
				cap.release();
			}
		}

		// Launch 3 concurrent; third should be rejected
		await Promise.all([simulate("a", 10), simulate("b", 10), simulate("c", 10)]);

		expect(results).toContain("a: done");
		expect(results).toContain("b: done");
		expect(results).toContain("c: rejected");
		expect(cap.current).toBe(0);
	});
});
