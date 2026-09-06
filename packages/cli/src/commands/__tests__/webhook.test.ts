import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import {
	webhookCreate,
	webhookDelete,
	webhookList,
	webhookRotateSecret,
	webhookUpdate,
} from "../webhook.js";

const SITE_ID = "test-site";

describe("webhook commands", () => {
	let db: Database;
	let originalLog: typeof console.log;

	beforeEach(() => {
		originalLog = console.log;
		// In-memory DB: these tests pass the `db` object directly to the command
		// under test and never reopen from a path, so a file-backed temp DB only
		// adds a Windows EBUSY hazard (rmSync racing the still-closing WAL handle).
		db = new Database(":memory:");
		applySchema(db);
		console.log = () => {};
	});

	function collectOutput(): string[] {
		const output: string[] = [];
		console.log = (message: string) => output.push(message);
		return output;
	}

	afterEach(() => {
		console.log = originalLog;
		if (db) db.close();
	});

	// Task 1: webhookCreate
	describe("webhookCreate", () => {
		it("should create a webhook with valid name and generate 64-char secret", () => {
			const output = collectOutput();

			webhookCreate(db, SITE_ID, ["--name", "my-webhook", "--format", "github"]);

			// Verify webhook row exists
			const webhook = db
				.prepare("SELECT * FROM webhooks WHERE name = ? AND deleted = 0")
				.get("my-webhook") as {
				id: string;
				name: string;
				secret: string;
				signature_format: string;
				task_id: string;
				thread_id: string;
				created_at: string;
			} | null;

			expect(webhook).not.toBeNull();
			expect(webhook?.name).toBe("my-webhook");
			expect(webhook?.signature_format).toBe("github");
			expect(webhook?.secret.length).toBe(64);
			expect(/^[a-f0-9]{64}$/.test(webhook?.secret || "")).toBe(true);

			// Verify task row exists
			const task = db
				.prepare("SELECT id, type, status, trigger_spec FROM tasks WHERE id = ?")
				.get(webhook?.task_id) as {
				id: string;
				type: string;
				status: string;
				trigger_spec: string;
			} | null;

			expect(task).not.toBeNull();
			expect(task?.type).toBe("event");
			expect(task?.status).toBe("pending");
			expect(task?.trigger_spec).toBe("webhook:my-webhook");

			// Verify thread row exists
			const thread = db
				.prepare("SELECT id, interface, title FROM threads WHERE id = ?")
				.get(webhook?.thread_id) as {
				id: string;
				interface: string;
				title: string;
			} | null;

			expect(thread).not.toBeNull();
			expect(thread?.interface).toBe("webhook");
			expect(thread?.title).toBe("Webhook: my-webhook");

			// Verify output includes secret
			const outputStr = output.join("\n");
			expect(outputStr).toContain("Webhook created: my-webhook");
			expect(outputStr).toContain("URL: /webhook/my-webhook");
			expect(outputStr).toContain(`Secret: ${webhook?.secret}`);
			expect(outputStr).toContain("Format: github");
		});

		it("propagates persistence errors before emitting any creation output", () => {
			const output = collectOutput();
			db.exec(`
				CREATE TRIGGER abort_cli_webhook_task_insert
				BEFORE INSERT ON tasks
				WHEN NEW.trigger_spec = 'webhook:persistence-failure'
				BEGIN SELECT RAISE(ABORT, 'forced CLI persistence failure'); END
			`);

			expect(() => {
				webhookCreate(db, SITE_ID, ["--name", "persistence-failure"]);
			}).toThrow("forced CLI persistence failure");
			expect(output).toEqual([]);
			expect(db.prepare("SELECT COUNT(*) AS count FROM threads").get()).toEqual({ count: 1 });
			expect(db.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 0 });
			expect(db.prepare("SELECT COUNT(*) AS count FROM webhooks").get()).toEqual({ count: 0 });
		});

		it("should reject webhook name with uppercase letters", () => {
			expect(() => {
				webhookCreate(db, SITE_ID, ["--name", "MyWebhook"]);
			}).toThrow(/Invalid webhook name/);
		});

		it("should reject webhook name with special characters", () => {
			expect(() => {
				webhookCreate(db, SITE_ID, ["--name", "my webhook!"]);
			}).toThrow(/Invalid webhook name/);
		});

		it("should reject webhook name longer than 64 chars", () => {
			const longName = "a".repeat(65);
			expect(() => {
				webhookCreate(db, SITE_ID, ["--name", longName]);
			}).toThrow(/Invalid webhook name/);
		});

		it("should create webhook with custom description and prompt", () => {
			webhookCreate(db, SITE_ID, [
				"--name",
				"my-webhook",
				"--description",
				"My test webhook",
				"--prompt",
				"Custom system prompt",
			]);

			const webhook = db
				.prepare("SELECT description FROM webhooks WHERE name = ?")
				.get("my-webhook") as { description: string | null } | null;

			expect(webhook?.description).toBe("My test webhook");

			const webhookRow = db
				.prepare("SELECT task_id FROM webhooks WHERE name = ?")
				.get("my-webhook") as { task_id: string } | null;

			expect(webhookRow).not.toBeNull();

			if (!webhookRow) return;

			const task = db
				.prepare("SELECT system_prompt_addition FROM tasks WHERE id = ?")
				.get(webhookRow.task_id) as { system_prompt_addition: string | null } | null;

			expect(task?.system_prompt_addition).toBe("Custom system prompt");
		});

		it("should reject duplicate webhook name", () => {
			webhookCreate(db, SITE_ID, ["--name", "duplicate"]);

			expect(() => {
				webhookCreate(db, SITE_ID, ["--name", "duplicate"]);
			}).toThrow(/already exists/);
		});

		it("should allow reusing the name of a previously-deleted webhook", () => {
			// Create, capture the deterministic id + original secret/task/thread.
			webhookCreate(db, SITE_ID, ["--name", "recycle"]);
			const original = db
				.prepare(
					"SELECT id, secret, task_id, thread_id FROM webhooks WHERE name = ? AND deleted = 0",
				)
				.get("recycle") as {
				id: string;
				secret: string;
				task_id: string;
				thread_id: string;
			};

			// Soft-delete it: the deterministic-id row is still present with deleted=1.
			webhookDelete(db, SITE_ID, "recycle");
			const afterDelete = db
				.prepare("SELECT deleted FROM webhooks WHERE id = ?")
				.get(original.id) as { deleted: number } | null;
			expect(afterDelete?.deleted).toBe(1);

			// Re-create the same name. Pre-fix this throws on the PK collision;
			// post-fix it restores the soft-deleted row in place.
			const output = collectOutput();
			expect(() => {
				webhookCreate(db, SITE_ID, ["--name", "recycle"]);
			}).not.toThrow();

			// Exactly one row for this id, restored to deleted=0, with a fresh
			// secret and fresh task/thread wiring.
			const restored = db
				.prepare("SELECT id, secret, task_id, thread_id, deleted FROM webhooks WHERE id = ?")
				.get(original.id) as {
				id: string;
				secret: string;
				task_id: string;
				thread_id: string;
				deleted: number;
			} | null;
			expect(restored).not.toBeNull();
			expect(restored?.deleted).toBe(0);
			expect(restored?.secret).not.toBe(original.secret);
			expect(restored?.task_id).not.toBe(original.task_id);
			expect(restored?.thread_id).not.toBe(original.thread_id);
			expect(db.prepare("SELECT id FROM tasks WHERE id = ?").get(restored?.task_id)).toEqual({
				id: restored?.task_id,
			});
			expect(db.prepare("SELECT id FROM threads WHERE id = ?").get(restored?.thread_id)).toEqual({
				id: restored?.thread_id,
			});
			expect(output).toContain(`Secret: ${restored?.secret}`);

			// Only one webhook with this name should be live.
			const liveCount = db
				.prepare("SELECT COUNT(*) AS n FROM webhooks WHERE name = ? AND deleted = 0")
				.get("recycle") as { n: number };
			expect(liveCount.n).toBe(1);
		});
	});

	// Task 2: webhookList
	describe("webhookList", () => {
		it("should list webhooks without secrets", () => {
			webhookCreate(db, SITE_ID, ["--name", "webhook1", "--description", "First"]);
			webhookCreate(db, SITE_ID, ["--name", "webhook2", "--description", "Second"]);

			const output = collectOutput();

			webhookList(db);

			const outputStr = output.join("\n");
			expect(outputStr).toContain("webhook1");
			expect(outputStr).toContain("webhook2");
			expect(outputStr).toContain("First");
			expect(outputStr).toContain("Second");
			expect(outputStr).not.toContain("secret");
		});

		it("should show empty message when no webhooks exist", () => {
			const output = collectOutput();

			webhookList(db);

			expect(output.join("\n")).toContain("No webhooks found");
		});
	});

	// Task 2: webhookDelete
	describe("webhookDelete", () => {
		it("should soft-delete webhook and cancel task", () => {
			webhookCreate(db, SITE_ID, ["--name", "to-delete"]);

			const webhook = db
				.prepare("SELECT id, task_id FROM webhooks WHERE name = ?")
				.get("to-delete") as { id: string; task_id: string };

			const output = collectOutput();

			webhookDelete(db, SITE_ID, "to-delete");

			// Verify soft delete (deleted = 1)
			const deletedWebhook = db
				.prepare("SELECT deleted FROM webhooks WHERE id = ?")
				.get(webhook.id) as { deleted: number } | null;

			expect(deletedWebhook?.deleted).toBe(1);

			// Verify task is cancelled
			const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get(webhook.task_id) as {
				status: string;
			} | null;

			expect(task?.status).toBe("cancelled");

			expect(output.join("\n")).toContain("deleted");
		});

		it("should throw error if webhook not found", () => {
			expect(() => {
				webhookDelete(db, SITE_ID, "nonexistent");
			}).toThrow(/not found/);
		});
	});

	// Task 2: webhookUpdate
	describe("webhookUpdate", () => {
		it("should update webhook prompt via system_prompt_addition", () => {
			webhookCreate(db, SITE_ID, ["--name", "update-test"]);

			const webhook = db
				.prepare("SELECT task_id FROM webhooks WHERE name = ?")
				.get("update-test") as { task_id: string };

			const output = collectOutput();

			webhookUpdate(db, SITE_ID, ["--name", "update-test", "--prompt", "New prompt"]);

			const task = db
				.prepare("SELECT system_prompt_addition FROM tasks WHERE id = ?")
				.get(webhook.task_id) as { system_prompt_addition: string } | null;

			expect(task?.system_prompt_addition).toBe("New prompt");
			expect(output.join("\n")).toContain("updated");
		});

		it("should update webhook description", () => {
			webhookCreate(db, SITE_ID, ["--name", "desc-test"]);

			webhookUpdate(db, SITE_ID, ["--name", "desc-test", "--description", "New description"]);

			const webhook = db
				.prepare("SELECT description FROM webhooks WHERE name = ?")
				.get("desc-test") as { description: string } | null;

			expect(webhook?.description).toBe("New description");
		});

		it("should update webhook signature format", () => {
			webhookCreate(db, SITE_ID, ["--name", "format-test", "--format", "github"]);

			webhookUpdate(db, SITE_ID, ["--name", "format-test", "--format", "stripe"]);

			const webhook = db
				.prepare("SELECT signature_format FROM webhooks WHERE name = ?")
				.get("format-test") as { signature_format: string } | null;

			expect(webhook?.signature_format).toBe("stripe");
		});

		it("should reject unsupported webhook signature formats", () => {
			expect(() =>
				webhookCreate(db, SITE_ID, ["--name", "invalid-format", "--format", "bogus"]),
			).toThrow(/Unsupported signature format/);

			webhookCreate(db, SITE_ID, ["--name", "format-test", "--format", "github"]);
			expect(() =>
				webhookUpdate(db, SITE_ID, ["--name", "format-test", "--format", "bogus"]),
			).toThrow(/Unsupported signature format/);
		});
	});

	// Task 2: webhookRotateSecret
	describe("webhookRotateSecret", () => {
		it("should generate new secret and update webhook row", () => {
			webhookCreate(db, SITE_ID, ["--name", "rotate-test"]);

			const originalWebhook = db
				.prepare("SELECT secret FROM webhooks WHERE name = ?")
				.get("rotate-test") as { secret: string };

			const oldSecret = originalWebhook.secret;

			const output = collectOutput();

			webhookRotateSecret(db, SITE_ID, "rotate-test");

			const newWebhook = db
				.prepare("SELECT secret FROM webhooks WHERE name = ?")
				.get("rotate-test") as { secret: string };

			const newSecret = newWebhook.secret;

			// Verify secret changed and is 64 hex chars
			expect(newSecret).not.toBe(oldSecret);
			expect(newSecret.length).toBe(64);
			expect(/^[a-f0-9]{64}$/.test(newSecret)).toBe(true);

			// Verify output shows new secret
			const outputStr = output.join("\n");
			expect(outputStr).toContain(newSecret);
			expect(outputStr).toContain("Save the secret now");
		});

		it("should throw error if webhook not found", () => {
			expect(() => {
				webhookRotateSecret(db, SITE_ID, "nonexistent");
			}).toThrow(/not found/);
		});
	});

	// --model flag: end-to-end semantics across create, list, update
	describe("--model flag", () => {
		const taskAndThreadModelFor = (
			name: string,
		): { task: string | null; thread: string | null } => {
			const wh = db.prepare("SELECT task_id, thread_id FROM webhooks WHERE name = ?").get(name) as {
				task_id: string;
				thread_id: string;
			};
			const task = db.prepare("SELECT model_hint FROM tasks WHERE id = ?").get(wh.task_id) as {
				model_hint: string | null;
			};
			const thread = db
				.prepare("SELECT model_hint FROM threads WHERE id = ?")
				.get(wh.thread_id) as { model_hint: string | null };
			return { task: task.model_hint, thread: thread.model_hint };
		};

		it("webhookCreate without --model leaves model_hint null on the task and thread", () => {
			webhookCreate(db, SITE_ID, ["--name", "no-model"]);

			const hints = taskAndThreadModelFor("no-model");
			expect(hints.task).toBeNull();
			expect(hints.thread).toBeNull();
		});

		it("webhookCreate with --model sets model_hint on the task and thread", () => {
			webhookCreate(db, SITE_ID, ["--name", "kimi-hook", "--model", "kimi-k2"]);

			const hints = taskAndThreadModelFor("kimi-hook");
			expect(hints.task).toBe("kimi-k2");
			expect(hints.thread).toBe("kimi-k2");
		});

		it("webhookCreate with --model '' is equivalent to omitting the flag", () => {
			webhookCreate(db, SITE_ID, ["--name", "empty-model", "--model", ""]);

			const hints = taskAndThreadModelFor("empty-model");
			expect(hints.task).toBeNull();
			expect(hints.thread).toBeNull();
		});

		it("webhookCreate prints the configured model in the create output", () => {
			const output = collectOutput();

			webhookCreate(db, SITE_ID, ["--name", "print-model", "--model", "kimi-k2"]);

			expect(output.join("\n")).toContain("Model: kimi-k2");
		});

		it("webhookList surfaces the configured model column", () => {
			webhookCreate(db, SITE_ID, ["--name", "listed-default"]);
			webhookCreate(db, SITE_ID, ["--name", "listed-kimi", "--model", "kimi-k2"]);

			const output = collectOutput();
			webhookList(db);
			const joined = output.join("\n");

			expect(joined).toContain("MODEL");
			expect(joined).toContain("kimi-k2");
			expect(joined).toContain("(default)");
		});

		it("webhookUpdate with --model sets model_hint on the task and thread", () => {
			webhookCreate(db, SITE_ID, ["--name", "set-via-update"]);

			webhookUpdate(db, SITE_ID, ["--name", "set-via-update", "--model", "kimi-k2"]);

			const hints = taskAndThreadModelFor("set-via-update");
			expect(hints.task).toBe("kimi-k2");
			expect(hints.thread).toBe("kimi-k2");
		});

		it("webhookUpdate with --model '' clears model_hint back to default", () => {
			webhookCreate(db, SITE_ID, ["--name", "clear-via-update", "--model", "kimi-k2"]);

			webhookUpdate(db, SITE_ID, ["--name", "clear-via-update", "--model", ""]);

			const hints = taskAndThreadModelFor("clear-via-update");
			expect(hints.task).toBeNull();
			expect(hints.thread).toBeNull();
		});

		it("webhookUpdate without --model leaves existing model_hint alone", () => {
			webhookCreate(db, SITE_ID, ["--name", "leave-alone", "--model", "kimi-k2"]);

			webhookUpdate(db, SITE_ID, ["--name", "leave-alone", "--description", "still kimi"]);

			const hints = taskAndThreadModelFor("leave-alone");
			expect(hints.task).toBe("kimi-k2");
			expect(hints.thread).toBe("kimi-k2");
		});
	});

	// --no-history flag: end-to-end semantics across create, list, update (#54)
	describe("--no-history flag", () => {
		const noHistoryFor = (name: string): number | null => {
			const wh = db.prepare("SELECT task_id FROM webhooks WHERE name = ?").get(name) as {
				task_id: string;
			};
			const task = db.prepare("SELECT no_history FROM tasks WHERE id = ?").get(wh.task_id) as {
				no_history: number | null;
			};
			return task.no_history;
		};

		it("webhookCreate without --no-history leaves no_history=0 on the task", () => {
			webhookCreate(db, SITE_ID, ["--name", "default-history"]);

			expect(noHistoryFor("default-history")).toBe(0);
		});

		it("webhookCreate with --no-history sets no_history=1 on the task", () => {
			webhookCreate(db, SITE_ID, ["--name", "no-history-hook", "--no-history"]);

			expect(noHistoryFor("no-history-hook")).toBe(1);
		});

		it("webhookCreate prints History line in the create output", () => {
			const output = collectOutput();

			webhookCreate(db, SITE_ID, ["--name", "history-output", "--no-history"]);

			expect(output.join("\n")).toContain("History: disabled");
		});

		it("webhookList shows H column reflecting per-webhook no_history", () => {
			webhookCreate(db, SITE_ID, ["--name", "with-history"]);
			webhookCreate(db, SITE_ID, ["--name", "without-history", "--no-history"]);

			const output = collectOutput();
			webhookList(db);
			const joined = output.join("\n");

			expect(joined).toContain(" H ");
			// Header + at least one "y" row and one "n" row.
			const lines = joined.split("\n");
			const withHistoryLine = lines.find((l) => l.startsWith("with-history"));
			const withoutHistoryLine = lines.find((l) => l.startsWith("without-history"));
			expect(withHistoryLine).toMatch(/\sn\s/);
			expect(withoutHistoryLine).toMatch(/\sy\s/);
		});

		it("webhookUpdate with --no-history sets no_history=1 on the task", () => {
			webhookCreate(db, SITE_ID, ["--name", "set-via-update"]);

			webhookUpdate(db, SITE_ID, ["--name", "set-via-update", "--no-history"]);

			expect(noHistoryFor("set-via-update")).toBe(1);
		});

		it("webhookUpdate with --history clears no_history back to 0", () => {
			webhookCreate(db, SITE_ID, ["--name", "clear-via-update", "--no-history"]);
			expect(noHistoryFor("clear-via-update")).toBe(1);

			webhookUpdate(db, SITE_ID, ["--name", "clear-via-update", "--history"]);

			expect(noHistoryFor("clear-via-update")).toBe(0);
		});

		it("webhookUpdate without history flags leaves existing no_history alone", () => {
			webhookCreate(db, SITE_ID, ["--name", "leave-alone-history", "--no-history"]);

			webhookUpdate(db, SITE_ID, [
				"--name",
				"leave-alone-history",
				"--description",
				"still no history",
			]);

			expect(noHistoryFor("leave-alone-history")).toBe(1);
		});

		it("webhookUpdate with both --no-history and --history throws", () => {
			webhookCreate(db, SITE_ID, ["--name", "ambiguous"]);

			expect(() => {
				webhookUpdate(db, SITE_ID, ["--name", "ambiguous", "--no-history", "--history"]);
			}).toThrow(/mutually exclusive/);
		});
	});
});
