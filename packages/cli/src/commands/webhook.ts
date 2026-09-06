import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import {
	createWebhookBinding,
	findClusterConfigKeyByKeyIncludingDeleted,
	findClusterConfigValueByKey,
	findWebhookIdAndTaskIdByName,
	findWebhookIdByName,
	findWebhookIdsByName,
	insertRow,
	listWebhooksForCli,
	softDelete,
	updateRow,
} from "@bound/core";
import { WEBHOOKS_ALLOW_UNAUTHENTICATED_KEY } from "@bound/shared";
import type { SignatureFormat } from "@bound/shared";

const SIGNATURE_FORMATS = new Set<SignatureFormat>(["github", "stripe", "slack", "raw", "none"]);

function parseSignatureFormat(value: string): SignatureFormat {
	if (!SIGNATURE_FORMATS.has(value as SignatureFormat)) {
		throw new Error(`Unsupported signature format '${value}'.`);
	}
	return value as SignatureFormat;
}

/**
 * Throws unless the cluster-wide unauthenticated-webhook switch
 * (`cluster_config['webhooks_allow_unauthenticated']`) is set to `"true"`.
 * Shared by create and update so `--format none` is refused identically on
 * both paths (#195).
 */
function assertUnauthenticatedWebhooksAllowed(db: Database): void {
	const allowUnauthenticated = findClusterConfigValueByKey(db, WEBHOOKS_ALLOW_UNAUTHENTICATED_KEY);
	if (allowUnauthenticated?.value !== "true") {
		throw new Error(
			"Unauthenticated webhooks (--format none) are disabled. Enable them cluster-wide first: boundctl webhook allow-unauthenticated",
		);
	}
}

/**
 * Upsert a cluster_config key through the outbox helpers. The existence probe
 * INCLUDES tombstoned rows: a soft-deleted row still occupies the `key` PK, so
 * a re-set must UPDATE (un-tombstoning via deleted=0), never INSERT a colliding
 * row. Mirrors the pattern in drain.ts / set-hub.ts.
 */
function upsertClusterConfig(db: Database, siteId: string, key: string, value: string): void {
	const now = new Date().toISOString();
	if (findClusterConfigKeyByKeyIncludingDeleted(db, key)) {
		updateRow(db, "cluster_config", key, { value, deleted: 0 }, siteId);
	} else {
		insertRow(db, "cluster_config", { key, value, modified_at: now, deleted: 0 }, siteId);
	}
}

/**
 * Flip the cluster-wide unauthenticated-webhook switch (#195). `allow=true`
 * lets operators create `--format none` webhooks and lets those webhooks
 * receive deliveries; `allow=false` (the default state, row absent) blocks
 * both. This is the deliberate, visible opt-in the issue calls for.
 */
export function webhookSetUnauthenticated(db: Database, siteId: string, allow: boolean): void {
	upsertClusterConfig(db, siteId, WEBHOOKS_ALLOW_UNAUTHENTICATED_KEY, allow ? "true" : "false");
	if (allow) {
		console.log("Unauthenticated webhooks are now ALLOWED cluster-wide.");
		console.log("⚠ Any host that can reach POST /webhook/:name can now trigger a 'none'-format");
		console.log("  webhook without a signature. Create them deliberately.");
	} else {
		console.log("Unauthenticated webhooks are now DISABLED cluster-wide (default).");
		console.log("Existing 'none'-format webhooks will stop receiving deliveries (404).");
	}
}

// ---------------------------------------------------------------------------
// webhookCreate
// ---------------------------------------------------------------------------

export function webhookCreate(db: Database, siteId: string, args: string[]): void {
	// Parse args: --name, --format, --description, --prompt, --model, --no-history
	const name = getArgValue(args, "--name");
	const format = parseSignatureFormat(getArgValue(args, "--format") || "github");
	const description = getArgValue(args, "--description");
	const prompt = getArgValue(args, "--prompt");
	const modelHint = getArgValue(args, "--model");
	// Normalise: undefined or empty string both mean "use system default"
	const modelHintValue = modelHint && modelHint.length > 0 ? modelHint : null;
	// --no-history is a presence flag: when set, the webhook's event task runs
	// with no_history=1 so each delivery starts from a clean context window.
	const noHistory = hasFlag(args, "--no-history") ? 1 : 0;

	if (format === "none") {
		assertUnauthenticatedWebhooksAllowed(db);
	}

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
	const existing = findWebhookIdByName(db, name);

	if (existing) {
		throw new Error(`Webhook '${name}' already exists.`);
	}

	const { secret } = createWebhookBinding(db, siteId, {
		name,
		signatureFormat: format,
		description: description || null,
		prompt: prompt || null,
		modelHint: modelHintValue,
		noHistory,
	});

	// Print output
	console.log(`Webhook created: ${name}`);
	console.log(`URL: /webhook/${name}`);
	console.log(`Secret: ${secret}`);
	console.log(`Format: ${format}`);
	console.log(`Model: ${modelHintValue ?? "(default)"}`);
	console.log(`History: ${noHistory ? "disabled (no_history=true)" : "enabled"}`);
	console.log("");
	console.log("⚠ Save the secret now — it will not be shown again.");
}

// ---------------------------------------------------------------------------
// webhookList
// ---------------------------------------------------------------------------

export function webhookList(db: Database): void {
	const rows = listWebhooksForCli(db);

	if (rows.length === 0) {
		console.log("No webhooks found.");
		return;
	}

	// "H" column shows "y" when no_history=1 on the task. One letter to keep
	// the table compact; the long form is in `webhook show`-style detail.
	console.log("NAME              FORMAT    MODEL              H  DESCRIPTION          CREATED");
	console.log("-".repeat(98));

	for (const row of rows) {
		const name = row.name.padEnd(16);
		const format = row.signature_format.padEnd(9);
		const model = (row.model_hint ?? "(default)").slice(0, 18).padEnd(18);
		const noHist = row.no_history === 1 ? "y" : "n";
		const desc = (row.description || "").slice(0, 20).padEnd(20);
		const created = row.created_at.slice(0, 19);
		console.log(`${name} ${format} ${model} ${noHist}  ${desc} ${created}`);
	}
}

// ---------------------------------------------------------------------------
// webhookDelete
// ---------------------------------------------------------------------------

export function webhookDelete(db: Database, siteId: string, name: string): void {
	const webhook = findWebhookIdAndTaskIdByName(db, name);

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
	const formatRaw = getArgValue(args, "--format");
	const format = formatRaw === undefined ? undefined : parseSignatureFormat(formatRaw);
	// Three-state semantics for --model:
	//   flag absent           → leave existing model_hint alone
	//   --model ""            → clear back to system default (null)
	//   --model <id>          → set to <id>
	const modelIdx = args.indexOf("--model");
	const modelProvided = modelIdx !== -1;
	const modelValue = modelProvided ? (args[modelIdx + 1] ?? "") : undefined;

	// Three-state semantics for no_history (mirroring --model):
	//   neither flag        → leave alone
	//   --no-history        → set to 1 (disable history)
	//   --history           → set to 0 (re-enable history)
	// Both flags being passed together is rejected; the operator should pick
	// one to avoid ambiguity about which one wins.
	const wantsNoHistory = hasFlag(args, "--no-history");
	const wantsHistory = hasFlag(args, "--history");
	if (wantsNoHistory && wantsHistory) {
		throw new Error("--no-history and --history are mutually exclusive");
	}
	const noHistoryProvided = wantsNoHistory || wantsHistory;
	const noHistoryValue: 0 | 1 = wantsNoHistory ? 1 : 0;

	if (!name) {
		throw new Error("--name is required");
	}

	const webhook = findWebhookIdsByName(db, name);

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

	if (format === "none") {
		assertUnauthenticatedWebhooksAllowed(db);
	}

	if (format) {
		updateRow(
			db,
			"webhooks",
			webhook.id,
			{
				signature_format: format,
			},
			siteId,
		);
	}

	if (modelProvided) {
		const newHint = modelValue && modelValue.length > 0 ? modelValue : null;
		// Mirror create: set on both the task (which fires) and the thread (which hosts it).
		updateRow(db, "tasks", webhook.task_id, { model_hint: newHint }, siteId);
		updateRow(db, "threads", webhook.thread_id, { model_hint: newHint }, siteId);
	}

	if (noHistoryProvided) {
		// Read by relay-processor at delivery time, so the next webhook fire
		// honours this without needing to recreate the task.
		updateRow(db, "tasks", webhook.task_id, { no_history: noHistoryValue }, siteId);
	}

	console.log(`Webhook '${name}' updated.`);
}

// ---------------------------------------------------------------------------
// webhookRotateSecret
// ---------------------------------------------------------------------------

export function webhookRotateSecret(db: Database, siteId: string, name: string): void {
	const webhook = findWebhookIdByName(db, name);

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

function hasFlag(args: string[], flag: string): boolean {
	return args.indexOf(flag) !== -1;
}
