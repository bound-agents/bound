import { describe, expect, it } from "bun:test";
import {
	classifyRouteError,
	isConnectionLevelError,
	isTransientLLMError,
} from "../error-classification";

/**
 * DNS and connection-level failures carry no HTTP status. They are transient
 * transport faults: retried with backoff on the same route, then eligible for
 * route failover, never loop-fatal on the first occurrence.
 */
describe("connection-level LLM errors", () => {
	const messages = [
		"ai-sdk request failed: getaddrinfo ENOTFOUND api.enterprise.githubcopilot.com",
		"getaddrinfo EAI_AGAIN bedrock-runtime.us-east-1.amazonaws.com",
		"connect ECONNREFUSED 127.0.0.1:11434",
		"read ECONNRESET",
		"fetch failed",
	];

	for (const message of messages) {
		it(`treats "${message}" as transient transport`, () => {
			const error = new Error(message);
			expect(isTransientLLMError(error)).toBe(true);
			expect(isConnectionLevelError(error)).toBe(true);
			expect(classifyRouteError(error)).toBe("transport");
		});
	}

	it("reads the errno code off the error or its cause chain", () => {
		const direct = Object.assign(new Error("request failed"), { code: "EAI_AGAIN" });
		const wrapped = new TypeError("request failed", {
			cause: new Error("inner", { cause: Object.assign(new Error("dns"), { code: "ENOTFOUND" }) }),
		});
		for (const error of [direct, wrapped]) {
			expect(isTransientLLMError(error)).toBe(true);
			expect(isConnectionLevelError(error)).toBe(true);
			expect(classifyRouteError(error)).toBe("transport");
		}
	});

	it("does not reclassify a timeout or an unrelated error as connection-level", () => {
		expect(isConnectionLevelError(new Error("operation timed out"))).toBe(false);
		expect(isConnectionLevelError(new Error("malformed request"))).toBe(false);
		expect(isTransientLLMError(new Error("malformed request"))).toBe(false);
	});

	it("classifies a coded fetch failure on its code, not the wrapper message", () => {
		const certExpired = new TypeError("fetch failed", {
			cause: Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }),
		});
		const untrustedLeaf = new TypeError("fetch failed", {
			cause: Object.assign(new Error("unable to verify the first certificate"), {
				code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
			}),
		});
		const badHeader = new TypeError("fetch failed", {
			cause: Object.assign(new Error("invalid header"), { code: "UND_ERR_INVALID_ARG" }),
		});
		for (const error of [certExpired, untrustedLeaf, badHeader]) {
			expect(isConnectionLevelError(error)).toBe(false);
			expect(isTransientLLMError(error)).toBe(false);
		}

		const dns = new TypeError("fetch failed", {
			cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.example.com"), {
				code: "ENOTFOUND",
			}),
		});
		expect(isConnectionLevelError(dns)).toBe(true);
		expect(isTransientLLMError(dns)).toBe(true);
	});
});
