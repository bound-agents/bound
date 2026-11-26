/**
 * OpenCode Go `/models` catalog parser (2026-11-21-model-catalog.md §2.1, §4.1).
 *
 * `GET https://opencode.ai/zen/go/v1/models` returns `{ data: [...] }` where each
 * row publishes its type, modalities, tool/reasoning capabilities, context and
 * output limits, per-token cost (with context-threshold overrides), and the wire
 * protocols it is served on (`api`, plus a `recommended_api`). This module turns
 * that listing into routable catalog entries: one per chat model the driver can
 * speak (`chat-completions`, `messages`, `responses`), each carrying the chosen
 * protocol, the protocol's base URL, and a provider-neutral `DiscoveredModel`.
 *
 * Non-chat rows (`type: "decision"`, `type: "embedding"`) and chat rows whose
 * advertised protocols are all unsupported (`interactions`, `generate-content`,
 * `systemone`, `embeddings`) are excluded, exactly as Copilot excludes models
 * whose endpoints it cannot route. A row with no `api` block (minimal listing)
 * falls back to the model-family protocol rule.
 */

import type { DiscoveredModel } from "../catalog/discovery";
import type {
	PricingTier,
	ResolvedCapabilities,
	ResolvedPricing,
} from "../catalog/resolve-metadata";
import { isRecord } from "../is-record";

export type OpenCodeGoProtocol = "chat-completions" | "messages" | "responses";

/** Protocol keys the driver can serve, in the fallback preference order. */
const SUPPORTED_PROTOCOLS_IN_ORDER: readonly OpenCodeGoProtocol[] = [
	"messages",
	"responses",
	"chat-completions",
];

export interface OpenCodeGoCatalogEntry {
	/** Raw provider model id (e.g. `deepseek-v4.1-flash`). */
	id: string;
	/** Wire protocol this entry is served on. */
	protocol: OpenCodeGoProtocol;
	/** Base URL published for `protocol`, when the row's `api` block lists one. */
	apiBaseUrl?: string;
	discovered: DiscoveredModel;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isSupportedProtocol(value: unknown): value is OpenCodeGoProtocol {
	return (
		typeof value === "string" && (SUPPORTED_PROTOCOLS_IN_ORDER as readonly string[]).includes(value)
	);
}

export function stripOpenCodeGoModelPrefix(modelId: string): string {
	return modelId.startsWith("opencode-go/") ? modelId.slice("opencode-go/".length) : modelId;
}

/**
 * Model-family protocol rule for rows without an `api` block and static
 * configs: Qwen / MiniMax serve Anthropic `/messages`; everything else OpenAI
 * `/chat/completions`.
 */
export function fallbackOpenCodeGoProtocol(modelId: string): OpenCodeGoProtocol {
	const normalized = stripOpenCodeGoModelPrefix(modelId).toLowerCase();
	return normalized.startsWith("minimax-") || normalized.startsWith("qwen")
		? "messages"
		: "chat-completions";
}

/**
 * Choose the wire protocol for one row: `recommended_api` when the driver speaks
 * it, else the first supported key in `api` (messages → responses →
 * chat-completions). `null` when `api` lists only unsupported protocols. A row
 * with no `api` block uses the model-family fallback.
 */
export function selectOpenCodeGoProtocol(
	row: Record<string, unknown>,
	id: string,
): { protocol: OpenCodeGoProtocol; apiBaseUrl?: string } | null {
	const api = row.api;
	if (!isRecord(api)) {
		return { protocol: fallbackOpenCodeGoProtocol(id) };
	}
	const baseUrlFor = (protocol: OpenCodeGoProtocol): string | undefined => {
		const surface = api[protocol];
		return isRecord(surface) && typeof surface.base_url === "string" && surface.base_url
			? surface.base_url
			: undefined;
	};
	const recommended = row.recommended_api;
	if (isSupportedProtocol(recommended) && recommended in api) {
		const apiBaseUrl = baseUrlFor(recommended);
		return { protocol: recommended, ...(apiBaseUrl !== undefined && { apiBaseUrl }) };
	}
	for (const protocol of SUPPORTED_PROTOCOLS_IN_ORDER) {
		if (protocol in api) {
			const apiBaseUrl = baseUrlFor(protocol);
			return { protocol, ...(apiBaseUrl !== undefined && { apiBaseUrl }) };
		}
	}
	return null;
}

function parseCapabilities(row: Record<string, unknown>): ResolvedCapabilities | undefined {
	const caps: ResolvedCapabilities = {};
	const limit = isRecord(row.limit) ? row.limit : undefined;
	const context = asNumber(limit?.context);
	if (context !== undefined && context > 0) caps.max_context = context;

	const modalities = isRecord(row.modalities) ? row.modalities : undefined;
	if (Array.isArray(modalities?.input)) {
		caps.vision = modalities.input.some(
			(m) => typeof m === "string" && (m === "image" || m.startsWith("image/")),
		);
	}

	const published = isRecord(row.capabilities) ? row.capabilities : undefined;
	const tools = isRecord(published?.tools) ? published.tools : undefined;
	if (typeof tools?.supported === "boolean") caps.tool_use = tools.supported;

	const reasoning = isRecord(published?.reasoning) ? published.reasoning : undefined;
	if (typeof reasoning?.supported === "boolean") {
		const efforts = Array.isArray(reasoning.effort)
			? reasoning.effort.filter((e): e is string => typeof e === "string")
			: [];
		caps.reasoning = {
			supported: reasoning.supported,
			...(efforts.length > 0 && { effort_values: efforts }),
		};
		caps.extended_thinking = reasoning.supported;
	}
	return Object.keys(caps).length > 0 ? caps : undefined;
}

/** `{ gt: N }` threshold of one cost override, or undefined when not a context tier. */
function contextThreshold(override: unknown): number | undefined {
	if (!isRecord(override) || !isRecord(override.when)) return undefined;
	const ctx = override.when.context;
	return isRecord(ctx) ? asNumber(ctx.gt) : undefined;
}

/**
 * `cost.text` → `ResolvedPricing`. Base prices come from `input.price`,
 * `input.cache.read` / `.write`, and `output.price`; each `overrides[]` entry
 * gated on `when.context.gt` becomes (or merges into) a context tier at that
 * threshold, ascending.
 */
export function parseOpenCodeGoPricing(cost: unknown): ResolvedPricing | undefined {
	if (!isRecord(cost) || !isRecord(cost.text)) return undefined;
	const input = isRecord(cost.text.input) ? cost.text.input : undefined;
	const output = isRecord(cost.text.output) ? cost.text.output : undefined;
	const pricing: ResolvedPricing = {};
	const tiers = new Map<number, PricingTier>();
	const tierAt = (threshold: number): PricingTier => {
		let tier = tiers.get(threshold);
		if (!tier) {
			tier = { threshold };
			tiers.set(threshold, tier);
		}
		return tier;
	};

	if (input) {
		const price = asNumber(input.price);
		if (price !== undefined) pricing.input_per_m = price;
		const cache = isRecord(input.cache) ? input.cache : undefined;
		const read = asNumber(cache?.read);
		const write = asNumber(cache?.write);
		if (read !== undefined) pricing.cache_read_per_m = read;
		if (write !== undefined) pricing.cache_write_5m_per_m = write;
		if (Array.isArray(input.overrides)) {
			for (const override of input.overrides) {
				const threshold = contextThreshold(override);
				if (threshold === undefined || !isRecord(override)) continue;
				const tier = tierAt(threshold);
				const tierPrice = asNumber(override.price);
				if (tierPrice !== undefined) tier.input_per_m = tierPrice;
				const tierCache = isRecord(override.cache) ? override.cache : undefined;
				const tierRead = asNumber(tierCache?.read);
				const tierWrite = asNumber(tierCache?.write);
				if (tierRead !== undefined) tier.cache_read_per_m = tierRead;
				if (tierWrite !== undefined) tier.cache_write_5m_per_m = tierWrite;
			}
		}
	}
	if (output) {
		const price = asNumber(output.price);
		if (price !== undefined) pricing.output_per_m = price;
		if (Array.isArray(output.overrides)) {
			for (const override of output.overrides) {
				const threshold = contextThreshold(override);
				if (threshold === undefined || !isRecord(override)) continue;
				const tierPrice = asNumber(override.price);
				if (tierPrice !== undefined) tierAt(threshold).output_per_m = tierPrice;
			}
		}
	}
	if (tiers.size > 0) {
		pricing.tiers = [...tiers.values()].sort((a, b) => a.threshold - b.threshold);
	}
	return Object.keys(pricing).length > 0 ? pricing : undefined;
}

/** One `/models` row → `DiscoveredModel` (no routability filtering). */
export function opencodeGoRowToDiscoveredModel(
	row: Record<string, unknown>,
	id: string,
): DiscoveredModel {
	const capabilities = parseCapabilities(row);
	const limit = isRecord(row.limit) ? row.limit : undefined;
	const maxOutputTokens = asNumber(limit?.output);
	const pricing = parseOpenCodeGoPricing(row.cost);
	return {
		providerModelId: id,
		...(typeof row.name === "string" && row.name && { displayName: row.name }),
		...(capabilities && { capabilities }),
		...(maxOutputTokens !== undefined && maxOutputTokens > 0 && { maxOutputTokens }),
		...(pricing && { pricing }),
	};
}

/**
 * Parse the `/models` response into routable chat-model catalog entries.
 * Non-chat rows and rows with no supported protocol are dropped. Accepts either
 * `{ data: [...] }` or a bare array; anything else yields `[]`.
 */
export function parseOpenCodeGoModels(json: unknown): OpenCodeGoCatalogEntry[] {
	const rows = Array.isArray(json)
		? json
		: isRecord(json) && Array.isArray(json.data)
			? json.data
			: [];
	const out: OpenCodeGoCatalogEntry[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		if (!isRecord(row) || typeof row.id !== "string" || !row.id) continue;
		if (row.type !== undefined && row.type !== "chat") continue;
		if (seen.has(row.id)) continue;
		const selected = selectOpenCodeGoProtocol(row, row.id);
		if (!selected) continue;
		seen.add(row.id);
		out.push({
			id: row.id,
			protocol: selected.protocol,
			...(selected.apiBaseUrl !== undefined && { apiBaseUrl: selected.apiBaseUrl }),
			discovered: opencodeGoRowToDiscoveredModel(row, row.id),
		});
	}
	return out;
}
