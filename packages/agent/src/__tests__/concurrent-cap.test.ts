import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { ConcurrentCap } from "../concurrent-cap";

type Operation = "acquire" | "release";

describe("ConcurrentCap", () => {
	it("matches a reference counter across bounded acquire/release sequences", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 20 }),
				fc.array(fc.constantFrom<Operation>("acquire", "release"), {
					minLength: 0,
					maxLength: 100,
				}),
				(capacity, operations) => {
					const cap = new ConcurrentCap(capacity);
					let referenceCurrent = 0;

					for (const operation of operations) {
						if (operation === "acquire") {
							const expected = referenceCurrent < capacity;
							expect(cap.acquire()).toBe(expected);
							if (expected) referenceCurrent++;
						} else {
							cap.release();
							if (referenceCurrent > 0) referenceCurrent--;
						}

						expect(cap.current).toBe(referenceCurrent);
						expect(cap.current).toBeGreaterThanOrEqual(0);
						expect(cap.current).toBeLessThanOrEqual(capacity);
						expect(cap.capacity).toBe(capacity);
					}
				},
			),
		);
	});

	it("reports capacity", () => {
		const cap = new ConcurrentCap(20);
		expect(cap.capacity).toBe(20);
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

		await Promise.all([simulate("a", 10), simulate("b", 10), simulate("c", 10)]);

		expect(results).toContain("a: done");
		expect(results).toContain("b: done");
		expect(results).toContain("c: rejected");
		expect(cap.current).toBe(0);
	});
});
