/** A selectable model: its canonical id plus every name the operator may type for it. */
export interface ModelCandidate {
	id: string;
	aliases: ReadonlyArray<string | null | undefined>;
}

/**
 * Resolve a `/model <name>` argument to a canonical model id: a
 * case-insensitive exact match on the id, logical model, backend id, or
 * display name. Returns null for an unknown name so a typo surfaces as an
 * error instead of being sent as a model hint.
 */
export function resolveModelName(
	name: string,
	candidates: ReadonlyArray<ModelCandidate>,
): string | null {
	const wanted = name.trim().toLowerCase();
	if (!wanted) return null;
	for (const c of candidates) {
		if (c.id.toLowerCase() === wanted) return c.id;
	}
	for (const c of candidates) {
		if (c.aliases.some((a) => typeof a === "string" && a.toLowerCase() === wanted)) return c.id;
	}
	return null;
}
