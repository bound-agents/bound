import { describe, expect, it } from "bun:test";
import { applySchema, createDatabase } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { ensureMcpUser } from "../commands/start";

describe("ensureMcpUser", () => {
	it("mcp-server.AC6.3: creates mcp user row on first call", () => {
		const db = createDatabase(":memory:");
		applySchema(db);
		const siteId = "test-site";

		ensureMcpUser(db, siteId);

		const mcpUserId = deterministicUUID(BOUND_NAMESPACE, "mcp");
		const row = db
			.query("SELECT id, display_name, deleted FROM users WHERE id = ?")
			.get(mcpUserId) as { id: string; display_name: string; deleted: number } | null;

		expect(row).not.toBeNull();
		if (row) {
			expect(row.id).toBe(mcpUserId);
			expect(row.display_name).toBe("mcp");
			expect(row.deleted).toBe(0);
		}
	});

	it("mcp-server.AC6.4: idempotent — second call does not throw or create duplicate", () => {
		const db = createDatabase(":memory:");
		applySchema(db);
		const siteId = "test-site";

		ensureMcpUser(db, siteId);
		ensureMcpUser(db, siteId); // must not throw

		const mcpUserId = deterministicUUID(BOUND_NAMESPACE, "mcp");
		const rows = db.query("SELECT id FROM users WHERE id = ?").all(mcpUserId) as { id: string }[];

		expect(rows.length).toBe(1);
	});
});
