/**
 * Canonical relation types for memory_edges.
 * This set is frozen by design — adding more requires a deliberate follow-on change
 * that updates the const, adjusts the trigger, and may require a schema-version bump.
 */
export const CANONICAL_RELATIONS = [
	"related_to",
	"informs",
	"supports",
	"extends",
	"complements",
	"contrasts-with",
	"competes-with",
	"cites",
	"summarizes",
	"synthesizes",
] as const;

export type CanonicalRelation = (typeof CANONICAL_RELATIONS)[number];

const canonicalSet = new Set<string>(CANONICAL_RELATIONS);

export function isCanonicalRelation(rel: string): rel is CanonicalRelation {
	return canonicalSet.has(rel);
}

export class InvalidRelationError extends Error {
	readonly rel: string;

	constructor(rel: string) {
		const valid = CANONICAL_RELATIONS.join(", ");
		super(
			`Invalid relation "${rel}". Must be one of: ${valid}. Use --context to attach bespoke phrasing to a canonical relation.`,
		);
		this.name = "InvalidRelationError";
		this.rel = rel;
	}
}

/**
 * Deterministic lowercased-key → canonical-value lookup for spelling variants
 * observed in production data. Keys are lowercased for case-insensitive matching.
 */
export const SPELLING_VARIANTS: Record<string, CanonicalRelation> = {
	// related_to variants
	"related-to": "related_to",
	relates_to: "related_to",
	relates: "related_to",
	related: "related_to",
	"relates-to": "related_to",
	relate: "related_to",

	// informs variants
	inform: "informs",
	informed_by: "informs",
	"informed-by": "informs",

	// supports variants
	support: "supports",
	supported_by: "supports",
	"supported-by": "supports",

	// extends variants
	extend: "extends",
	extended_by: "extends",
	"extended-by": "extends",

	// complements variants
	complement: "complements",
	complementary: "complements",
	"complementary-to": "complements",

	// contrasts-with variants
	contrasts: "contrasts-with",
	contrasts_with: "contrasts-with",
	contrast: "contrasts-with",

	// competes-with variants
	competes: "competes-with",
	competes_with: "competes-with",
	compete: "competes-with",

	// cites variants
	cite: "cites",
	cited_by: "cites",
	"cited-by": "cites",
	references: "cites",
	reference: "cites",

	// summarizes variants
	summarize: "summarizes",
	summary_of: "summarizes",
	"summary-of": "summarizes",
	"summarizes-to": "summarizes",

	// synthesizes variants
	synthesize: "synthesizes",
	synthesis_of: "synthesizes",
	"synthesis-of": "synthesizes",
};

/** Generic canonical relation used when a non-canonical relation has no known variant. */
export const FALLBACK_RELATION: CanonicalRelation = "related_to";

/**
 * Pure normalization of a single (relation, context) pair to the canonical set.
 *
 * - Canonical relation → returned unchanged (`changed: false`).
 * - Known spelling variant → mapped to its canonical form, `context` preserved.
 * - Bespoke / unknown relation → rewritten to {@link FALLBACK_RELATION}, with the
 *   original relation string prepended to `context` (joined with " | ") so the
 *   bespoke phrasing is not lost.
 *
 * Single source of truth for relation healing, used by:
 * - `normalizeEdgeRelations()` — startup self-heal of local rows (active + tombstones).
 * - the sync LWW reducer and snapshot apply — heal-on-receive so a peer's
 *   non-canonical relation never trips the canonical-relation trigger and the
 *   receiver's copy self-heals instead of being rejected and re-warned on every
 *   reconnection.
 */
export function normalizeRelationValue(
	relation: string,
	context: string | null,
): { relation: CanonicalRelation; context: string | null; changed: boolean } {
	if (isCanonicalRelation(relation)) {
		return { relation, context, changed: false };
	}

	const variant = SPELLING_VARIANTS[relation.toLowerCase()];
	if (variant) {
		// Known spelling variant → map to canonical, leave context untouched.
		return { relation: variant, context, changed: true };
	}

	// Bespoke / unknown relation → fallback, preserving the original phrasing in context.
	const parts: string[] = [relation];
	if (context) parts.push(context);
	return { relation: FALLBACK_RELATION, context: parts.join(" | "), changed: true };
}
