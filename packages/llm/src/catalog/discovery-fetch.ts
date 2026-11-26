/**
 * Provider discovery-fetch parse helpers (R-MC3, 2026-11-21-model-catalog.md §4.1).
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

import { isRecord } from "../is-record";
import type { BedrockDiscoveryFields, DiscoveredModel } from "./discovery";

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
 * Extract the Bedrock `ListFoundationModels` lineup-filter fields from one
 * `modelSummaries` row, or `undefined` when the row carries none of them. The
 * undocumented-but-live `inferenceAPIsSupported` / `explicitPromptCaching`
 * blocks are read with the same tolerance as the
 * documented `modelLifecycle.status` / `inferenceTypesSupported` / modality
 * lists: a missing nested field stays unset, never guessed, so the namespace
 * lineup filter treats "no signal" as "no protocol".
 */
function parseBedrockLineupFields(row: unknown): BedrockDiscoveryFields | undefined {
	if (!isRecord(row)) return undefined;
	const out: BedrockDiscoveryFields = {};
	const arn = stringField(row, "modelArn");
	if (arn) out.modelArn = arn;
	if (isRecord(row.modelLifecycle)) {
		const status = row.modelLifecycle.status;
		if (typeof status === "string") out.lifecycleStatus = status;
	}
	if (Array.isArray(row.inferenceTypesSupported)) {
		out.inferenceTypes = row.inferenceTypesSupported.filter(
			(t): t is string => typeof t === "string",
		);
	}
	if (Array.isArray(row.inputModalities)) {
		out.inputText = row.inputModalities.some(
			(m) => typeof m === "string" && m.toUpperCase() === "TEXT",
		);
	}
	if (Array.isArray(row.outputModalities)) {
		const mods = row.outputModalities.filter((m): m is string => typeof m === "string");
		out.outputTextOnly = mods.length === 1 && mods[0]?.toUpperCase() === "TEXT";
	}
	if (isRecord(row.inferenceAPIsSupported)) {
		const apis = row.inferenceAPIsSupported;
		if (typeof apis.openAiResponses === "boolean") out.openAiResponses = apis.openAiResponses;
		if (isRecord(apis.converse) && typeof apis.converse.streaming === "boolean") {
			out.converseStreaming = apis.converse.streaming;
		}
	}
	if (
		isRecord(row.explicitPromptCaching) &&
		typeof row.explicitPromptCaching.isSupported === "boolean"
	) {
		out.explicitPromptCaching = row.explicitPromptCaching.isSupported;
	}
	return Object.keys(out).length > 0 ? out : undefined;
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
		const displayName = stringField(row, "display_name");
		if (displayName) model.displayName = displayName;
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
 * providerName?, inputModalities?, converse?, ... }] }`. Captures the vendor from
 * `providerName`, surfaces an `IMAGE` input modality as a vision capability, and
 * reads `converse.maxTokensMaximum` as the provider-published output limit when
 * present; everything else (context window, pricing) fills from `models.dev` +
 * config. A null/absent `maxTokensMaximum` is left unset (no invented value).
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
		if (isRecord(row) && isRecord(row.converse)) {
			// Bedrock Converse publishes the model's maximum output tokens here
			// (`maxTokensMaximum`); `maxTokensDefault` can be null and is not a cap.
			const max = row.converse.maxTokensMaximum;
			if (typeof max === "number" && Number.isFinite(max)) model.maxOutputTokens = max;
		}
		const bedrock = parseBedrockLineupFields(row);
		if (bedrock) model.bedrock = bedrock;
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
		const model: DiscoveredModel = { providerModelId: id };
		if (isRecord(row)) {
			const bedrock: BedrockDiscoveryFields = {};
			if (typeof row.type === "string") bedrock.profileType = row.type;
			if (typeof row.status === "string") bedrock.profileStatus = row.status;
			if (Array.isArray(row.models)) {
				const arns = row.models
					.map((m) => (isRecord(m) && typeof m.modelArn === "string" ? m.modelArn : undefined))
					.filter((a): a is string => a !== undefined);
				if (arns.length > 0) bedrock.profileModelArns = arns;
			}
			if (Object.keys(bedrock).length > 0) model.bedrock = bedrock;
		}
		out.push(model);
	}
	return out;
}
