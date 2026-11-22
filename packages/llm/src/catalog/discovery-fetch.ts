/**
 * Provider discovery-fetch parse helpers (slice 6, R-MC3,
 * 2026-11-21-model-catalog.md §4.1).
 *
 * The transport (credentials, endpoint URL, abort wiring) lives in each driver;
 * these functions parse the JSON body of the two models-list endpoints that have
 * a concrete driver in-tree into a provider-neutral `DiscoveredModel[]`:
 *
 *   - Anthropic `/v1/models` — `{ data: [{ id, display_name?, ... }] }`, and
 *     under the fallback beta each row may carry `allowed_fallback_models`
 *     (catalog §4.1);
 *   - OpenAI-compatible `/v1/models` — `{ object: "list", data: [{ id, ... }] }`.
 *
 * Both are total: a malformed row is skipped and a missing `data` array yields
 * `[]`, so a reachable-but-unexpected body never throws out of discovery (the
 * driver can still fall back to config + `models.dev`). Metadata enrichment
 * beyond ids is deliberately minimal — the `/v1/models` endpoints expose little
 * structured metadata, and `models.dev` is the metadata fallback layer.
 */

import type { DiscoveredModel } from "./discovery";

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function dataArray(body: unknown): unknown[] {
	if (!isRecord(body) || !Array.isArray(body.data)) return [];
	return body.data;
}

function stringId(row: unknown): string | undefined {
	if (!isRecord(row)) return undefined;
	return typeof row.id === "string" && row.id.length > 0 ? row.id : undefined;
}

function summaryArray(body: unknown, key: string): unknown[] {
	if (!isRecord(body) || !Array.isArray(body[key])) return [];
	return body[key] as unknown[];
}

function stringField(row: unknown, key: string): string | undefined {
	if (!isRecord(row)) return undefined;
	const v = row[key];
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Parse an Anthropic `/v1/models` body. Captures `allowed_fallback_models` when
 * present (fallback beta) and stamps `vendor: "anthropic"`.
 */
export function parseAnthropicModelsList(body: unknown): DiscoveredModel[] {
	const out: DiscoveredModel[] = [];
	for (const row of dataArray(body)) {
		const id = stringId(row);
		if (!id) continue;
		const model: DiscoveredModel = { providerModelId: id, vendor: "anthropic" };
		if (isRecord(row) && Array.isArray(row.allowed_fallback_models)) {
			const targets = row.allowed_fallback_models.filter((t): t is string => typeof t === "string");
			if (targets.length > 0) model.allowedFallbackModels = targets;
		}
		out.push(model);
	}
	return out;
}

/**
 * Parse an OpenAI / OpenAI-compatible `/v1/models` body into bare model ids.
 * These endpoints expose no capability/pricing metadata, so the layered
 * resolver fills the rest from `models.dev` + local config.
 */
export function parseOpenAIModelsList(body: unknown): DiscoveredModel[] {
	const out: DiscoveredModel[] = [];
	for (const row of dataArray(body)) {
		const id = stringId(row);
		if (!id) continue;
		out.push({ providerModelId: id });
	}
	return out;
}

/**
 * Parse a Bedrock `ListFoundationModels` body — `{ modelSummaries: [{ modelId,
 * providerName?, inputModalities?, ... }] }`. Captures the vendor from
 * `providerName` and surfaces an `IMAGE` input modality as a vision capability;
 * everything else (context window, pricing) fills from `models.dev` + config.
 * Total: a malformed row is skipped and a missing array yields `[]`.
 */
export function parseBedrockFoundationModels(body: unknown): DiscoveredModel[] {
	const out: DiscoveredModel[] = [];
	for (const row of summaryArray(body, "modelSummaries")) {
		const id = stringField(row, "modelId");
		if (!id) continue;
		const model: DiscoveredModel = { providerModelId: id };
		const vendor = stringField(row, "providerName");
		if (vendor) model.vendor = vendor;
		if (isRecord(row) && Array.isArray(row.inputModalities)) {
			if (row.inputModalities.some((m) => typeof m === "string" && m.toUpperCase() === "IMAGE")) {
				model.capabilities = { vision: true };
			}
		}
		out.push(model);
	}
	return out;
}

/**
 * Parse a Bedrock `ListInferenceProfiles` body — `{ inferenceProfileSummaries:
 * [{ inferenceProfileId, ... }] }`. The profile id is the region-prefixed
 * cross-region routing id (`us.anthropic.claude-…`); normalization strips the
 * region prefix so it groups with the bare foundation-model id. Total.
 */
export function parseBedrockInferenceProfiles(body: unknown): DiscoveredModel[] {
	const out: DiscoveredModel[] = [];
	for (const row of summaryArray(body, "inferenceProfileSummaries")) {
		const id = stringField(row, "inferenceProfileId");
		if (!id) continue;
		out.push({ providerModelId: id });
	}
	return out;
}

/**
 * Parse an Ollama `/api/tags` body — `{ models: [{ name, model?, ... }] }`.
 * Prefers the canonical `model` field over the display `name`; these rows carry
 * no capability/pricing metadata (that comes from `/api/show` or `models.dev`).
 * Total: a row with neither `model` nor `name` is skipped; a missing array
 * yields `[]`.
 */
export function parseOllamaTags(body: unknown): DiscoveredModel[] {
	const out: DiscoveredModel[] = [];
	for (const row of summaryArray(body, "models")) {
		const id = stringField(row, "model") ?? stringField(row, "name");
		if (!id) continue;
		out.push({ providerModelId: id });
	}
	return out;
}
