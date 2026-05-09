import { describe, expect, it } from "bun:test";
import { connectorHandleId } from "../connector-handle-id.js";

describe("connectorHandleId", () => {
	it("generates a deterministic ID from server_name, event_name, and event_args", () => {
		const id = connectorHandleId("discord", "message.received", { channel_id: "123" });
		expect(typeof id).toBe("string");
		expect(id.length).toBe(36); // UUID format
	});

	it("produces the same ID regardless of event_args key order", () => {
		const id1 = connectorHandleId("discord", "message.received", { a: 1, b: 2 });
		const id2 = connectorHandleId("discord", "message.received", { b: 2, a: 1 });
		expect(id1).toBe(id2);
	});

	it("produces different IDs for different server names", () => {
		const id1 = connectorHandleId("discord", "message.received", { channel_id: "123" });
		const id2 = connectorHandleId("slack", "message.received", { channel_id: "123" });
		expect(id1).not.toBe(id2);
	});

	it("produces different IDs for different event names", () => {
		const id1 = connectorHandleId("discord", "message.received", { channel_id: "123" });
		const id2 = connectorHandleId("discord", "interaction.received", { channel_id: "123" });
		expect(id1).not.toBe(id2);
	});

	it("produces different IDs for different event_args values", () => {
		const id1 = connectorHandleId("discord", "message.received", { channel_id: "123" });
		const id2 = connectorHandleId("discord", "message.received", { channel_id: "456" });
		expect(id1).not.toBe(id2);
	});

	it("handles complex nested event_args with consistent ordering", () => {
		const id1 = connectorHandleId("github", "push", {
			repository: "test",
			branches: ["main", "dev"],
			meta: { version: 1 },
		});
		const id2 = connectorHandleId("github", "push", {
			meta: { version: 1 },
			branches: ["main", "dev"],
			repository: "test",
		});
		expect(id1).toBe(id2);
	});
});
