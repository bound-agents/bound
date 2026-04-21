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
