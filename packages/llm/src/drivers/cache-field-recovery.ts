/**
 * Generic prompt-cache request recovery (2026-11-21-model-catalog.md R-MC14).
 *
 * Bound does not model per-provider cache semantics ahead of time: an aggregator
 * (Copilot, Mantle) inherits each upstream's cache behavior per model and wire
 * protocol. So when a provider rejects a request SPECIFICALLY because of a cache
 * field — an invalid-value or unsupported-parameter 400 naming that field — the
 * driver recovers by retrying once (with the provider-listed supported value
 * when the error lists a valid one, otherwise without the field) and REMEMBERS
 * the outcome in local, in-memory, per-route state so later requests on that
 * route skip the doomed field. The rejection is never a route failure and never
 * a refusal: recovery happens inside the driver before the stream reaches
 * route-health, so the route stays healthy.
 *
 * This module is the protocol-agnostic core: a classifier that duck-types the
 * cache-field rejection out of the AI SDK error shape, and a per-route decision
 * store. It branches on the PROTOCOL FIELD NAME the provider reports, never on a
 * model ID string (R-MC1).
 */

/** The cache-request fields any supported protocol exposes, by their wire name. */
const CACHE_FIELD_NAMES = [
	"prompt_cache_options.ttl",
	"prompt_cache_options",
	"prompt_cache_breakpoint",
	"cache_control",
	"cachepoint",
] as const;

/** A classified cache-field rejection: which field, and any value the provider listed. */
export interface CacheFieldRejection {
	/** The wire field the provider named (one of {@link CACHE_FIELD_NAMES}). */
	field: string;
	/**
	 * The first value the error's "Supported values are: …" clause listed, if any.
	 * A candidate replacement — validated against the field's own allowed set by
	 * the decision store before it is trusted.
	 */
	supportedValue?: string;
}

/**
 * Walk the common AI SDK error shape (RetryError → lastError, APICallError with
 * `.responseBody`, InvalidArgumentError → cause) collecting status codes, body
 * text, and whether a node is a LOCAL SDK argument-validation failure, mirroring
 * `isResponsesInputRejection`. Returns the parsed body object plus the status and
 * a `localArgRejection` flag.
 *
 * `localArgRejection` is true when a walked node is @ai-sdk's own pre-flight
 * provider-options validation failure (`AI_InvalidArgumentError`, usually
 * `argument: "providerOptions"`): the SDK rejects a bad field value against its
 * typed schema BEFORE any request is sent, so there is no HTTP status and no
 * responseBody — only the SDK's message and a wrapped TypeValidationError in
 * `.cause` naming the failing path. A field match comes from that message/path
 * text (collected into `bodyText`), never a `param`.
 */
function collectError(err: unknown): {
	statusCode?: number;
	bodyText: string;
	param?: string;
	localArgRejection: boolean;
} {
	let statusCode: number | undefined;
	let param: string | undefined;
	let localArgRejection = false;
	const bodyTexts: string[] = [];
	const seen = new Set<unknown>();
	let node: unknown = err;
	for (let depth = 0; depth < 4 && node && !seen.has(node); depth++) {
		seen.add(node);
		const e = node as {
			name?: unknown;
			statusCode?: number;
			status?: number;
			$metadata?: { httpStatusCode?: number };
			message?: unknown;
			responseBody?: unknown;
			lastError?: unknown;
			cause?: unknown;
		};
		statusCode = statusCode ?? e.statusCode ?? e.status ?? e.$metadata?.httpStatusCode;
		// @ai-sdk tags its local provider-options validation failure by name; the
		// SDK throws it before a request exists, so it carries no status/body.
		if (e.name === "AI_InvalidArgumentError" || e.name === "AI_TypeValidationError") {
			localArgRejection = true;
		}
		if (typeof e.message === "string") bodyTexts.push(e.message);
		if (typeof e.responseBody === "string") {
			bodyTexts.push(e.responseBody);
			// Lift `error.param` out of a JSON responseBody when present.
			try {
				const parsed = JSON.parse(e.responseBody) as { error?: { param?: unknown } };
				if (typeof parsed?.error?.param === "string") param = parsed.error.param;
			} catch {
				// Not JSON — the field name is matched from the body text below.
			}
		}
		node = e.lastError ?? e.cause;
	}
	return { statusCode, bodyText: bodyTexts.join(" "), param, localArgRejection };
}

/**
 * Classify an error as a cache-field rejection, or null when it is not one.
 *
 * Two shapes count. (1) A provider 400 (an invalid-value / unsupported-parameter
 * rejection at the wire): a 5xx or 429 that happens to mention a cache field is a
 * transport failure, not a capability signal, so it is ignored. (2) An @ai-sdk
 * LOCAL argument-validation failure (`AI_InvalidArgumentError` /
 * `AI_TypeValidationError`): the SDK rejects a bad field value against its typed
 * schema BEFORE a request is sent, so it carries no HTTP status — the field is
 * read from the error message/path text. An error with any other HTTP status is
 * NOT a cache-field rejection. The field is taken from the error's `param` when
 * present, else matched from the body text. A "Supported values are: 'X'" clause
 * yields the first listed value as a candidate replacement (a local rejection
 * never carries one, so such a field is dropped, not resent).
 */
export function classifyCacheFieldRejection(err: unknown): CacheFieldRejection | null {
	const { statusCode, bodyText, param, localArgRejection } = collectError(err);
	// A wire rejection must be a 400; a local SDK argument rejection has no status.
	if (statusCode !== 400 && !(statusCode === undefined && localArgRejection)) return null;
	if (bodyText.length === 0 && !param) return null;

	const lowerBody = bodyText.toLowerCase();
	const lowerParam = param?.toLowerCase();

	// Longest field name first so `prompt_cache_options.ttl` wins over the
	// `prompt_cache_options` prefix when both could match.
	const ordered = [...CACHE_FIELD_NAMES].sort((a, b) => b.length - a.length);
	let matched: string | undefined;
	for (const field of ordered) {
		if (lowerParam === field || lowerParam?.startsWith(`${field}.`)) {
			matched = field;
			break;
		}
	}
	if (!matched) {
		for (const field of ordered) {
			if (lowerBody.includes(field)) {
				matched = field;
				break;
			}
		}
	}
	if (!matched) return null;

	// Normalize the wire-cased field name back to canonical form for the caller.
	const canonical = CACHE_FIELD_NAMES.find((f) => f === matched) ?? matched;

	// Extract the first value from a "Supported values are: 'X'[, 'Y' and 'Z']" clause.
	let supportedValue: string | undefined;
	const supportedMatch = /supported values are:\s*'([^']+)'/i.exec(bodyText);
	if (supportedMatch) supportedValue = supportedMatch[1];

	return { field: canonical, ...(supportedValue !== undefined && { supportedValue }) };
}

/**
 * True when a value is a bare duration-TTL string (`5m`, `1h`, `30m`, `24h`, …):
 * an integer count followed by a single `m` (minutes) or `h` (hours) unit. Used
 * to validate a provider-listed cache-ttl replacement before reusing it: a
 * Responses endpoint that lists `implicit`/`explicit` for a ttl field is naming
 * a MODE, not a lifetime, so it fails this check and the field is dropped.
 */
export function isDurationTtl(value: string): boolean {
	return /^\d+[mh]$/.test(value);
}

/** A remembered recovery decision for one (route, field): resend a value, or drop the field. */
export type CacheFieldDecision = { kind: "use-value"; value: string } | { kind: "drop" };

/** Options constraining how a rejection's listed value is reused. */
export interface RecordOptions {
	/**
	 * The values this protocol field legitimately accepts. A provider-listed
	 * value is reused only when it is one of these; otherwise the field is
	 * dropped (a Responses endpoint that lists `implicit`/`explicit` for a ttl
	 * field is listing a MODE, not a duration — not a usable ttl, so drop).
	 * Omitted/empty means "no value is reusable here" → always drop.
	 */
	validValues?: string[];
}

/**
 * In-memory, per-route cache-field recovery decisions. Keyed by `${routeId}|
 * ${field}` so a decision is scoped to one route and one protocol field — never
 * synced, never keyed by model id. One instance lives on each driver; a fresh
 * process re-learns, which is correct because a provider's cache support can
 * change between deploys.
 */
export class CacheFieldRecoveryState {
	private readonly decisions = new Map<string, CacheFieldDecision>();

	private key(routeId: string, field: string): string {
		return `${routeId}|${field}`;
	}

	/** The remembered decision for a (route, field), or undefined when none is recorded yet. */
	decisionFor(routeId: string, field: string): CacheFieldDecision | undefined {
		return this.decisions.get(this.key(routeId, field));
	}

	/**
	 * Record the outcome of a cache-field rejection and return the decision to
	 * apply on the retry: reuse the provider-listed value when it is valid for
	 * this field, else drop the field. The decision is remembered for later
	 * requests on the same route.
	 */
	record(routeId: string, rejection: CacheFieldRejection, opts: RecordOptions): CacheFieldDecision {
		const valid = opts.validValues ?? [];
		const decision: CacheFieldDecision =
			rejection.supportedValue !== undefined && valid.includes(rejection.supportedValue)
				? { kind: "use-value", value: rejection.supportedValue }
				: { kind: "drop" };
		this.decisions.set(this.key(routeId, rejection.field), decision);
		return decision;
	}
}

/** Options for {@link withCacheFieldRecovery}. */
export interface WithCacheFieldRecoveryOptions<T> {
	/** The route whose decisions are remembered (stable across requests). */
	routeId: string;
	/** The driver's per-route decision store. */
	state: CacheFieldRecoveryState;
	/**
	 * The cache-lifetime / breakpoint fields THIS driver actually sends. A
	 * rejection naming a field not in this list is not this driver's to recover
	 * (it rethrows), so a ttl rejection does not make an Anthropic-only driver
	 * silently retry. The canonical wire names are {@link CACHE_FIELD_NAMES}.
	 */
	fields: readonly string[];
	/**
	 * The values a given field legitimately accepts, used to validate a
	 * provider-listed replacement before reusing it (a Responses endpoint that
	 * lists `implicit`/`explicit` for a ttl field is naming a MODE, not a usable
	 * duration → drop). Return `[]` for a field that never carries a reusable
	 * value (a breakpoint), which always drops on rejection.
	 */
	validValuesFor: (field: string) => string[];
	/**
	 * Run ONE streaming attempt. `decision` is the remembered/just-recorded
	 * recovery decision for a field this driver sends, or `undefined` when none is
	 * recorded (send the configured value). The driver reshapes its request from
	 * the decision (drop the field, or resend the provider-listed value).
	 */
	run: (decision: CacheFieldDecision | undefined) => AsyncIterable<T>;
}

/**
 * Protocol-agnostic prompt-cache request recovery (R-MC14), wrapping any
 * driver's streaming attempt. Yields the attempt's chunks; on a cache-field
 * rejection naming a field THIS driver sends, it records the per-route decision
 * and reissues ONCE with the field corrected/dropped. A second rejection, a
 * rejection naming a field this driver does not send, and any non-cache error
 * all propagate unchanged — recovery never hides a real failure and never
 * retries more than once.
 *
 * The first attempt already applies any remembered decision for this route
 * (passed to `run`), so a route that learned to drop a field on an earlier
 * request never re-triggers the rejection. Recovery happens here, inside the
 * driver, before the stream reaches route-health — the rejection is never a
 * route failure and never a refusal.
 */
export async function* withCacheFieldRecovery<T>(
	opts: WithCacheFieldRecoveryOptions<T>,
): AsyncIterable<T> {
	// The decision in force for THIS route on the fields this driver sends. The
	// first field with a remembered decision wins (a driver sends at most one
	// recoverable lifetime field; a breakpoint drop is independent).
	const rememberedDecision = (): CacheFieldDecision | undefined => {
		for (const field of opts.fields) {
			const d = opts.state.decisionFor(opts.routeId, field);
			if (d) return d;
		}
		return undefined;
	};

	try {
		yield* opts.run(rememberedDecision());
		return;
	} catch (err) {
		const rejection = classifyCacheFieldRejection(err);
		// Only recover a rejection naming a field this driver sends AND that we have
		// not already recorded a decision for (no second retry on a re-rejection).
		if (
			!rejection ||
			!opts.fields.includes(rejection.field) ||
			opts.state.decisionFor(opts.routeId, rejection.field)
		) {
			throw err;
		}
		const decision = opts.state.record(opts.routeId, rejection, {
			validValues: opts.validValuesFor(rejection.field),
		});
		yield* opts.run(decision);
	}
}
