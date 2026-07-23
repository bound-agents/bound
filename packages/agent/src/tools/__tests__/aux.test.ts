import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import type { ToolContext } from "../../types";
import { createAuxTool } from "../aux";

function getExecute(tool: ReturnType<typeof createAuxTool>) {
	const execute = tool.execute;
	if (!execute) throw new Error("Tool execute is required");
	return execute;
}

describe("Native Aux Tool (define/list/retire slice)", () => {
	let db: Database;
	const siteId = "test-site";
	let ctx: ToolContext;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		ctx = {
			db,
			siteId,
			threadId: "thread-1",
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

	// ---------- define ----------

	describe("define", () => {
		it("creates a new identity and persists the row", async () => {
			const exec = getExecute(createAuxTool(ctx));
			const out = await exec({
				action: "define",
				name: "tama",
				persona: "curious, methodical, writes findings before summarizing",
				tools: ["read", "grep"],
				model_hint: "haiku",
			});
			expect(out).toContain("Defined auxiliary agent 'tama'");

			const row = db.query("SELECT * FROM agents WHERE name = ?").get("tama") as any;
			expect(row).not.toBeNull();
			expect(row.persona).toContain("curious");
			expect(row.tools).toBe('["read","grep"]');
			expect(row.model_hint).toBe("haiku");
			expect(row.retired_at).toBeNull();
			expect(row.created_by_thread).toBe("thread-1");
			expect(row.deleted).toBe(0);
		});

		it("stores tools as null when omitted (unrestricted)", async () => {
			const exec = getExecute(createAuxTool(ctx));
			await exec({ action: "define", name: "poka", persona: "terse" });
			const row = db
				.query("SELECT tools, model_hint FROM agents WHERE name = ?")
				.get("poka") as any;
			expect(row.tools).toBeNull();
			expect(row.model_hint).toBeNull();
		});

		it("requires name", async () => {
			const exec = getExecute(createAuxTool(ctx));
			const out = await exec({ action: "define", persona: "x" });
			expect(out).toContain("'name' is required");
		});

		it("requires persona", async () => {
			const exec = getExecute(createAuxTool(ctx));
			const out = await exec({ action: "define", name: "tama" });
			expect(out).toContain("'persona' is required");
		});

		it("rejects an invalid name", async () => {
			const exec = getExecute(createAuxTool(ctx));
			const out = await exec({ action: "define", name: "Tama Bear!", persona: "x" });
			expect(out).toContain("Invalid aux name");
		});

		it("rejects an empty persona", async () => {
			const exec = getExecute(createAuxTool(ctx));
			const out = await exec({ action: "define", name: "tama", persona: "   " });
			expect(out).toContain("must be non-empty");
		});

		it("refuses to define over an existing active name (identity sprawl guard)", async () => {
			const exec = getExecute(createAuxTool(ctx));
			await exec({ action: "define", name: "tama", persona: "first" });
			const out = await exec({ action: "define", name: "tama", persona: "second" });
			expect(out).toContain("already exists");
			// The original persona is untouched.
			const row = db.query("SELECT persona FROM agents WHERE name = ?").get("tama") as any;
			expect(row.persona).toBe("first");
		});

		it("allows re-defining a retired name as a fresh identity", async () => {
			const exec = getExecute(createAuxTool(ctx));
			await exec({ action: "define", name: "tama", persona: "first" });
			await exec({ action: "retire", name: "tama" });
			const out = await exec({ action: "define", name: "tama", persona: "reborn" });
			expect(out).toContain("Defined auxiliary agent 'tama'");
			// Two rows now share the name; the active one is the new persona.
			const active = db
				.query("SELECT persona FROM agents WHERE name = ? AND retired_at IS NULL AND deleted = 0")
				.get("tama") as any;
			expect(active.persona).toBe("reborn");
		});
	});

	// ---------- update ----------

	describe("update", () => {
		it("changes persona in place, preserving identity", async () => {
			const exec = getExecute(createAuxTool(ctx));
			await exec({ action: "define", name: "tama", persona: "old", model_hint: "haiku" });
			const before = db.query("SELECT id FROM agents WHERE name = ?").get("tama") as any;

			const out = await exec({
				action: "update",
				name: "tama",
				persona: "new, leads with the answer",
			});
			expect(out).toContain("Updated auxiliary agent 'tama'");

			const after = db
				.query("SELECT id, persona, model_hint FROM agents WHERE name = ?")
				.get("tama") as any;
			expect(after.id).toBe(before.id); // same identity row
			expect(after.persona).toBe("new, leads with the answer");
			expect(after.model_hint).toBe("haiku"); // untouched field carries over
		});

		it("updates tools and model_hint independently", async () => {
			const exec = getExecute(createAuxTool(ctx));
			await exec({ action: "define", name: "tama", persona: "p" });
			await exec({ action: "update", name: "tama", tools: ["read"], model_hint: "gpt-5.4" });
			const row = db
				.query("SELECT tools, model_hint FROM agents WHERE name = ?")
				.get("tama") as any;
			expect(row.tools).toBe('["read"]');
			expect(row.model_hint).toBe("gpt-5.4");
		});

		it("errors when the identity does not exist", async () => {
			const exec = getExecute(createAuxTool(ctx));
			const out = await exec({ action: "update", name: "ghost", persona: "x" });
			expect(out).toContain("no active auxiliary agent named 'ghost'");
		});

		it("errors when no updatable field is supplied", async () => {
			const exec = getExecute(createAuxTool(ctx));
			await exec({ action: "define", name: "tama", persona: "p" });
			const out = await exec({ action: "update", name: "tama" });
			expect(out).toContain("at least one of");
		});
	});

	// ---------- retire ----------

	describe("retire", () => {
		it("sets retired_at without deleting the row (namespace stays readable)", async () => {
			const exec = getExecute(createAuxTool(ctx));
			await exec({ action: "define", name: "tama", persona: "p" });
			const out = await exec({ action: "retire", name: "tama" });
			expect(out).toContain("Retired auxiliary agent 'tama'");

			const row = db
				.query("SELECT retired_at, deleted FROM agents WHERE name = ?")
				.get("tama") as any;
			expect(row.retired_at).not.toBeNull();
			expect(row.deleted).toBe(0); // NOT sync-deleted
		});

		it("is an idempotent no-op on an already-retired identity", async () => {
			const exec = getExecute(createAuxTool(ctx));
			await exec({ action: "define", name: "tama", persona: "p" });
			await exec({ action: "retire", name: "tama" });
			const out = await exec({ action: "retire", name: "tama" });
			expect(out).toContain("already retired");
		});

		it("errors when the identity does not exist", async () => {
			const exec = getExecute(createAuxTool(ctx));
			const out = await exec({ action: "retire", name: "ghost" });
			expect(out).toContain("no auxiliary agent named 'ghost'");
		});
	});

	// ---------- list ----------

	describe("list", () => {
		it("returns a message when no identities are defined", async () => {
			const exec = getExecute(createAuxTool(ctx));
			const out = await exec({ action: "list" });
			expect(out).toContain("No auxiliary agents defined");
		});

		it("lists active identities and excludes retired ones", async () => {
			const exec = getExecute(createAuxTool(ctx));
			await exec({ action: "define", name: "tama", persona: "curious", model_hint: "haiku" });
			await exec({ action: "define", name: "poka", persona: "terse" });
			await exec({ action: "retire", name: "poka" });

			const out = await exec({ action: "list" });
			expect(out).toContain("tama");
			expect(out).toContain("haiku");
			expect(out).not.toContain("poka");
		});
	});

	// ---------- discriminated-union dispatch (branch-shadowing guard) ----------

	describe("strict action dispatch", () => {
		it("rejects an unknown action via schema validation", async () => {
			const exec = getExecute(createAuxTool(ctx));
			const out = await exec({ action: "invoke", name: "tama" });
			// invoke is not in this slice's enum — schema rejects it, no branch runs.
			expect(out).toContain("invalid parameters");
		});

		it("does not let a define-shaped call silently retire (no branch bleed)", async () => {
			// A call carrying retire-irrelevant fields still dispatches strictly on
			// `action`. define with persona must create, never touch retire logic.
			const exec = getExecute(createAuxTool(ctx));
			const out = await exec({ action: "define", name: "tama", persona: "p" });
			expect(out).toContain("Defined");
			const row = db.query("SELECT retired_at FROM agents WHERE name = ?").get("tama") as any;
			expect(row.retired_at).toBeNull();
		});
	});

	// ---------- annotations ----------

	describe("resolveAnnotations", () => {
		it("marks list read-only and mutating actions not read-only", () => {
			const tool = createAuxTool(ctx);
			const resolve = tool.resolveAnnotations;
			if (!resolve) throw new Error("resolveAnnotations expected");
			expect(resolve({ action: "list" })).toEqual({ idempotent: true, readOnly: true });
			expect(resolve({ action: "define" })).toEqual({ idempotent: true, readOnly: false });
			expect(resolve({ action: "update" })).toEqual({ idempotent: true, readOnly: false });
			expect(resolve({ action: "retire" })).toEqual({ idempotent: true, readOnly: false });
		});
	});
});
