import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applySchema, insertRow } from "@bound/core";
import type { Logger } from "@bound/shared";
import type { ModelResolution } from "../model-resolution";
import { createModelCommandSpec } from "../platform-command-handlers";

const mockLogger: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

describe("createModelCommandSpec", () => {
	let db: Database;
	const siteId = randomUUID();
	let threadId: string;
	let taskId: string;

	// Resolver stub: accepts "opus" and "sonnet", rejects everything else.
	const stubResolve = (modelId: string | undefined): ModelResolution => {
		const effective = !modelId || modelId === "default" ? "haiku" : modelId;
		if (effective === "opus" || effective === "sonnet" || effective === "haiku") {
			return { kind: "local", backend: {} as never, modelId: effective };
		}
		return { kind: "error", error: `Unknown model "${effective}"`, reason: "not-found" as never };
	};

	const stubRouter = {
		getDefaultId: () => "haiku",
	} as never;

	function makeSpec() {
		return createModelCommandSpec({
			db,
			siteId,
			modelRouter: stubRouter,
			logger: mockLogger,
			resolveModelFn: stubResolve as never,
		});
	}

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		threadId = randomUUID();
		taskId = randomUUID();
		const now = new Date().toISOString();
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: "user-1",
				interface: "platform",
				host_origin: siteId,
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);
		insertRow(
			db,
			"tasks",
			{
				id: taskId,
				type: "event",
				status: "pending",
				trigger_spec: "connector:event:handle-1",
				thread_id: threadId,
				created_at: now,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);
		insertRow(
			db,
			"connector_handles",
			{
				id: "handle-1",
				server_name: "discord",
				event_name: "message.received",
				event_args: JSON.stringify({ channel_id: "ch-1" }),
				delivery_mode: "push",
				task_id: taskId,
				created_at: now,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);
	});

	afterEach(() => {
		db.close();
	});

	function invocation(options: Record<string, unknown> = {}, channelId = "ch-1") {
		return {
			command: "model",
			options,
			channel_id: channelId,
			user_id: "user-1",
			server_name: "discord",
		};
	}

	it("sets BOTH tasks.model_hint and threads.model_hint (split-brain regression)", async () => {
		// Two resolution paths read two different columns: scheduler wakeups
		// read tasks.model_hint, hub intake dispatch reads threads.model_hint
		// via resolveThreadModel. A hint that lands in only one column works
		// on one path and silently not the other.
		const spec = makeSpec();
		const reply = await spec.handler(invocation({ model: "opus" }));

		expect(reply).toContain("opus");
		const task = db.query("SELECT model_hint FROM tasks WHERE id = ?").get(taskId) as {
			model_hint: string | null;
		};
		const thread = db.query("SELECT model_hint FROM threads WHERE id = ?").get(threadId) as {
			model_hint: string | null;
		};
		expect(task.model_hint).toBe("opus");
		expect(thread.model_hint).toBe("opus");
	});

	it("shows the current effective model when no option is given", async () => {
		const spec = makeSpec();
		await spec.handler(invocation({ model: "sonnet" }));
		const reply = await spec.handler(invocation({}));
		expect(reply).toContain("sonnet");
	});

	it("shows the router default when no hint is set", async () => {
		const spec = makeSpec();
		const reply = await spec.handler(invocation({}));
		expect(reply).toContain("haiku");
		expect(reply.toLowerCase()).toContain("default");
	});

	it("clears both hints on 'reset'", async () => {
		const spec = makeSpec();
		await spec.handler(invocation({ model: "opus" }));
		const reply = await spec.handler(invocation({ model: "reset" }));

		expect(reply.toLowerCase()).toContain("clear");
		const task = db.query("SELECT model_hint FROM tasks WHERE id = ?").get(taskId) as {
			model_hint: string | null;
		};
		const thread = db.query("SELECT model_hint FROM threads WHERE id = ?").get(threadId) as {
			model_hint: string | null;
		};
		expect(task.model_hint).toBeNull();
		expect(thread.model_hint).toBeNull();
	});

	it("throws for a model the resolver rejects (no writes)", async () => {
		const spec = makeSpec();
		await expect(spec.handler(invocation({ model: "bogus" }))).rejects.toThrow(
			'Unknown model "bogus"',
		);
		const task = db.query("SELECT model_hint FROM tasks WHERE id = ?").get(taskId) as {
			model_hint: string | null;
		};
		expect(task.model_hint).toBeNull();
	});

	it("throws when no subscription is bound to the channel", async () => {
		const spec = makeSpec();
		await expect(spec.handler(invocation({ model: "opus" }, "ch-unbound"))).rejects.toThrow(
			/no.*subscription/i,
		);
	});

	it("is a restricted command named 'model'", () => {
		const spec = makeSpec();
		expect(spec.name).toBe("model");
		expect(spec.restricted).toBe(true);
		expect(spec.options.some((o) => o.name === "model" && !o.required)).toBe(true);
	});
});
