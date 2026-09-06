import type { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { BOUND_NAMESPACE, type SignatureFormat, deterministicUUID } from "@bound/shared";
import { insertRow, updateRow } from "../change-log";
import { findWebhookDeletedFlagById } from "./webhooks";

export interface CreateWebhookBindingInput {
	name: string;
	signatureFormat: SignatureFormat;
	description: string | null;
	prompt: string | null;
	modelHint: string | null;
	noHistory: 0 | 1;
}

export interface CreatedWebhookBinding {
	webhookId: string;
	taskId: string;
	threadId: string;
	secret: string;
}

/** Creates the persisted delivery binding after caller-owned policy checks. */
export function createWebhookBinding(
	db: Database,
	siteId: string,
	input: CreateWebhookBindingInput,
): CreatedWebhookBinding {
	const { name, signatureFormat, description, prompt, modelHint, noHistory } = input;
	const secret = randomBytes(32).toString("hex");
	const now = new Date().toISOString();
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
			model_hint: modelHint,
			created_at: now,
			last_message_at: now,
			modified_at: now,
			deleted: 0,
		},
		siteId,
	);
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
			model_hint: modelHint,
			no_history: noHistory,
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
			system_prompt_addition: prompt,
			modified_at: now,
			deleted: 0,
		},
		siteId,
	);
	const webhookId = deterministicUUID(BOUND_NAMESPACE, `webhook:${name}`);
	const row = {
		name,
		secret,
		signature_format: signatureFormat,
		description,
		task_id: taskId,
		thread_id: threadId,
		created_at: now,
		deleted: 0,
		modified_at: now,
	};
	if (findWebhookDeletedFlagById(db, webhookId)) updateRow(db, "webhooks", webhookId, row, siteId);
	else insertRow(db, "webhooks", { id: webhookId, ...row }, siteId);
	return { webhookId, taskId, threadId, secret };
}
