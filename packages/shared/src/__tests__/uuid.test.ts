import { describe, expect, it } from "bun:test";
import { deterministicUUID, randomUUID } from "../uuid.js";

describe("UUID utilities", () => {
	describe("randomUUID", () => {
		it("generates valid UUID v4 format", () => {
			const uuid = randomUUID();
			const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
			expect(uuidRegex.test(uuid)).toBe(true);
		});

		it("generates unique UUIDs on multiple calls", () => {
			const uuid1 = randomUUID();
			const uuid2 = randomUUID();
			expect(uuid1).not.toBe(uuid2);
		});

		it("generates UUIDs with v4 version bits", () => {
			const uuid = randomUUID();
			const versionBits = uuid.charAt(14);
			expect(["4"]).toContain(versionBits);
		});
	});

	describe("deterministicUUID", () => {
		it("produces same output for same inputs", () => {
			const namespace = "test-namespace";
			const name = "test-name";
			const uuid1 = deterministicUUID(namespace, name);
			const uuid2 = deterministicUUID(namespace, name);
			expect(uuid1).toBe(uuid2);
		});

		it("produces different output for different names", () => {
			const namespace = "test-namespace";
			const uuid1 = deterministicUUID(namespace, "name1");
			const uuid2 = deterministicUUID(namespace, "name2");
			expect(uuid1).not.toBe(uuid2);
		});

		it("produces different output for different namespaces", () => {
			const name = "test-name";
			const uuid1 = deterministicUUID("namespace1", name);
			const uuid2 = deterministicUUID("namespace2", name);
			expect(uuid1).not.toBe(uuid2);
		});

		it("generates valid UUID v5 format", () => {
			const uuid = deterministicUUID("test-namespace", "test-name");
			const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
			expect(uuidRegex.test(uuid)).toBe(true);
		});

		it("generates UUIDs with v5 version bits", () => {
			const uuid = deterministicUUID("test-namespace", "test-name");
			const versionBits = uuid.charAt(14);
			expect(["5"]).toContain(versionBits);
		});
	});
});
