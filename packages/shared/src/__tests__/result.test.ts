import { describe, expect, it } from "bun:test";
import { type Result, err, ok } from "../result.js";

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

	it("type narrowing works with ok check", () => {
		const result: Result<string, Error> = ok("test");

		if (result.ok) {
			const value: string = result.value;
			expect(value).toBe("test");
		}
	});

	it("type narrowing works with ok === false check", () => {
		const result: Result<string, Error> = err(new Error("failed"));

		if (!result.ok) {
			const error: Error = result.error;
			expect(error.message).toBe("failed");
		}
	});

	it("ok works with various types", () => {
		const stringResult = ok("text");
		const numberResult = ok(42);
		const objectResult = ok({ id: "123", name: "Test" });
		const arrayResult = ok([1, 2, 3]);

		expect(stringResult.value).toBe("text");
		expect(numberResult.value).toBe(42);
		expect(objectResult.value.id).toBe("123");
		expect(arrayResult.value).toEqual([1, 2, 3]);
	});

	it("err works with various error types", () => {
		const errorResult = err(new Error("standard error"));
		const stringErrorResult = err("error message");
		const objectErrorResult = err({ code: "ERR_NOT_FOUND", message: "Not found" });

		expect(errorResult.error.message).toBe("standard error");
		expect(stringErrorResult.error).toBe("error message");
		expect(objectErrorResult.error.code).toBe("ERR_NOT_FOUND");
	});

	it("discriminates between ok and error in conditional logic", () => {
		const handleResult = (result: Result<number, string>): string => {
			if (result.ok) {
				return `Value: ${result.value}`;
			}
			return `Error: ${result.error}`;
		};

		expect(handleResult(ok(42))).toBe("Value: 42");
		expect(handleResult(err("Something went wrong"))).toBe("Error: Something went wrong");
	});
});
