import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import type { ToolContext } from "../../types";
import { createAuxTool } from "../auxiliary";
import { createMemoryTool } from "../memory";

function getExecute(tool: ReturnType<typeof createMemoryTool>) {
	const execute = tool.execute;
	if (!execute) throw new Error("Tool execute is required");
	return execute;
}

function getAuxExecute(tool: ReturnType<typeof createAuxTool>) {
	const execute = tool.execute;
	if (!execute) throw new Error("Tool execute is required");
	return execute;
}

describe("Memory namespace scoping (#201)", () => {
	let db: Database;
	const siteId = "test-site";
	let mainCtx: ToolContext;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		mainCtx = {
			db,
			siteId,
			threadId: "main-thread",
			eventBus: {
				on: () => {},
				off: () => {},
				emit: () => {},
				once: () => {},
			} as any,
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
		} as ToolContext;
	});

	afterEach(() => {
		db.close();
	});

	describe("main agent namespace (agent_id IS NULL)", () => {
		it("stores and searches in the main namespace by default", async () => {
			const exec = getExecute(createMemoryTool(mainCtx));
			const out = await exec({ action: "store", key: "main-key", value: "main value" });
			expect(out).toContain("Memory saved");

			const search = await exec({ action: "search", key: "main-key" });
			expect(search).toContain("main-key");
			expect(search).toContain("main value");
		});

		it("does not see aux-namespace memories without agent_name", async () => {
			// Define an aux agent
			const auxExec = getAuxExecute(createAuxTool(mainCtx));
			await auxExec({ action: "define", name: "tama", persona: "test" });

			// Get the agent's id
			const agent = db.query("SELECT id FROM agents WHERE name = ?").get("tama") as any;

			// Insert a memory directly into the aux namespace
			db.run(
				"INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at, last_accessed_at, deleted, tier, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'default', ?)",
				"mem-1",
				"aux-secret",
				"hidden from main",
				"test",
				"2026-01-01T00:00:00Z",
				"2026-01-01T00:00:00Z",
				"2026-01-01T00:00:00Z",
				agent.id,
			);

			// Main agent search should NOT find it
			const memExec = getExecute(createMemoryTool(mainCtx));
			const search = await memExec({ action: "search", key: "aux-secret" });
			expect(search).toContain("No memories matched");
		});
	});

	describe("main agent cross-namespace access (agent_name parameter)", () => {
		it("reads aux memory via agent_name", async () => {
			const auxExec = getAuxExecute(createAuxTool(mainCtx));
			await auxExec({ action: "define", name: "tama", persona: "test" });

			const agent = db.query("SELECT id FROM agents WHERE name = ?").get("tama") as any;

			// Store a memory in the aux namespace directly
			db.run(
				"INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at, last_accessed_at, deleted, tier, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'default', ?)",
				"mem-1",
				"aux-finding",
				"discovered by aux",
				"test",
				"2026-01-01T00:00:00Z",
				"2026-01-01T00:00:00Z",
				"2026-01-01T00:00:00Z",
				agent.id,
			);

			// Main agent reads it via agent_name
			const memExec = getExecute(createMemoryTool(mainCtx));
			const search = await memExec({ action: "search", key: "aux-finding", agent_name: "tama" });
			expect(search).toContain("aux-finding");
			expect(search).toContain("discovered by aux");
		});

		it("writes to aux namespace via agent_name", async () => {
			const auxExec = getAuxExecute(createAuxTool(mainCtx));
			await auxExec({ action: "define", name: "tama", persona: "test" });

			// Main agent stores into the aux namespace
			const memExec = getExecute(createMemoryTool(mainCtx));
			const out = await memExec({
				action: "store",
				key: "main-to-aux",
				value: "written by main into aux namespace",
				agent_name: "tama",
			});
			expect(out).toContain("Memory saved");

			// Verify it landed in the aux namespace
			const agent = db.query("SELECT id FROM agents WHERE name = ?").get("tama") as any;
			const row = db
				.query("SELECT value FROM semantic_memory WHERE key = ? AND agent_id = ? AND deleted = 0")
				.get("main-to-aux", agent.id) as { value: string } | null;
			expect(row).not.toBeNull();
			expect(row?.value).toBe("written by main into aux namespace");

			// Main agent should NOT see it in its own namespace
			const ownSearch = await memExec({ action: "search", key: "main-to-aux" });
			expect(ownSearch).toContain("No memories matched");
		});

		it("errors on unknown agent_name", async () => {
			const memExec = getExecute(createMemoryTool(mainCtx));
			const out = await memExec({ action: "search", key: "test", agent_name: "ghost" });
			expect(out).toContain("no active auxiliary agent named 'ghost'");
		});

		it("forgets aux memory via agent_name", async () => {
			const auxExec = getAuxExecute(createAuxTool(mainCtx));
			await auxExec({ action: "define", name: "tama", persona: "test" });

			// Store in aux namespace
			const memExec = getExecute(createMemoryTool(mainCtx));
			await memExec({
				action: "store",
				key: "to-delete",
				value: "will be forgotten",
				agent_name: "tama",
			});

			// Forget it
			const out = await memExec({ action: "forget", key: "to-delete", agent_name: "tama" });
			expect(out).toContain("Memory deleted");

			// Verify it's soft-deleted
			const agent = db.query("SELECT id FROM agents WHERE name = ?").get("tama") as any;
			const row = db
				.query("SELECT deleted FROM semantic_memory WHERE key = ? AND agent_id = ?")
				.get("to-delete", agent.id) as { deleted: number } | null;
			expect(row?.deleted).toBe(1);
		});
	});

	describe("aux agent namespace (agent_id non-null)", () => {
		it("aux agent is walled to its own namespace", async () => {
			const auxExec = getAuxExecute(createAuxTool(mainCtx));
			await auxExec({ action: "define", name: "tama", persona: "test" });

			const agent = db.query("SELECT id FROM agents WHERE name = ?").get("tama") as any;

			// Store in main namespace
			const mainMem = getExecute(createMemoryTool(mainCtx));
			await mainMem({ action: "store", key: "main-secret", value: "only for main" });

			// Aux agent context
			const auxCtx: ToolContext = {
				...mainCtx,
				agentId: agent.id,
			};
			const auxMem = getExecute(createMemoryTool(auxCtx));

			// Aux should NOT find main's memory
			const search = await auxMem({ action: "search", key: "main-secret" });
			expect(search).toContain("No memories matched");
		});

		it("aux agent ignores agent_name parameter", async () => {
			const auxExec = getAuxExecute(createAuxTool(mainCtx));
			await auxExec({ action: "define", name: "tama", persona: "test" });
			await auxExec({ action: "define", name: "poka", persona: "other" });

			const tamaAgent = db.query("SELECT id FROM agents WHERE name = ?").get("tama") as any;
			const pokaAgent = db.query("SELECT id FROM agents WHERE name = ?").get("poka") as any;

			// Store in poka's namespace
			db.run(
				"INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at, last_accessed_at, deleted, tier, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'default', ?)",
				"mem-1",
				"poka-key",
				"poka value",
				"test",
				"2026-01-01T00:00:00Z",
				"2026-01-01T00:00:00Z",
				"2026-01-01T00:00:00Z",
				pokaAgent.id,
			);

			// Tama tries to read poka's memory via agent_name — should be ignored
			const tamaCtx: ToolContext = {
				...mainCtx,
				agentId: tamaAgent.id,
			};
			const tamaMem = getExecute(createMemoryTool(tamaCtx));
			const search = await tamaMem({ action: "search", key: "poka-key", agent_name: "poka" });
			// agent_name is ignored when ctx.agentId is set, so tama searches its own namespace
			expect(search).toContain("No memories matched");
		});
	});
});
