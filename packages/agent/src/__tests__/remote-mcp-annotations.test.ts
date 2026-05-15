import { describe, expect, it } from "bun:test";
import { applySchema, createDatabase } from "@bound/core";
import { getRemoteMcpToolAnnotations } from "../mcp-bridge";

function setupHost(annotations: Record<string, unknown> | null): {
	db: ReturnType<typeof createDatabase>;
	siteId: string;
} {
	const db = createDatabase(":memory:");
	applySchema(db);
	const siteId = "remote-host-1";
	db.run(
		`INSERT INTO hosts (site_id, host_name, modified_at, deleted, mcp_tool_annotations)
		 VALUES (?, ?, ?, ?, ?)`,
		[
			siteId,
			"remote-host",
			new Date().toISOString(),
			0,
			annotations === null ? null : JSON.stringify(annotations),
		],
	);
	return { db, siteId };
}

describe("getRemoteMcpToolAnnotations", () => {
	it("returns hints for a known (server, tool) pair", () => {
		const { db, siteId } = setupHost({
			github: {
				search_repositories: { idempotentHint: true, readOnlyHint: true },
				create_issue: { idempotentHint: false, readOnlyHint: false },
			},
		});
		expect(getRemoteMcpToolAnnotations(db, siteId, "github", "search_repositories")).toEqual({
			idempotentHint: true,
			readOnlyHint: true,
		});
		expect(getRemoteMcpToolAnnotations(db, siteId, "github", "create_issue")).toEqual({
			idempotentHint: false,
			readOnlyHint: false,
		});
	});

	it("returns empty object when host has no annotations column data", () => {
		const { db, siteId } = setupHost(null);
		expect(getRemoteMcpToolAnnotations(db, siteId, "github", "search_repositories")).toEqual({});
	});

	it("returns empty object when server is not present", () => {
		const { db, siteId } = setupHost({
			github: { search_repositories: { idempotentHint: true } },
		});
		expect(getRemoteMcpToolAnnotations(db, siteId, "discord", "post_message")).toEqual({});
	});

	it("returns empty object when tool is not present in server map", () => {
		const { db, siteId } = setupHost({
			github: { search_repositories: { idempotentHint: true } },
		});
		expect(getRemoteMcpToolAnnotations(db, siteId, "github", "create_issue")).toEqual({});
	});

	it("returns empty object on malformed JSON", () => {
		const db = createDatabase(":memory:");
		applySchema(db);
		const siteId = "broken-host";
		db.run(
			`INSERT INTO hosts (site_id, host_name, modified_at, deleted, mcp_tool_annotations)
			 VALUES (?, ?, ?, ?, ?)`,
			[siteId, "h", new Date().toISOString(), 0, "{not valid json"],
		);
		expect(getRemoteMcpToolAnnotations(db, siteId, "github", "x")).toEqual({});
	});

	it("returns empty object for unknown host", () => {
		const db = createDatabase(":memory:");
		applySchema(db);
		expect(getRemoteMcpToolAnnotations(db, "no-such-host", "x", "y")).toEqual({});
	});
});
