/**
 * Pure fetch + parse helpers for umans.ai model metadata, pricing, and usage.
 *
 * The umans backend is *self-configuring*: a config entry carries only
 * `provider: "umans"` + `api_key`. At runtime the driver fetches the full
 * model lineup (context window, max-output, capabilities) from
 * `/v1/models/info`, pricing from `/v1/models`, and the account concurrency
 * limit from authenticated `/v1/usage`. This module owns the network +
 * parsing only — it never mutates config or touches the router. The driver
 * maps the parsed `UmansModelMeta[]` lineup into provider-neutral
 * `ModelDescriptor[]` and hands them to the registrar.
 *
 * All fetchers are total: they never throw, returning `Result<…, Error>` so
 * the driver's retry/backoff loop can branch cleanly. Zod parsers are LENIENT
 * (no `.strict()`) so additive provider changes don't break parsing.
 */

import type { Result } from "@bound/shared";
import { z } from "zod";

export const UMANS_ANTHROPIC_BASE = "https://api.code.umans.ai";
export const UMANS_OPENAI_BASE = "https://api.code.umans.ai/v1";

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Parsed, normalized per-model metadata for one umans model id. Vision is
 * normalized to a boolean (the wire may report `"via-handoff"`, which umans
 * handles server-side on the route → treated as `true`). Pricing is optional
 * because subscription-tier models may not list a per-token price; absent
 * price → cost 0, matching bound's existing subscription-model behavior.
 */
export interface UmansModelMeta {
	id: string;
	contextWindow?: number;
	maxCompletionTokens?: number;
	supportsVision: boolean;
	supportsTools: boolean;
	reasoningSupported: boolean;
	reasoningCanDisable: boolean;
	reasoningLevels?: string[];
	reasoningDefault?: string;
	/** USD per 1M input tokens, if the provider lists it. */
	pricePerMInput?: number;
	/** USD per 1M output tokens, if the provider lists it. */
	pricePerMOutput?: number;
}

/**
 * Parsed `/v1/usage` shape: account concurrency + request limits and live
 * usage. `boxedUntil` is an epoch-ms instant in the future when the account
 * is server-side paused (priority box) — the driver throws a 429 with
 * `retryAfterMs` rather than queuing behind it.
 */
export interface UmansUsage {
	concurrencyLimit?: number;
	concurrencyHardCap?: number;
	requestsLimit?: number;
	requestsHardCap?: number;
	requestsWindowSeconds?: number;
	concurrentSessions?: number;
	remainingRequests?: number;
	/** Epoch ms; account paused until this instant when in the future. */
	boxedUntil?: number;
}

// ---------------------------------------------------------------------------
// Zod parsers — lenient (no .strict()).
// ---------------------------------------------------------------------------

// All optional fields are ALSO `.nullable()`: the live umans wire uses an
// explicit `null` (not omission) for unset values — e.g. `default_level: null`
// on models with no preset reasoning level. A bare `.optional()` accepts a
// missing key but REJECTS an explicit null, so lenient parsing requires
// `.nullish()` (optional + nullable) on every field that can be unset.
const reasoningSchema = z
	.object({
		supported: z.boolean().nullish(),
		can_disable: z.boolean().nullish(),
		levels: z.array(z.string()).nullish(),
		default_level: z.string().nullish(),
	})
	.nullish();

const modelInfoCapabilitiesSchema = z.object({
	context_window: z.number().nullish(),
	max_completion_tokens: z.number().nullish(),
	// May be a boolean or a string ("via-handoff").
	supports_vision: z.union([z.boolean(), z.string()]).nullish(),
	supports_tools: z.boolean().nullish(),
	reasoning: reasoningSchema,
});

const modelInfoEntrySchema = z.object({
	capabilities: modelInfoCapabilitiesSchema.optional(),
	// Presence of a deprecation block → model is sunset; excluded from lineup.
	deprecation: z.unknown().optional(),
});

/**
 * `/v1/models/info` is a record keyed by model id. Accept both the bare
 * record `{ "<id>": { capabilities: … } }` and a `{ data: { <id>: … } }`
 * envelope defensively.
 */
const modelInfoResponseSchema = z.union([
	z.object({ data: z.record(z.string(), modelInfoEntrySchema) }),
	z.record(z.string(), modelInfoEntrySchema),
]);

const pricingSchema = z
	.object({
		// umans lists pricing as USD-per-million (confirmed against the live
		// `/v1/models`), which is exactly the unit `calculateTurnCost` expects,
		// so the number is passed through verbatim with no scale conversion.
		input: z.number().nullish(),
		output: z.number().nullish(),
		prompt: z.number().nullish(),
		completion: z.number().nullish(),
	})
	.nullish();

const modelsEntrySchema = z.object({
	id: z.string(),
	pricing: pricingSchema,
});

/**
 * `/v1/models` (OpenAI-style). Tolerate `{ data: [ { id, pricing } ] }` and a
 * bare record keyed by id.
 */
const modelsResponseSchema = z.union([
	z.object({ data: z.array(modelsEntrySchema) }),
	z.record(z.string(), z.object({ pricing: pricingSchema }).nullish()),
]);

// All optional usage fields are `.nullish()` for the same reason as the model
// metadata schema: the live wire sends explicit null for unset values.
const usageResponseSchema = z.object({
	limits: z
		.object({
			concurrency: z
				.object({
					limit: z.number().nullish(),
					hard_cap: z.number().nullish(),
				})
				.nullish(),
			requests: z
				.object({
					limit: z.number().nullish(),
					hard_cap: z.number().nullish(),
					window_seconds: z.number().nullish(),
				})
				.nullish(),
		})
		.nullish(),
	usage: z
		.object({
			concurrent_sessions: z.number().nullish(),
			remaining_requests: z.number().nullish(),
			priority: z
				.object({
					// May be an ISO string or epoch-ms number.
					boxed_until: z.union([z.string(), z.number()]).nullish(),
				})
				.nullish(),
		})
		.nullish(),
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function normalizeVision(v: boolean | string | null | undefined): boolean {
	if (typeof v === "boolean") return v;
	if (typeof v === "string") {
		// "via-handoff", "true", "yes", etc. → vision available on the route.
		return v.length > 0 && v.toLowerCase() !== "false" && v.toLowerCase() !== "none";
	}
	return false;
}

function parseBoxedUntil(raw: string | number | null | undefined): number | undefined {
	if (raw === null || raw === undefined) return undefined;
	if (typeof raw === "number") return raw;
	const parsed = Date.parse(raw);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Fetch with an AbortController-backed timeout, parsing JSON. Never throws —
 * returns a Result. An external `signal` (for dispose-driven cancellation) is
 * linked so either source can abort the request.
 */
async function fetchJson(
	url: string,
	opts: {
		fetch?: typeof globalThis.fetch;
		headers?: Record<string, string>;
		signal?: AbortSignal;
		timeoutMs?: number;
	},
): Promise<Result<unknown, Error>> {
	const doFetch = opts.fetch ?? globalThis.fetch;
	const controller = new AbortController();
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	// Forward an external abort (dispose) onto our controller.
	const onExternalAbort = () => controller.abort();
	if (opts.signal) {
		if (opts.signal.aborted) controller.abort();
		else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
	}
	try {
		const res = await doFetch(url, {
			headers: { accept: "application/json", ...opts.headers },
			signal: controller.signal,
		});
		if (!res.ok) {
			return { ok: false, error: new Error(`HTTP ${res.status} fetching ${url}`) };
		}
		const json = (await res.json()) as unknown;
		return { ok: true, value: json };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
	} finally {
		clearTimeout(timer);
		if (opts.signal) opts.signal.removeEventListener("abort", onExternalAbort);
	}
}

function extractModelInfoRecord(
	parsed: z.infer<typeof modelInfoResponseSchema>,
): Record<string, z.infer<typeof modelInfoEntrySchema>> {
	if ("data" in parsed && parsed.data && typeof parsed.data === "object") {
		return parsed.data as Record<string, z.infer<typeof modelInfoEntrySchema>>;
	}
	return parsed as Record<string, z.infer<typeof modelInfoEntrySchema>>;
}

function extractPriceByModel(
	parsed: z.infer<typeof modelsResponseSchema>,
): Map<string, { input?: number; output?: number }> {
	const out = new Map<string, { input?: number; output?: number }>();
	// `?? undefined` collapses the wire's explicit nulls so a null price is
	// treated as "unlisted" (→ cheapest tier, cost 0) rather than a type error.
	if ("data" in parsed && Array.isArray(parsed.data)) {
		for (const entry of parsed.data) {
			const p = entry.pricing;
			out.set(entry.id, {
				input: p?.input ?? p?.prompt ?? undefined,
				output: p?.output ?? p?.completion ?? undefined,
			});
		}
		return out;
	}
	// Bare record { "<id>": { pricing } }.
	for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
		const p = (
			value as {
				pricing?: {
					input?: number | null;
					output?: number | null;
					prompt?: number | null;
					completion?: number | null;
				} | null;
			} | null
		)?.pricing;
		out.set(id, {
			input: p?.input ?? p?.prompt ?? undefined,
			output: p?.output ?? p?.completion ?? undefined,
		});
	}
	return out;
}

/**
 * Fetch + merge `/v1/models/info` (capabilities) and `/v1/models` (pricing)
 * into the FULL umans model lineup. Both endpoints are fetched concurrently;
 * the lineup is keyed by model id from `/v1/models/info`, with pricing merged
 * in by id. Deprecated/sunset models (those carrying a `deprecation` block)
 * are excluded. Never throws.
 *
 * @param openaiBaseUrl - base for `/v1/models/info` + `/v1/models`
 *   (e.g. UMANS_OPENAI_BASE = "https://api.code.umans.ai/v1"). The `/models`
 *   and `/models/info` paths are appended.
 */
export async function fetchUmansModelMetadata(
	openaiBaseUrl: string,
	opts: {
		apiKey?: string;
		fetch?: typeof globalThis.fetch;
		signal?: AbortSignal;
		timeoutMs?: number;
	} = {},
): Promise<Result<Map<string, UmansModelMeta>, Error>> {
	const base = openaiBaseUrl.replace(/\/$/, "");
	// The OpenAI-style routes use Bearer auth (same as /v1/usage). The
	// messages route is the only x-api-key surface.
	const headers = opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : undefined;
	const [infoRes, modelsRes] = await Promise.all([
		fetchJson(`${base}/models/info`, { ...opts, headers }),
		fetchJson(`${base}/models`, { ...opts, headers }),
	]);

	if (!infoRes.ok) return infoRes;
	if (!modelsRes.ok) return modelsRes;

	const infoParsed = modelInfoResponseSchema.safeParse(infoRes.value);
	if (!infoParsed.success) {
		return {
			ok: false,
			error: new Error(`/v1/models/info parse error: ${infoParsed.error.message}`),
		};
	}
	const modelsParsed = modelsResponseSchema.safeParse(modelsRes.value);
	if (!modelsParsed.success) {
		return { ok: false, error: new Error(`/v1/models parse error: ${modelsParsed.error.message}`) };
	}

	const infoRecord = extractModelInfoRecord(infoParsed.data);
	const priceByModel = extractPriceByModel(modelsParsed.data);

	const lineup = new Map<string, UmansModelMeta>();
	for (const [id, entry] of Object.entries(infoRecord)) {
		if (entry.deprecation) continue; // sunset model — excluded
		const caps = entry.capabilities ?? {};
		const reasoning = caps.reasoning ?? {};
		const price = priceByModel.get(id);
		lineup.set(id, {
			id,
			contextWindow: caps.context_window ?? undefined,
			// Coerce explicit nulls (the umans wire's "unset" sentinel) to
			// undefined to match the non-null UmansModelMeta field types.
			maxCompletionTokens: caps.max_completion_tokens ?? undefined,
			supportsVision: normalizeVision(caps.supports_vision),
			supportsTools: caps.supports_tools ?? true,
			reasoningSupported: reasoning.supported ?? false,
			reasoningCanDisable: reasoning.can_disable ?? true,
			reasoningLevels: reasoning.levels ?? undefined,
			reasoningDefault: reasoning.default_level ?? undefined,
			pricePerMInput: price?.input,
			pricePerMOutput: price?.output,
		});
	}

	if (lineup.size === 0) {
		return { ok: false, error: new Error("/v1/models/info returned no (non-deprecated) models") };
	}
	return { ok: true, value: lineup };
}

/**
 * Fetch + parse `/v1/usage`. Authenticates with `Authorization: Bearer
 * <apiKey>` — intentionally DIFFERENT from the messages route, which uses
 * `x-api-key`. Do not "unify" these: the usage endpoint rejects x-api-key and
 * the messages endpoint rejects Bearer. Never throws.
 */
export async function fetchUmansUsage(
	baseUrl: string,
	apiKey: string,
	opts: { fetch?: typeof globalThis.fetch; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Result<UmansUsage, Error>> {
	const base = baseUrl.replace(/\/$/, "");
	const res = await fetchJson(`${base}/v1/usage`, {
		...opts,
		// Bearer auth — see the doc comment above.
		headers: { authorization: `Bearer ${apiKey}` },
	});
	if (!res.ok) return res;

	const parsed = usageResponseSchema.safeParse(res.value);
	if (!parsed.success) {
		return { ok: false, error: new Error(`/v1/usage parse error: ${parsed.error.message}`) };
	}
	const d = parsed.data;
	return {
		ok: true,
		value: {
			// `?? undefined` coerces the wire's explicit nulls to the
			// number|undefined shape UmansUsage declares.
			concurrencyLimit: d.limits?.concurrency?.limit ?? undefined,
			concurrencyHardCap: d.limits?.concurrency?.hard_cap ?? undefined,
			requestsLimit: d.limits?.requests?.limit ?? undefined,
			requestsHardCap: d.limits?.requests?.hard_cap ?? undefined,
			requestsWindowSeconds: d.limits?.requests?.window_seconds ?? undefined,
			concurrentSessions: d.usage?.concurrent_sessions ?? undefined,
			remainingRequests: d.usage?.remaining_requests ?? undefined,
			boxedUntil: parseBoxedUntil(d.usage?.priority?.boxed_until),
		},
	};
}

/**
 * Derive a bound-style tier (1 = most expensive/best, 5 = cheapest) for each
 * umans model by RANK, not by absolute price thresholds — so an arbitrary
 * number of models distributes evenly across the 5 tiers.
 *
 * Algorithm:
 *  1. Sort by `pricePerMInput` ascending, with a STABLE secondary sort by
 *     model id (deterministic across fetches/reloads). Models with no listed
 *     price sort as cheapest (price 0) and are still registered.
 *  2. Even-bucket: `bucket = 1 + floor(rank * 5 / n)` (clamped 1..5), then
 *     invert `tier = 6 - bucket` so cheapest → tier 5, dearest → tier 1.
 *
 * Worked: n=5 → buckets 1,2,3,4,5 → tiers 5,4,3,2,1; n=1 → tier 5;
 * n=6 → tiers 5,5,4,3,2,1.
 */
export function deriveUmansTiers(models: UmansModelMeta[]): Map<string, number> {
	const tiers = new Map<string, number>();
	const n = models.length;
	if (n === 0) return tiers;

	const sorted = [...models].sort((a, b) => {
		const pa = a.pricePerMInput ?? 0;
		const pb = b.pricePerMInput ?? 0;
		if (pa !== pb) return pa - pb;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});

	sorted.forEach((m, rank) => {
		const bucket = Math.min(5, Math.max(1, 1 + Math.floor((rank * 5) / n)));
		const tier = 6 - bucket;
		tiers.set(m.id, tier);
	});
	return tiers;
}
