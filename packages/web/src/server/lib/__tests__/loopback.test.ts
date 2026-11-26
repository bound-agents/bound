import { describe, expect, it } from "bun:test";
import { extractHostName, hasLoopbackHostHeader, isLoopbackHost } from "../loopback";

describe("loopback helpers", () => {
	it("recognizes every loopback spelling, including ::1", () => {
		for (const host of ["localhost", "127.0.0.1", "::1", "[::1]"]) {
			expect(isLoopbackHost(host)).toBe(true);
		}
		expect(isLoopbackHost("0.0.0.0")).toBe(false);
		expect(isLoopbackHost("evil.example.com")).toBe(false);
	});

	it("strips ports from Host headers and keeps IPv6 brackets", () => {
		expect(extractHostName("localhost:3001")).toBe("localhost");
		expect(extractHostName("[::1]:3001")).toBe("[::1]");
		expect(extractHostName("[::1")).toBe("[::1");
	});

	it("accepts a missing Host header and rejects a non-loopback one", () => {
		expect(hasLoopbackHostHeader(null)).toBe(true);
		expect(hasLoopbackHostHeader("[::1]:3001")).toBe(true);
		expect(hasLoopbackHostHeader("evil.example.com:3001")).toBe(false);
	});
});
