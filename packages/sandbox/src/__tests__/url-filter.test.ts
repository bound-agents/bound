import { describe, expect, it } from "bun:test";
import { UrlFilter, createUrlFilter } from "../url-filter";

describe("UrlFilter", () => {
	it("should allow all URLs when allowlist is empty", () => {
		const filter = new UrlFilter([]);
		expect(filter.isAllowed("https://example.com")).toBe(true);
		expect(filter.isAllowed("http://localhost:8080")).toBe(true);
		expect(filter.isAllowed("https://any-url.org/path")).toBe(true);
	});

	it("should allow matching prefix", () => {
		const filter = new UrlFilter(["https://api.example.com"]);
		expect(filter.isAllowed("https://api.example.com")).toBe(true);
		expect(filter.isAllowed("https://api.example.com/users")).toBe(true);
		expect(filter.isAllowed("https://api.example.com/v1/data?id=123")).toBe(true);
	});

	it("should block non-matching prefix", () => {
		const filter = new UrlFilter(["https://api.example.com"]);
		expect(filter.isAllowed("https://other.example.com")).toBe(false);
		expect(filter.isAllowed("http://api.example.com")).toBe(false);
		expect(filter.isAllowed("https://api.example.org")).toBe(false);
	});

	it("should work with multiple prefixes", () => {
		const filter = new UrlFilter([
			"https://api.example.com",
			"https://cdn.example.com",
			"http://localhost",
		]);
		expect(filter.isAllowed("https://api.example.com/users")).toBe(true);
		expect(filter.isAllowed("https://cdn.example.com/assets/image.png")).toBe(true);
		expect(filter.isAllowed("http://localhost:3000/debug")).toBe(true);
		expect(filter.isAllowed("https://evil.com")).toBe(false);
	});

	it("should enforce allowlist and throw on blocked URL", () => {
		const filter = new UrlFilter(["https://api.example.com"]);
		expect(() => filter.enforce("https://api.example.com/data")).not.toThrow();
		expect(() => filter.enforce("https://evil.com")).toThrow(
			"Outbound request to https://evil.com blocked: not in allowlist. Allowed prefixes: https://api.example.com",
		);
	});

	it("should not throw when enforcing with empty allowlist", () => {
		const filter = new UrlFilter([]);
		expect(() => filter.enforce("https://any-url.com")).not.toThrow();
	});

	it("should include all allowed prefixes in error message", () => {
		const filter = new UrlFilter([
			"https://api.example.com",
			"https://cdn.example.com",
			"http://localhost",
		]);
		try {
			filter.enforce("https://blocked.com");
			expect(true).toBe(false); // Should not reach here
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toContain("https://api.example.com");
			expect(message).toContain("https://cdn.example.com");
			expect(message).toContain("http://localhost");
		}
	});

	it("should create UrlFilter using factory function", () => {
		const filter = createUrlFilter(["https://api.example.com"]);
		expect(filter).toBeInstanceOf(UrlFilter);
		expect(filter.isAllowed("https://api.example.com/data")).toBe(true);
		expect(filter.isAllowed("https://evil.com")).toBe(false);
	});
});
