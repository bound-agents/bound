import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
	findFileContentByIdActive,
	findFirstLiveUserMessageByThreadSince,
	findLatestLiveAssistantMessageCreatedAtByThread,
	insertRow,
	listRecentLiveMessageContentByThread,
} from "@bound/core";
import type { CapabilityRequirements, ContentBlock, LLMMessage, StreamChunk } from "@bound/llm";
import type { FieldSource, PricingTier, ResolvedPricing } from "@bound/llm";
// isTransientLLMError now lives in @bound/loop (error-classification.ts) so the
// base loop and any extension agent share one definition. Re-exported here for
// existing callers and tests that import it from this module.
export { isTransientLLMError } from "@bound/loop";
import { createLogger } from "@bound/shared";
import { calculateDynamicPrice, hasDynamicPrice } from "./dynamic-pricing";
import type { ModelResolution } from "./model-resolution";
import type { RelayWaitResult } from "./relay-wait$";
import type { RegisteredTool } from "./types";
import { isYardClientBookkeepingRow } from "./yard-client-rows";

const logger = createLogger("@bound/agent", "agent-loop-utils");
const warnedDynamicPricingFallbacks = new Set<string>();

export function refreshModelHintAtTurnBoundary(
	config: { modelId?: string },
	readEffectiveModelHint: () => string,
	onChange: () => void,
): boolean {
	const nextModelId = readEffectiveModelHint();
	if (nextModelId === config.modelId) return false;
	config.modelId = nextModelId;
	onChange();
	return true;
}

export function acquireSummaryBackendWithFallback<T>(
	turnModelId: string,
	defaultModelId: string,
	modelIds: string[],
	acquire: (modelId: string) => T | null,
): T | null {
	const candidates = [turnModelId, defaultModelId, ...modelIds];
	for (const modelId of new Set(candidates.filter(Boolean))) {
		const backend = acquire(modelId);
		if (backend) return backend;
	}
	return null;
}

/**
 * Parse persisted message content for the in-memory LLM message path.
 * When content is a JSON-serialized ContentBlock[] carrying a non-text block
 * (image or document), returns the parsed array so drivers can deliver the
 * structured content in the API call. Otherwise returns the original string
 * unchanged.
 *
 * This is the readback counterpart to the live tool-result branch in
 * agent-loop.ts: any role whose row holds a serialized ContentBlock[] — a
 * user prompt with an attached image, or a tool_result with a binary blob —
 * must be parsed back to blocks here, or the driver receives the literal JSON
 * text and the image/document never reaches the model. The image/document
 * guard avoids false-positives on plain-text content that happens to be valid
 * JSON: text-only content is delivered identically as a string.
 */
export function parseContentBlocks(content: string): string | ContentBlock[] {
	try {
		const parsed = JSON.parse(content);
		if (
			Array.isArray(parsed) &&
			parsed.length > 0 &&
			parsed[0]?.type &&
			parsed.some((b: Record<string, unknown>) => b.type === "image" || b.type === "document")
		) {
			return parsed as ContentBlock[];
		}
	} catch {
		// Not JSON — return as-is
	}
	return content;
}

/**
 * Convert persisted assistant content into the public result of an aux invocation.
 * Assistant turns that carry extended-thinking or tool-use blocks are stored as a
 * JSON ContentBlock[] transcript so they can be replayed to the provider. That
 * persistence format is not a caller-facing result: an aux caller receives only
 * the assistant's final visible text.
 */
export function extractAssistantText(content: string): string {
	try {
		const parsed: unknown = JSON.parse(content);
		if (!Array.isArray(parsed) || !parsed.every((block) => block && typeof block === "object")) {
			return content;
		}

		const textBlocks = parsed.filter(
			(block): block is { type: "text"; text: string } =>
				block.type === "text" && typeof block.text === "string",
		);
		return textBlocks.length > 0
			? textBlocks.map((block) => block.text).join("\n")
			: "(no response)";
	} catch {
		return content;
	}
}

/**
 * Finds the first user message in a thread that arrived after the last
 * assistant response — i.e., a message that was likely skipped because
 * the agent loop was already active when it was delivered.
 *
 * Used by the start.ts event handler in its `finally` block: after a loop
 * completes, call this to detect queue-skipped messages and re-trigger.
 */
export function findPendingUserMessage(
	db: Database,
	threadId: string,
): { id: string; content: string; role: "user" } | null {
	const lastAssistant = findLatestLiveAssistantMessageCreatedAtByThread(db, threadId);

	const cutoff = lastAssistant?.created_at ?? "1970-01-01T00:00:00.000Z";

	return findFirstLiveUserMessageByThreadSince(db, threadId, cutoff);
}

// ---------------------------------------------------------------------------
// Message insertion
// ---------------------------------------------------------------------------

interface ThreadMessageOpts {
	threadId: string;
	role: import("@bound/shared").MessageRole;
	content: string;
	hostOrigin: string;
	modelId?: string | null;
	toolName?: string | null;
	exitCode?: number;
	metadata?: Record<string, unknown>;
}

/** Insert a message into a thread via the change-log outbox. Returns the message ID. */
export function insertThreadMessage(db: Database, opts: ThreadMessageOpts, siteId: string): string {
	const id = randomUUID();
	const now = new Date().toISOString();
	insertRow(
		db,
		"messages",
		{
			id,
			thread_id: opts.threadId,
			role: opts.role,
			content: opts.content,
			model_id: opts.modelId ?? null,
			tool_name: opts.toolName ?? null,
			created_at: now,
			modified_at: now,
			host_origin: opts.hostOrigin,
			deleted: 0,
			exit_code: opts.exitCode ?? null,
			metadata: opts.metadata === undefined ? null : JSON.stringify(opts.metadata),
		},
		siteId,
	);
	return id;
}

// ---------------------------------------------------------------------------
// Command output formatting
// ---------------------------------------------------------------------------

/** Build a human-readable result string from command stdout/stderr/exitCode. */
export function buildCommandOutput(
	stdout: string | undefined,
	stderr: string | undefined,
	exitCode: number | undefined,
): string {
	const parts: string[] = [];
	if (stdout) parts.push(stdout);
	if (stderr) parts.push(stderr);
	if (parts.length === 0) {
		parts.push(
			(exitCode ?? 0) === 0 ? "Command completed successfully" : `Exit code: ${exitCode ?? 1}`,
		);
	}
	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Cost calculation
// ---------------------------------------------------------------------------

interface UsageTokens {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	/**
	 * The 1h-TTL subset of `cacheWriteTokens`. `null`/absent means the split is
	 * unknown, in which case every cache-write token is billed at the 5m rate
	 * (today's behavior). Never a guess — a driver that can't see the split
	 * reports null.
	 */
	cacheWrite1hTokens?: number | null;
}

interface BackendPricing {
	id: string;
	// Per-M overrides. PRESENCE (not `> 0`) is the "operator set this" signal:
	// the schema keeps these optional so a deliberate 0 (free local model) is
	// distinguishable from an unset gap. An absent field falls through to
	// catalog (provider/models.dev) pricing (2026-11-21-model-catalog.md §3).
	price_per_m_input?: number;
	price_per_m_output?: number;
	price_per_m_cache_read?: number;
	price_per_m_cache_write?: number;
	/** Per-M price for the 1h cache-write subset; falls back to price_per_m_cache_write. */
	price_per_m_cache_write_1h?: number;
}

/** The four per-component cost parts of a turn, in USD. 1h cache-write folds
 * into `cacheWrite`. */
export interface TurnCostBreakdown {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/**
 * Which layer priced a turn (requirement 4, carried in `cost_breakdown`).
 *   - `config_callback`: a `price(turn)` callback (plain number, no split)
 *   - `config`: an explicitly-set `price_per_m_*` override
 *   - `provider`: provider-published catalog pricing
 *   - `models_dev`: `models.dev` registry pricing
 *   - `provider_reported`: a realized cost stamped on the done chunk
 *   - `unknown`: no layer supplied any price
 */
export type PricingSource =
	"config_callback" | "config" | "provider" | "models_dev" | "provider_reported" | "unknown";

/** Resolved per-component per-M prices plus which layer supplied them. */
interface EffectivePricesPerM {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h: number;
	/** `config` when any component came from an explicit config override, else the catalog source. */
	source: "config" | "provider" | "models_dev";
}

/** The request size that selects a context tier: input + cache-read + cache-write tokens. */
function tierRequestSize(usage: UsageTokens): number {
	return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}

/**
 * Pick the context-tier prices that apply to a request (requirement 2). Tiers are
 * ascending by `threshold`; a tier applies when the request size STRICTLY EXCEEDS
 * its threshold. The highest such tier wins. Below/at the lowest threshold the
 * base prices apply (returns `undefined`). Confirmed against the models.dev
 * payload: `tier.size` is the context boundary, and Bedrock bills the long-context
 * tier above it (e.g. 272000 for GPT-5.6 / 6.x).
 */
function selectContextTier(
	tiers: PricingTier[] | undefined,
	requestSize: number,
): PricingTier | undefined {
	if (!tiers || tiers.length === 0) return undefined;
	let chosen: PricingTier | undefined;
	for (const tier of tiers) {
		if (requestSize > tier.threshold) chosen = tier;
	}
	return chosen;
}

/**
 * Resolve the effective per-M prices for a turn by merging operator config over
 * catalog pricing PER FIELD (2026-11-21-model-catalog.md §3 precedence):
 * explicit config override > catalog (provider/models.dev). A field set in config
 * (present, including a deliberate 0) overrides the catalog; an unset config field
 * falls through to the catalog's tier-selected value. Returns `null` when no layer
 * supplies any price (cost is then unknown, not $0 — requirement 3).
 */
function resolveEffectivePrices(
	cfg: BackendPricing | undefined,
	catalog: ResolvedPricing | undefined,
	catalogSource: FieldSource | undefined,
	usage: UsageTokens,
): EffectivePricesPerM | null {
	// Catalog layer, tier-selected by request size.
	const tier = selectContextTier(catalog?.tiers, tierRequestSize(usage));
	const catInput = tier?.input_per_m ?? catalog?.input_per_m;
	const catOutput = tier?.output_per_m ?? catalog?.output_per_m;
	const catCacheRead = tier?.cache_read_per_m ?? catalog?.cache_read_per_m;
	const catCacheWrite5m = tier?.cache_write_5m_per_m ?? catalog?.cache_write_5m_per_m;
	const catCacheWrite1h =
		tier?.cache_write_1h_per_m ?? catalog?.cache_write_1h_per_m ?? catCacheWrite5m;

	// Config layer: PRESENCE is the override signal (a 0 overrides the catalog).
	const cfgInput = cfg?.price_per_m_input;
	const cfgOutput = cfg?.price_per_m_output;
	const cfgCacheRead = cfg?.price_per_m_cache_read;
	const cfgCacheWrite = cfg?.price_per_m_cache_write;
	const cfgCacheWrite1h = cfg?.price_per_m_cache_write_1h;

	const anyConfig =
		cfgInput !== undefined ||
		cfgOutput !== undefined ||
		cfgCacheRead !== undefined ||
		cfgCacheWrite !== undefined ||
		cfgCacheWrite1h !== undefined;
	const anyCatalog =
		catInput !== undefined ||
		catOutput !== undefined ||
		catCacheRead !== undefined ||
		catCacheWrite5m !== undefined ||
		catCacheWrite1h !== undefined;
	if (!anyConfig && !anyCatalog) return null;

	const input = cfgInput ?? catInput ?? 0;
	const output = cfgOutput ?? catOutput ?? 0;
	const cacheRead = cfgCacheRead ?? catCacheRead ?? 0;
	const cacheWrite = cfgCacheWrite ?? catCacheWrite5m ?? 0;
	const cacheWrite1h = cfgCacheWrite1h ?? cfgCacheWrite ?? catCacheWrite1h ?? cacheWrite;

	// Source is `config` when any component was an operator override; otherwise it
	// is the catalog's reported source (provider or models.dev).
	const source: EffectivePricesPerM["source"] = anyConfig
		? "config"
		: catalogSource === "provider"
			? "provider"
			: "models_dev";
	return { input, output, cacheRead, cacheWrite, cacheWrite1h, source };
}

/** Compute the four-component split from already-resolved per-M prices. */
function breakdownFromPrices(usage: UsageTokens, prices: EffectivePricesPerM): TurnCostBreakdown {
	// 1h subset is only known when explicitly reported; null/absent → 0, which
	// makes the whole cache-write total bill at the 5m rate (today's behavior).
	const cacheWrite1hTokens = usage.cacheWrite1hTokens ?? 0;
	const totalCacheWrite = usage.cacheWriteTokens ?? 0;
	const oneHTokens = Math.min(cacheWrite1hTokens, totalCacheWrite);
	const fiveMTokens = totalCacheWrite - oneHTokens;
	return {
		input: (usage.inputTokens * prices.input) / 1_000_000,
		output: (usage.outputTokens * prices.output) / 1_000_000,
		cacheRead: ((usage.cacheReadTokens ?? 0) * prices.cacheRead) / 1_000_000,
		cacheWrite: (fiveMTokens * prices.cacheWrite + oneHTokens * prices.cacheWrite1h) / 1_000_000,
	};
}

/**
 * Compute the four per-component cost parts for a turn's token usage against
 * static backend pricing. Returns `null` when the model is absent from the
 * backends list, when it carries no static price at all, OR when a dynamic
 * `price(turn)` callback resolved the cost as a single number (no component
 * split available). A callback that returns a component object is handled by
 * the caller, not here. When non-null, the four parts sum to
 * `calculateTurnCost` for the same inputs.
 */
export function calculateTurnCostBreakdown(
	modelId: string,
	usage: UsageTokens,
	backends: BackendPricing[],
): TurnCostBreakdown | null {
	const cfg = backends.find((b) => b.id === modelId);
	if (!cfg) return null;

	const pricesPerM = {
		input: cfg.price_per_m_input ?? 0,
		output: cfg.price_per_m_output ?? 0,
		cacheRead: cfg.price_per_m_cache_read ?? 0,
		cacheWrite: cfg.price_per_m_cache_write ?? 0,
		cacheWrite1h: cfg.price_per_m_cache_write_1h ?? cfg.price_per_m_cache_write ?? 0,
	};
	const hasStatic =
		cfg.price_per_m_input !== undefined ||
		cfg.price_per_m_output !== undefined ||
		cfg.price_per_m_cache_read !== undefined ||
		cfg.price_per_m_cache_write !== undefined ||
		cfg.price_per_m_cache_write_1h !== undefined;
	if (!hasStatic) return null;

	// A winning price(turn) callback resolves the cost as a single number with no
	// component split, so the static split below would NOT sum to that cost. When
	// a callback is active and produces a value, there is no breakdown. (A model
	// may carry both a static price and a callback; the callback wins the cost,
	// so it must also win — to null — the breakdown.)
	if (hasDynamicPrice(modelId)) {
		const cacheWrite1h = usage.cacheWrite1hTokens ?? 0;
		const dynamic = calculateDynamicPrice(modelId, {
			modelId,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cacheReadTokens: usage.cacheReadTokens ?? 0,
			cacheWriteTokens: usage.cacheWriteTokens ?? 0,
			cacheWrite1hTokens: cacheWrite1h,
			pricesPerM,
		});
		// Callback produced a usable number → no component split.
		if (dynamic?.value !== null && dynamic !== null) return null;
		// Callback errored / unavailable → fall through to the static split, which
		// is exactly what calculateTurnCost falls back to for the cost number.
	}

	return breakdownFromPrices(usage, {
		...pricesPerM,
		source: "config",
	});
}

/** Compute cost in USD for a turn's token usage against backend pricing. */
export function calculateTurnCost(
	modelId: string,
	usage: UsageTokens,
	backends: BackendPricing[],
): number {
	const cfg = backends.find((b) => b.id === modelId);
	if (!cfg) return 0;

	const pricesPerM = {
		input: cfg.price_per_m_input ?? 0,
		output: cfg.price_per_m_output ?? 0,
		cacheRead: cfg.price_per_m_cache_read ?? 0,
		cacheWrite: cfg.price_per_m_cache_write ?? 0,
		cacheWrite1h: cfg.price_per_m_cache_write_1h ?? cfg.price_per_m_cache_write ?? 0,
	};
	// 1h subset is only known when explicitly reported; null/absent → 0, which
	// makes the whole cache-write total bill at the 5m rate (today's behavior).
	const cacheWrite1hTokens = usage.cacheWrite1hTokens ?? 0;
	const dynamic = calculateDynamicPrice(modelId, {
		modelId,
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheReadTokens: usage.cacheReadTokens ?? 0,
		cacheWriteTokens: usage.cacheWriteTokens ?? 0,
		cacheWrite1hTokens,
		pricesPerM,
	});
	if (dynamic?.value !== null && dynamic !== null) return dynamic.value;
	if (dynamic?.error && !warnedDynamicPricingFallbacks.has(modelId)) {
		warnedDynamicPricingFallbacks.add(modelId);
		logger.warn("Dynamic price callback failed; falling back to static pricing", {
			modelId,
			error: dynamic.error,
		});
	}

	// Static path: reuse the component computer so the number and the breakdown
	// can never drift. A model with no static price yields a null breakdown → 0.
	const breakdown = calculateTurnCostBreakdown(modelId, usage, backends);
	if (!breakdown) return 0;
	return breakdown.input + breakdown.output + breakdown.cacheRead + breakdown.cacheWrite;
}

/**
 * True when the operator has declared explicit pricing for this model: either a
 * compiled price(turn) callback is active, or the backend carries ANY `price_per_m_*`
 * field set in config (presence is the signal, including a deliberate 0 — the schema
 * keeps these optional, so a set-to-0 override is distinguishable from an unset gap).
 * A model absent from the backends list, or one whose every price field is unset with
 * no callback, counts as NOT explicitly priced — its cost then falls through to catalog
 * (provider/models.dev) pricing or a provider-reported value.
 */
export function hasExplicitOperatorPricing(modelId: string, backends: BackendPricing[]): boolean {
	if (hasDynamicPrice(modelId)) return true;
	const cfg = backends.find((b) => b.id === modelId);
	if (!cfg) return false;
	return (
		cfg.price_per_m_input !== undefined ||
		cfg.price_per_m_output !== undefined ||
		cfg.price_per_m_cache_read !== undefined ||
		cfg.price_per_m_cache_write !== undefined ||
		cfg.price_per_m_cache_write_1h !== undefined
	);
}

export interface ResolveTurnCostInput {
	modelId: string;
	usage: UsageTokens;
	backends: BackendPricing[];
	/** Provider-reported USD cost from the done chunk (e.g. Copilot catalog pricing). */
	providerCostUsd: number | null | undefined;
	/**
	 * Provider-reported component breakdown from the done chunk (Copilot catalog
	 * pricing stamps this alongside `providerCostUsd`; a hub relays it verbatim).
	 * Carried through only when the provider cost actually wins the precedence.
	 */
	providerBreakdown?: TurnCostBreakdown | null;
	/**
	 * The serving host's catalog-resolved pricing for this model (provider API or
	 * `models.dev`, tier-aware). Consulted when the backend carries no explicit
	 * config override and the provider stamped no realized cost. Absent/undefined
	 * means the catalog knows no price for this model.
	 */
	catalogPricing?: ResolvedPricing;
	/**
	 * Which catalog layer supplied `catalogPricing` (`provider` or `models_dev`),
	 * recorded as the turn's pricing source when catalog pricing wins.
	 */
	catalogPricingSource?: FieldSource;
}

/**
 * The resolved cost plus its component split and the layer that priced it.
 * `cost` is `null` when no layer supplied any price (requirement 3: unknown, not
 * $0) and `source` is then `"unknown"`. `breakdown` is null when no component
 * split is available (plain-number callback, provider cost with no breakdown, or
 * unknown).
 */
export interface ResolvedTurnCost {
	cost: number | null;
	breakdown: TurnCostBreakdown | null;
	source: PricingSource;
}

/**
 * Resolve a turn's USD cost under one precedence rule, shared by the local agent
 * loop and the relay-processor so neither blindly overwrites the other
 * (2026-11-21-model-catalog.md §3, requirements 1–4):
 *
 *   price(turn) callback  >  explicit config price_per_m_*  >  provider-reported
 *   realized cost  >  catalog pricing (provider / models.dev, tier-aware)  >  unknown
 *
 * An explicit config price (present, including a deliberate 0) is an operator
 * override and wins over catalog pricing. A field the operator did NOT set falls
 * through to the catalog's tier-selected value. When nothing supplies a price the
 * cost is recorded as unknown (`null`), never a misleading $0.
 *
 * `source` records which layer priced the turn (`cost_breakdown` provenance). The
 * returned `breakdown` is the four-component split when one is available:
 *   - config / catalog per-M pricing → `breakdownFromPrices` (sums to cost);
 *   - a price(turn) callback that resolved as a plain number → null (no split);
 *   - provider-reported cost → the passed `providerBreakdown` (or null);
 *   - unknown → null.
 */
export function resolveTurnCost(input: ResolveTurnCostInput): ResolvedTurnCost {
	const cfg = input.backends.find((b) => b.id === input.modelId);

	// 1. A price(turn) callback wins outright — it is the operator's authoritative
	//    pricing and yields a single number with no component split.
	if (hasDynamicPrice(input.modelId)) {
		const cost = calculateTurnCost(input.modelId, input.usage, input.backends);
		// If the callback actually produced a value, there is no breakdown. A
		// callback that errored falls back to the static split inside calculateTurnCost,
		// in which case calculateTurnCostBreakdown returns the matching split.
		const breakdown = calculateTurnCostBreakdown(input.modelId, input.usage, input.backends);
		return { cost, breakdown, source: breakdown ? "config" : "config_callback" };
	}

	// 2. Explicit config price_per_m_* overrides the catalog (presence is the
	//    signal; a deliberate 0 counts). 3. Else catalog pricing, tier-aware.
	const hasConfigOverride =
		cfg !== undefined &&
		(cfg.price_per_m_input !== undefined ||
			cfg.price_per_m_output !== undefined ||
			cfg.price_per_m_cache_read !== undefined ||
			cfg.price_per_m_cache_write !== undefined ||
			cfg.price_per_m_cache_write_1h !== undefined);

	if (hasConfigOverride) {
		const prices = resolveEffectivePrices(
			cfg,
			input.catalogPricing,
			input.catalogPricingSource,
			input.usage,
		);
		// A config override guarantees a non-null result.
		if (prices) {
			const breakdown = breakdownFromPrices(input.usage, prices);
			const cost = breakdown.input + breakdown.output + breakdown.cacheRead + breakdown.cacheWrite;
			return { cost, breakdown, source: "config" };
		}
	}

	// 3. A provider-reported realized cost from the done chunk outranks a catalog
	//    estimate — it is what was actually billed on the serving host.
	if (input.providerCostUsd !== null && input.providerCostUsd !== undefined) {
		return {
			cost: input.providerCostUsd,
			breakdown: input.providerBreakdown ?? null,
			source: "provider_reported",
		};
	}

	// 4. Catalog pricing (provider / models.dev, tier-selected).
	const prices = resolveEffectivePrices(
		cfg,
		input.catalogPricing,
		input.catalogPricingSource,
		input.usage,
	);
	if (prices) {
		const breakdown = breakdownFromPrices(input.usage, prices);
		const cost = breakdown.input + breakdown.output + breakdown.cacheRead + breakdown.cacheWrite;
		return { cost, breakdown, source: prices.source };
	}

	// 5. No layer supplied any price: cost is unknown (requirement 3), not $0.
	return { cost: null, breakdown: null, source: "unknown" };
}

/**
 * Fold a turn's pricing `source` into its recorded `cost_breakdown` for
 * persistence (requirement 3, catalog §3). The four numeric components are left
 * untouched (the metrics route's `json_extract('$.input')` … paths are
 * unchanged) and `source` rides as an extra key older readers ignore.
 *
 * When there is a numeric split, `source` is attached to it. When there is NO
 * split but the source is known — a plain-number `price(turn)` callback, or a
 * provider-reported cost with no breakdown — a SOURCE-ONLY object `{ source }`
 * is returned instead of null, so provenance survives. The metrics route reads a
 * source-only object as legacy (no `$.input` component) and keeps splitting its
 * `cost_usd` by token counts, so the aggregation stays correct. An `unknown`
 * source with no split stays null (there is nothing to persist).
 */
export function attachPricingSource(
	breakdown: TurnCostBreakdown | null,
	source: PricingSource,
): (TurnCostBreakdown & { source: PricingSource }) | { source: PricingSource } | null {
	if (breakdown) return { ...breakdown, source };
	if (source === "unknown") return null;
	return { source };
}

/**
 * Compute the worst-case turn cost ceiling for a backend in USD: full
 * context-window of input + max-output. Useful for budget forecasting
 * (e.g. by the agent-harness diagnostic) without running a turn.
 *
 * Defaults match `BackendConfig` schema defaults: 200k context window,
 * 8k max-output, zero pricing if unset. The result is a strict upper
 * bound — actual turn cost is almost always lower.
 */
export function estimateMaxTurnCost(backend: {
	context_window?: number;
	max_output_tokens?: number;
	price_per_m_input?: number;
	price_per_m_output?: number;
}): number {
	const ctxWindow = backend.context_window ?? 200_000;
	const maxOutput = backend.max_output_tokens ?? 8_000;
	const inputPrice = backend.price_per_m_input ?? 0;
	const outputPrice = backend.price_per_m_output ?? 0;
	return (ctxWindow * inputPrice + maxOutput * outputPrice) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Model resolution helpers
// ---------------------------------------------------------------------------

/** Extract a display-safe model ID from a ModelResolution, with fallback. */
export function getResolvedModelId(resolution: ModelResolution | null, fallback?: string): string {
	if (resolution && resolution.kind !== "error") {
		return resolution.modelId;
	}
	return fallback ?? "unknown";
}

/**
 * The `RouteId` that served a resolution, or null when unavailable. For a local
 * resolution it is the router's recorded route identity for the backend id; for
 * a remote resolution it is the serving host's advertised `routeId`. Recorded on
 * the turn row (`turns.route_id`) so the NEXT turn can resolve thread-sticky
 * routing (2026-11-21-model-routing.md §5.3).
 */
export function getResolvedRouteId(
	resolution: ModelResolution | null,
	getLocalRouteId: (backendId: string) => string | null,
): string | null {
	if (!resolution || resolution.kind === "error") return null;
	if (resolution.kind === "local") return getLocalRouteId(resolution.modelId);
	return resolution.hosts[0]?.routeId ?? null;
}

/**
 * Conservative output budget used when neither the loop nor the backend
 * advertises one. This must stay aligned with context assembly's fallback
 * reserve: the number subtracted from the context window is also the number
 * sent on the wire. Omitting max_tokens lets some providers substitute their
 * model-wide maximum (observed: 128k on GLM-5), invalidating assembly's 8k
 * reserve and producing a context-length 400 once history grows.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_000;

/**
 * Reconciles the agent-loop default `max_tokens` budget with a per-backend
 * cap configured in `model_backends.json#max_output_tokens`. Returns
 * `min(defaultMax, cap)` when both are positive integers. When only one is
 * present, returns it. When neither is present, returns the conservative 8k
 * fallback rather than omitting max_tokens and accepting a provider-defined
 * default that may consume most of the context window.
 *
 * Exists because some Bedrock models reject an explicit `maxTokens` above
 * their ceiling with `max_tokens exceeds model limit of N` — notably
 * Nova Pro. The backend cap is treated as an upper bound only: if an operator
 * sets a cap above the configured default, the default still wins.
 *
 * Exported so both the agent-loop (local path) and relay-processor (receiver
 * side) reuse one definition — defence-in-depth against stale requester
 * payloads and provider defaults.
 */
export function clampMaxOutputTokens(
	defaultMax: number | undefined,
	cap: number | undefined,
): number {
	const hasDefault =
		typeof defaultMax === "number" && Number.isFinite(defaultMax) && defaultMax > 0;
	const hasCap = typeof cap === "number" && Number.isFinite(cap) && cap > 0;
	if (hasDefault && hasCap) return Math.min(defaultMax, Math.floor(cap));
	if (hasDefault) return defaultMax;
	if (hasCap) return Math.floor(cap);
	return DEFAULT_MAX_OUTPUT_TOKENS;
}

// ---------------------------------------------------------------------------
// Capability requirement detection
// ---------------------------------------------------------------------------

/** Detect capability requirements for a thread (vision, tool_use). */
export function deriveCapabilityRequirements(
	db: Database,
	threadId: string,
	hasTools: boolean,
): CapabilityRequirements | undefined {
	const req: CapabilityRequirements = {};

	if (hasTools) {
		req.tool_use = true;
	}

	try {
		const recentMsgs = listRecentLiveMessageContentByThread(db, threadId, 5);

		const hasImageBlock = recentMsgs.some((m) => {
			try {
				const blocks = JSON.parse(m.content);
				return Array.isArray(blocks) && blocks.some((b: { type?: string }) => b.type === "image");
			} catch {
				return false;
			}
		});

		if (hasImageBlock) {
			req.vision = true;
		}
	} catch {
		// Non-fatal: proceed without vision requirement
	}

	return Object.keys(req).length > 0 ? req : undefined;
}

// ---------------------------------------------------------------------------
// Stream chunk parsing
// ---------------------------------------------------------------------------

export interface ParsedToolCall {
	id: string;
	name: string;
	input: Record<string, unknown>;
	argsJson: string;
	/** True when the tool_use args JSON failed to parse (likely output truncation). */
	truncated?: boolean;
}

/**
 * Drop superseded tool-call drafts that some Responses-API providers surface as
 * independent tool calls while the model is still converging on the final call.
 *
 * GPT-5.5 on Mantle has emitted `call_2`, `call_4`, …, `call_108` for one
 * intended `boundless_write`: dozens of earlier same-tool entries had `{}` or a
 * truncated prefix while the final later entry carried the real arguments. The
 * agent loop executes only after the full stream is parsed, so at this boundary
 * we can safely keep the final complete call and discard earlier drafts without
 * disabling genuinely parallel tool calling across different tools.
 */
export function dropSupersededToolCallDrafts<T extends ParsedToolCall>(calls: T[]): T[] {
	if (calls.length < 2) return calls;
	const emptyCountsByTool = new Map<string, number>();
	for (const call of calls) {
		if (isEmptyObjectCall(call)) {
			emptyCountsByTool.set(call.name, (emptyCountsByTool.get(call.name) ?? 0) + 1);
		}
	}

	const keep = calls.map(() => true);
	for (let i = 0; i < calls.length; i++) {
		for (let j = i + 1; j < calls.length; j++) {
			if (
				isSupersededToolCallDraft(calls[i], calls[j], emptyCountsByTool.get(calls[i].name) ?? 0)
			) {
				keep[i] = false;
				break;
			}
		}
	}
	return calls.filter((_, i) => keep[i]);
}

function isSupersededToolCallDraft(
	earlier: ParsedToolCall,
	later: ParsedToolCall,
	emptySameToolCount: number,
): boolean {
	if (earlier.name !== later.name) return false;
	if (later.truncated) return false;

	const earlierArgs = earlier.argsJson.trim();
	const laterArgs = later.argsJson.trim();
	if (earlier.truncated && (earlierArgs === "" || laterArgs.startsWith(earlierArgs))) {
		return true;
	}

	// A single zero-argument tool call can be legitimate; the production anomaly
	// was a same-tool ladder of many `{}` drafts followed by the real payload.
	// Require at least two empty same-tool calls before treating them as drafts.
	return emptySameToolCount > 1 && isEmptyObjectCall(earlier) && !isEmptyObjectCall(later);
}

function isEmptyObjectCall(call: ParsedToolCall): boolean {
	return !call.truncated && call.argsJson.trim() === "{}" && Object.keys(call.input).length === 0;
}

export interface ParsedResponse {
	textContent: string;
	thinking: string | null;
	thinkingSignature: string | null;
	toolCalls: ParsedToolCall[];
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheWriteTokens: number | null;
		cacheReadTokens: number | null;
		usageEstimated: boolean;
	};
}

/**
 * Parses a stream of LLM response chunks into a structured response.
 * Thinking chunks are collected separately and never mixed into textContent.
 */
export function parseStreamChunks(chunks: StreamChunk[]): ParsedResponse {
	let textContent = "";
	let thinkingContent = "";
	let thinkingSignature: string | null = null;
	const toolCalls: ParsedToolCall[] = [];
	const argsAccumulator = new Map<string, string>();
	const nameMap = new Map<string, string>();
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheWriteTokens: number | null = null;
	let cacheReadTokens: number | null = null;
	let usageEstimated = false;

	for (const chunk of chunks) {
		switch (chunk.type) {
			case "text":
				textContent += chunk.content;
				break;
			case "thinking":
				thinkingContent += chunk.content;
				if (chunk.signature) thinkingSignature = chunk.signature;
				break;
			case "tool_use_start":
				argsAccumulator.set(chunk.id, "");
				nameMap.set(chunk.id, chunk.name);
				break;
			case "tool_use_args": {
				const existing = argsAccumulator.get(chunk.id) ?? "";
				argsAccumulator.set(chunk.id, existing + chunk.partial_json);
				break;
			}
			case "tool_use_end": {
				// Empty accumulator = zero-argument tool call (no tool_use_args chunks streamed).
				// `??` only catches undefined, so empty-string would fall through to JSON.parse("")
				// and spuriously flag the call as truncated. Treat "" and undefined alike as "{}".
				const rawArgs = argsAccumulator.get(chunk.id);
				const fullArgsJson = rawArgs && rawArgs.length > 0 ? rawArgs : "{}";
				const name = nameMap.get(chunk.id) ?? chunk.id;
				let input: Record<string, unknown> = {};
				let truncated = false;
				try {
					input = JSON.parse(fullArgsJson);
				} catch {
					truncated = true;
					logger.warn("Failed to parse tool_use args; output likely truncated by max_tokens", {
						toolName: name,
						id: chunk.id,
						argsLength: fullArgsJson.length,
						rawArgsPrefix: fullArgsJson.slice(0, 200),
					});
				}
				toolCalls.push({
					id: chunk.id,
					name,
					input,
					argsJson: fullArgsJson,
					truncated,
				});
				break;
			}
			case "done":
				inputTokens = chunk.usage.input_tokens;
				outputTokens = chunk.usage.output_tokens;
				cacheWriteTokens = chunk.usage.cache_write_tokens;
				cacheReadTokens = chunk.usage.cache_read_tokens;
				usageEstimated = chunk.usage.estimated;
				break;
			case "error":
				logger.warn("Stream error chunk received during aggregation", { error: chunk.error });
				break;
			case "heartbeat":
				break;
			default: {
				const _exhaustive: never = chunk;
				void _exhaustive;
			}
		}
	}

	return {
		textContent,
		thinking: thinkingContent || null,
		thinkingSignature,
		toolCalls: dropSupersededToolCallDrafts(toolCalls),
		usage: {
			inputTokens,
			outputTokens,
			cacheWriteTokens,
			cacheReadTokens,
			usageEstimated,
		},
	};
}

// ---------------------------------------------------------------------------
// Warm-path delta message conversion
// ---------------------------------------------------------------------------

interface DbMessageRow {
	id: string;
	thread_id: string;
	role: string;
	content: string;
	model_id: string | null;
	tool_name: string | null;
	created_at: string;
	modified_at: string | null;
	host_origin: string;
	deleted: number;
}

/**
 * Convert a DB message row to an LLMMessage with minimal sanitization.
 *
 * Handles tool pair validation: a `tool_result` is valid when it follows
 * either a `tool_call` (single or first of a parallel batch) OR another
 * `tool_result` that is itself part of the ongoing parallel-tool-call
 * response. Only a `tool_result` with no `tool_call` anywhere upstream in
 * the conversion is considered orphaned and dropped.
 *
 * The caller (`convertDeltaMessages`) tracks whether a `tool_call` has
 * been seen via the `toolCallSeen` flag so the predicate is accurate even
 * when the delta contains many consecutive `tool_result` rows.
 */
export function deltaRequiresColdReassembly(rows: DbMessageRow[]): boolean {
	// A purge row is an instruction over the entire history, not an LLM turn.
	// The warm path only appends new rows to an already-materialized prefix, so
	// it cannot remove the targeted cached messages or place the replacement
	// summary correctly. Force the full purge-substitution stage to run.
	return rows.some((row) => row.role === "purge");
}

export function convertDbRowToLLMMessage(
	row: DbMessageRow,
	previousRole?: string,
	toolCallSeen?: boolean,
): LLMMessage | null {
	const { role, content, tool_name, model_id, host_origin } = row;

	// These roles only have meaning in the DB context pipeline. `purge` is
	// consumed by purge substitution, and persisted `system` rows are forbidden
	// legacy/corrupt input. Neither is legal in the AI SDK ModelMessage schema.
	if (role === "purge" || role === "system") return null;

	// Validate tool pairs. `tool_result` must follow `tool_call` directly OR
	// be part of a run of `tool_result` messages responding to that call
	// (parallel tool calls emit N consecutive `tool_result` DB rows).
	if (role === "tool_result") {
		const followsToolCall = previousRole === "tool_call";
		const followsToolResultAfterCall = previousRole === "tool_result" && toolCallSeen === true;
		if (!followsToolCall && !followsToolResultAfterCall) {
			return null; // Drop orphaned tool_result
		}
	}

	// Alert rows (inference failures persisted via emitAlert) must be
	// converted to developer-role messages here, matching the cold path's
	// Stage 2.5 conversion in context-assembly.ts. Without this, the warm
	// path emits role:"alert" which fails the AI SDK's ModelMessage[] schema
	// validation (InvalidPromptError), permanently poisoning the thread.
	// See Invariant #9 (alert is not a wire role) and #19 (developer is the
	// role for injected system context).
	const isAlert = role === "alert";
	const msg: LLMMessage = {
		role: (isAlert ? "developer" : role) as LLMMessage["role"],
		// Readback seam: any role whose row holds a serialized ContentBlock[]
		// (a user prompt with an attached image, a tool_result with a binary
		// blob) is parsed back to blocks here. Without this, the driver
		// receives the literal JSON text and the image/document never reaches
		// the model. The live tool-result branch in agent-loop.ts handles the
		// just-executed case; this covers every DB-readback path.
		content: parseContentBlocks(
			isAlert && typeof content === "string" ? `[system alert] ${content}` : content,
		),
	};

	if (tool_name) {
		msg.tool_use_id = tool_name;
	}
	if (model_id) {
		msg.model_id = model_id;
	}
	if (host_origin) {
		msg.host_origin = host_origin;
	}

	return msg;
}

/**
 * Convert delta DB rows to LLMMessages, filtering orphaned tool_results.
 * Returns array of valid messages with tool pairs intact.
 *
 * Tracks `toolCallSeen` so consecutive `tool_result` rows following a
 * parallel `tool_call` are preserved rather than dropped after the first.
 * The flag resets whenever a non-tool message breaks the run.
 */
export function convertDeltaMessages(rows: DbMessageRow[]): LLMMessage[] {
	const messages: LLMMessage[] = [];
	let lastRole: string | undefined;
	let toolCallSeen = false;

	for (const row of rows) {
		// Yard client-dispatch bookkeeping rows have no declaring tool_call and
		// their content already rides inside the aggregate yard tool_result.
		// Skipping BEFORE conversion leaves lastRole/toolCallSeen untouched, so a
		// parallel batch interleaved with bookkeeping rows stays intact. Mirrors
		// cold Stage 1 and the delegation codec — see yard-client-rows.ts.
		if (isYardClientBookkeepingRow(row)) continue;
		const msg = convertDbRowToLLMMessage(row, lastRole, toolCallSeen);
		if (msg) {
			messages.push(msg);
			lastRole = msg.role;
			if (msg.role === "tool_call") {
				toolCallSeen = true;
			} else if (msg.role !== "tool_result") {
				// Any non-tool message ends the parallel-tool-call run.
				toolCallSeen = false;
			}
		}
	}

	return messages;
}

/**
 * Scan an LLMMessage[] for tool_calls whose tool_use ids are not matched by a
 * following tool_result before any non-tool message appears.
 *
 * The warm path appends delta messages to a previously-assembled prefix
 * WITHOUT re-running the full tool-pair sanitizer in `context-assembly.ts`.
 * When a tool_call was left pending at turn boundary (e.g. a long-running
 * client tool that hadn't returned before the user sent a follow-up, or the
 * agent loop yielded mid-batch), the merged warm-path array can contain a
 * tool_call with no tool_result. Sending that to the AI SDK raises
 * `MissingToolResultsError` and the whole turn errors out. Detect the
 * condition so the caller can fall through to the cold path, where Stage 3
 * sanitization synthesizes the missing results.
 *
 * Matches the semantics used by the AI SDK's prompt validator: a tool_call's
 * tool_use ids are considered answered only when every id is followed by a
 * tool_result (in any order) BEFORE the next user / assistant / system turn.
 * Tool-call content that fails to parse as JSON ContentBlock[] is treated as
 * a single opaque tool_use — absent any matching tool_result it is still an
 * orphan.
 */
export function hasOrphanedToolCall(messages: LLMMessage[]): boolean {
	const pending = new Set<string>();
	let inActiveToolCall = false;

	const closeWindow = (): boolean => {
		if (pending.size > 0 || inActiveToolCall) return true;
		return false;
	};

	for (const msg of messages) {
		if (msg.role === "tool_call") {
			// A new tool_call opens a fresh pending window. If the previous
			// tool_call still has unmatched ids, that's already an orphan —
			// report it up.
			if (closeWindow()) return true;
			pending.clear();
			inActiveToolCall = true;
			const content = Array.isArray(msg.content) ? msg.content : msg.content;
			try {
				const blocks =
					typeof content === "string" ? JSON.parse(content) : (content as ContentBlock[]);
				if (Array.isArray(blocks)) {
					for (const b of blocks) {
						if ((b as { type?: string }).type === "tool_use" && (b as { id?: string }).id) {
							pending.add((b as { id: string }).id);
						}
					}
				}
			} catch {
				// Non-parseable content: treat as one opaque tool_use. The
				// inActiveToolCall flag alone is enough to flag it as an
				// orphan if no tool_result follows.
			}
			continue;
		}

		if (msg.role === "tool_result") {
			if (!inActiveToolCall) {
				// Orphan tool_result on its own — no tool_call in scope.
				return true;
			}
			if (msg.tool_use_id) {
				pending.delete(msg.tool_use_id);
			}
			// Any result satisfies the opaque single-tool case.
			if (pending.size === 0) {
				inActiveToolCall = false;
			}
			continue;
		}

		if (msg.role === "cache" || msg.role === "developer") {
			// Cache markers and developer tails are protocol-internal and
			// can legitimately appear anywhere — they do NOT close a tool
			// pair window.
			continue;
		}

		// Any real conversation role (user / assistant / system) closes the
		// tool pair window. Unmatched ids at this point are orphans.
		if (closeWindow()) return true;
		pending.clear();
		inActiveToolCall = false;
	}

	// End of messages — surviving pending ids are orphans.
	return closeWindow();
}

/**
 * Decide whether a relay tool call should be re-dispatched after a failure.
 *
 * Retry policy:
 *   - Aborted runs never retry.
 *   - The retry budget (`attempt < maxAttempts`) is hard-capped.
 *   - `retriable=false` is final; never retry.
 *   - `definitely_not_executed=true` (hub fast-fail) — always retry. Strongest
 *     signal; the target tool provably never ran, so retry is safe even for
 *     non-idempotent tools.
 *   - `annotations.readOnly === true` or `annotations.idempotent === true` —
 *     retry safe. A duplicate execution leaves the system in the same final
 *     state as a single execution. Used for ambiguous failures (full timeouts,
 *     target-side errors) where the target may have started executing.
 *   - Otherwise — refuse. The agent surfaces the error to the model rather
 *     than risking a silent double-execution.
 *
 * Annotation trust model: per the MCP spec, `idempotentHint`/`readOnlyHint`
 * are HINTS, not guarantees. A target's tool can lie about being idempotent.
 * Worst case: their bug → double execution. We use these for retry policy
 * only, never for security gating.
 */
export interface ToolAnnotations {
	idempotent?: boolean;
	readOnly?: boolean;
}

export interface ShouldRetryRelayCallInput {
	waitResult: RelayWaitResult;
	attempt: number;
	maxAttempts: number;
	aborted: boolean;
	annotations?: ToolAnnotations;
}

export function shouldRetryRelayCall(input: ShouldRetryRelayCallInput): boolean {
	if (input.aborted) return false;
	if (input.attempt >= input.maxAttempts) return false;
	if (!input.waitResult.retriable) return false;
	if (input.waitResult.definitely_not_executed === true) return true;
	if (input.annotations?.readOnly === true) return true;
	if (input.annotations?.idempotent === true) return true;
	// Ambiguous-execution case: target may have started executing and we don't
	// have idempotency information. Refuse to retry rather than risk a double
	// side effect. The model sees the error and can decide what to do.
	return false;
}

/**
 * Look up a tool's idempotency annotations from the local registry. Prefers
 * `resolveAnnotations(args)` (per-action) when defined; falls back to the
 * static `idempotent`/`readOnly` fields. Returns an empty object for unknown
 * tools — the agent loop treats that as "no annotation info".
 *
 * Currently scoped to the local tool registry. Relay-routed tools (where the
 * target's annotations live on a different host) are resolved separately at
 * dispatch time and the result is carried on the relay request itself.
 */
export function resolveToolAnnotations(
	registry: Map<string, RegisteredTool>,
	toolName: string,
	args: Record<string, unknown>,
): ToolAnnotations {
	const tool = registry.get(toolName);
	if (!tool) return {};
	if (tool.resolveAnnotations) {
		return tool.resolveAnnotations(args);
	}
	const result: ToolAnnotations = {};
	if (tool.idempotent !== undefined) result.idempotent = tool.idempotent;
	if (tool.readOnly !== undefined) result.readOnly = tool.readOnly;
	return result;
}

/**
 * Build a `resolveFileRef` callback for ChatParams that fetches base64 file
 * bytes from the local `files` table. Used as defense-in-depth so file_ref
 * images and documents survive even when context-assembly's pre-resolution
 * was bypassed (test paths, future code paths). When the file row is missing
 * or has empty content, returns null and the LLM bridge emits a clear
 * `[Image unavailable: …]` placeholder rather than silently dropping.
 */
export function createFileRefResolver(db: Database): (fileId: string) => string | null {
	return (fileId: string) => {
		const row = findFileContentByIdActive(db, fileId);
		return row?.content ?? null;
	};
}
