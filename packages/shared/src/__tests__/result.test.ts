import { describe, expect, it } from "bun:test";
import { err, ok } from "../result.js";

describe("Result type", () => {
	it("ok() creates successful result with value", () => {
		const result = ok("success");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBe("success");
		}
	});

	it("err() creates error result with error", () => {
		const error = new Error("Something failed");
		const result = err(error);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBe(error);
		}
	});
});
