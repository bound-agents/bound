import type { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { insertRow, softDelete, updateRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import type { SignatureFormat } from "@bound/shared";

// ---------------------------------------------------------------------------
// webhookCreate
// ---------------------------------------------------------------------------

export function webhookCreate(db: Database, siteId: string, args: string[]): void {
	// Parse args: --name, --format, --description, --prompt
	const name = getArgValue(args, "--name");
	const format = (getArgValue(args, "--format") || "github") as SignatureFormat;
	const description = getArgValue(args, "--description");
	const prompt = getArgValue(args, "--prompt");

	// Validate name: /^[a-z0-9][a-z0-9_-]{0,63}$/
	if (!name) {
		throw new Error("--name is required");
	}

	const nameRegex = /^[a-z0-9][a-z0-9_-]{0,63}$/;
	if (!nameRegex.test(name)) {
		throw new Error(
			`Invalid webhook name '${name}'. Must match /^[a-z0-9][a-z0-9_-]{0,63}$/ (lowercase, digits, underscores, dashes, 2-64 chars)`,
		);
	}

	// Check for existing non-deleted webhook
	const existing = db
		.prepare("SELECT id FROM webhooks WHERE name = ? AND deleted = 0")
		.get(name) as { id: string } | null;

	if (existing) {
		throw new Error(`Webhook '${name}' already exists.`);
	}

	// Generate 256-bit secret (64 hex chars)
	const secret = randomBytes(32).toString("hex");

	const now = new Date().toISOString();

	// Create thread for webhook message delivery
	const threadId = randomUUID();
	insertRow(
		db,
		"threads",
		{
			id: threadId,
			user_id: "system",
			interface: "webhook",
			host_origin: siteId,
			color: 0,
			title: `Webhook: ${name}`,
			summary: null,
			summary_through: null,
			summary_model_id: null,
			extracted_through: null,
			model_hint: null,
			created_at: now,
			last_message_at: now,
			modified_at: now,
			deleted: 0,
		},
		siteId,
	);

	// Create event task
	const taskId = randomUUID();
	insertRow(
		db,
		"tasks",
		{
			id: taskId,
			type: "event",
			status: "pending",
			trigger_spec: `webhook:${name}`,
			payload: null,
			created_at: now,
			created_by: siteId,
			thread_id: threadId,
			origin_thread_id: null,
			claimed_by: null,
			claimed_at: null,
			lease_id: null,
			next_run_at: null,
			last_run_at: null,
			run_count: 0,
			max_runs: null,
			requires: null,
			model_hint: null,
			no_history: 0,
			inject_mode: "results",
			depends_on: null,
			require_success: 0,
			alert_threshold: 3,
			consecutive_failures: 0,
			event_depth: 0,
			no_quiescence: 0,
			heartbeat_at: null,
			result: null,
			error: null,
			system_prompt_addition: prompt || null,
			modified_at: now,
			deleted: 0,
		},
		siteId,
	);

	// Create webhook row
	const webhookId = deterministicUUID(BOUND_NAMESPACE, `webhook:${name}`);
	insertRow(
		db,
		"webhooks",
		{
			id: webhookId,
			name,
			secret,
			signature_format: format,
			description: description || null,
			task_id: taskId,
			thread_id: threadId,
			created_at: now,
			deleted: 0,
			modified_at: now,
		},
		siteId,
	);

	// Print output
	console.log(`Webhook created: ${name}`);
	console.log(`URL: /webhook/${name}`);
	console.log(`Secret: ${secret}`);
	console.log(`Format: ${format}`);
	console.log("");
	console.log("⚠ Save the secret now — it will not be shown again.");
}

// ---------------------------------------------------------------------------
// webhookList
// ---------------------------------------------------------------------------

export function webhookList(db: Database): void {
	const rows = db
		.prepare(
			"SELECT name, signature_format, description, created_at FROM webhooks WHERE deleted = 0 ORDER BY created_at DESC",
		)
		.all() as Array<{
		name: string;
		signature_format: string;
		description: string | null;
		created_at: string;
	}>;

	if (rows.length === 0) {
		console.log("No webhooks found.");
		return;
	}

	console.log("NAME              FORMAT    DESCRIPTION          CREATED");
	console.log("-".repeat(75));

	for (const row of rows) {
		const name = row.name.padEnd(16);
		const format = row.signature_format.padEnd(9);
		const desc = (row.description || "").slice(0, 20).padEnd(20);
		const created = row.created_at.slice(0, 19);
		console.log(`${name} ${format} ${desc} ${created}`);
	}
}

// ---------------------------------------------------------------------------
// webhookDelete
// ---------------------------------------------------------------------------

export function webhookDelete(db: Database, siteId: string, name: string): void {
	const webhook = db
		.prepare("SELECT id, task_id FROM webhooks WHERE name = ? AND deleted = 0")
		.get(name) as { id: string; task_id: string } | null;

	if (!webhook) {
		throw new Error(`Webhook '${name}' not found.`);
	}

	// Soft-delete webhook
	softDelete(db, "webhooks", webhook.id, siteId);

	// Cancel associated task
	updateRow(
		db,
		"tasks",
		webhook.task_id,
		{
			status: "cancelled",
		},
		siteId,
	);

	console.log(`Webhook '${name}' deleted.`);
}

// ---------------------------------------------------------------------------
// webhookUpdate
// ---------------------------------------------------------------------------

export function webhookUpdate(db: Database, siteId: string, args: string[]): void {
	const name = getArgValue(args, "--name");
	const prompt = getArgValue(args, "--prompt");
	const description = getArgValue(args, "--description");
	const format = getArgValue(args, "--format");

	if (!name) {
		throw new Error("--name is required");
	}

	const webhook = db
		.prepare("SELECT id, task_id FROM webhooks WHERE name = ? AND deleted = 0")
		.get(name) as { id: string; task_id: string } | null;

	if (!webhook) {
		throw new Error(`Webhook '${name}' not found.`);
	}

	if (prompt) {
		updateRow(
			db,
			"tasks",
			webhook.task_id,
			{
				system_prompt_addition: prompt,
			},
			siteId,
		);
	}

	if (description !== undefined) {
		updateRow(
			db,
			"webhooks",
			webhook.id,
			{
				description: description || null,
			},
			siteId,
		);
	}

	if (format) {
		updateRow(
			db,
			"webhooks",
			webhook.id,
			{
				signature_format: format as SignatureFormat,
			},
			siteId,
		);
	}

	console.log(`Webhook '${name}' updated.`);
}

// ---------------------------------------------------------------------------
// webhookRotateSecret
// ---------------------------------------------------------------------------

export function webhookRotateSecret(db: Database, siteId: string, name: string): void {
	const webhook = db
		.prepare("SELECT id FROM webhooks WHERE name = ? AND deleted = 0")
		.get(name) as { id: string } | null;

	if (!webhook) {
		throw new Error(`Webhook '${name}' not found.`);
	}

	const newSecret = randomBytes(32).toString("hex");

	updateRow(
		db,
		"webhooks",
		webhook.id,
		{
			secret: newSecret,
		},
		siteId,
	);

	console.log(`New secret for '${name}': ${newSecret}`);
	console.log("⚠ Save the secret now — it will not be shown again.");
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function getArgValue(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	return idx !== -1 ? args[idx + 1] : undefined;
}
