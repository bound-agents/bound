import type { Database } from "bun:sqlite";

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}(:\d{2}(:\d{2}(\.\d+)?)?Z?)?)?$/;
const MIN_TOKEN_LENGTH = 3;
const MIN_TOKEN_FREQ = 5;
const R_VC9_PASS_THRESHOLD = 3;
const R_VC9B_CHILD_COVERAGE_THRESHOLD = 0.8;
const SAMPLE_SIZE = 50;
const SAMPLE_WINDOW_DAYS = 7;

export {
	ISO_8601_RE,
	MIN_TOKEN_LENGTH,
	MIN_TOKEN_FREQ,
	R_VC9_PASS_THRESHOLD,
	R_VC9B_CHILD_COVERAGE_THRESHOLD,
	SAMPLE_SIZE,
	SAMPLE_WINDOW_DAYS,
};

/**
 * §8.4 step 3a — extract topic-slug tokens from a memory key.
 * Procedure: split on the first colon, take the right-hand side, split on `-`, `_`, `:`,
 * and digit boundaries; lower-case; drop tokens shorter than 3 characters; drop ISO-8601
 * date stamps.
 *
 * Note: This validation does NOT filter common stopwords (e.g., 'and', 'the'). The corpus
 * frequency filter (MIN_TOKEN_FREQ = 5) is intended to catch most noise, but slugs comprising
 * only stopwords could pass R-VC9 spuriously. Pass is necessary, not sufficient. The spec
 * explicitly does not filter stopwords; future tightening lives outside this RFC.
 */
export function extractSlugTokens(key: string): string[] {
	const colonIdx = key.indexOf(":");
	if (colonIdx < 0) return [];
	const slug = key.slice(colonIdx + 1);
	if (!slug) return [];
	// Split on delimiters and digit boundaries.
	const raw = slug.split(/[-_:]+|(?<=\D)(?=\d)|(?<=\d)(?=\D)/);
	const out: string[] = [];
	for (const tok of raw) {
		const lower = tok.toLowerCase();
		if (lower.length < MIN_TOKEN_LENGTH) continue;
		if (ISO_8601_RE.test(lower)) continue;
		out.push(lower);
	}
	return out;
}

/**
 * §8.4 step 1 — corpus-wide token frequency table.
 * For each token (alphanumeric runs of length ≥3 with ISO-8601 date stamps stripped) in
 * `semantic_memory.value` across all rows where `deleted = 0`, count the number of
 * distinct entries containing the token.
 */
export function buildTokenFrequencyTable(db: Database): Map<string, number> {
	const rows = db.prepare("SELECT value FROM semantic_memory WHERE deleted = 0").all() as Array<{
		value: string;
	}>;
	const freq = new Map<string, number>();
	for (const row of rows) {
		const seenInThisEntry = new Set<string>();
		const tokens = (row.value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(
			(t) => !ISO_8601_RE.test(t),
		);
		for (const tok of tokens) {
			if (seenInThisEntry.has(tok)) continue;
			seenInThisEntry.add(tok);
			freq.set(tok, (freq.get(tok) ?? 0) + 1);
		}
	}
	return freq;
}

export interface Vc9CheckResult {
	key: string;
	slugTokens: string[];
	/** Tokens appearing in the entry value (case-insensitive substring). */
	inBody: string[];
	/** Tokens with freq ≥ 5 in the corpus. */
	aboveFreq: string[];
	/** Tokens that satisfy BOTH conditions — drives the pass condition. */
	bothConditions: string[];
	pass: boolean;
}

/**
 * Check if a memory entry passes R-VC9 compliance.
 *
 * Verifies that at least 3 slug tokens appear in the value body AND have corpus frequency ≥ 5.
 * Note: extractSlugTokens does not filter stopwords; slugs containing only stopwords could pass
 * spuriously. The frequency threshold mitigates most noise. Pass is necessary, not sufficient.
 */
export function checkR_VC9(key: string, value: string, freq: Map<string, number>): Vc9CheckResult {
	const slugTokens = extractSlugTokens(key);
	const lowerValue = value.toLowerCase();
	const inBody = slugTokens.filter((t) => lowerValue.includes(t));
	const aboveFreq = slugTokens.filter((t) => (freq.get(t) ?? 0) >= MIN_TOKEN_FREQ);
	const bothConditions = slugTokens.filter(
		(t) => lowerValue.includes(t) && (freq.get(t) ?? 0) >= MIN_TOKEN_FREQ,
	);
	return {
		key,
		slugTokens,
		inBody,
		aboveFreq,
		bothConditions,
		pass: bothConditions.length >= R_VC9_PASS_THRESHOLD,
	};
}

export interface Vc9bCheckResult {
	parentKey: string;
	childCount: number;
	childrenWithSubjectInGloss: number;
	pass: boolean;
	failingChildKeys: string[];
}

export function checkR_VC9b(db: Database, parentKey: string, parentValue: string): Vc9bCheckResult {
	const lowerGloss = parentValue.toLowerCase();
	const children = db
		.prepare(
			`SELECT m.key AS key, m.value AS value
             FROM memory_edges e
             JOIN semantic_memory m ON m.key = e.target_key AND m.deleted = 0
             WHERE e.relation = 'summarizes' AND e.deleted = 0 AND e.source_key = ?`,
		)
		.all(parentKey) as Array<{ key: string; value: string }>;
	const failing: string[] = [];
	let satisfied = 0;
	let evaluable = 0;
	for (const c of children) {
		const tokens = extractSlugTokens(c.key);
		if (tokens.length === 0) continue; // children with empty slug tokens are not evaluable
		evaluable++;
		const anyInGloss = tokens.some((t) => lowerGloss.includes(t));
		if (anyInGloss) satisfied++;
		else failing.push(c.key);
	}
	const pass = evaluable === 0 || satisfied / evaluable >= R_VC9B_CHILD_COVERAGE_THRESHOLD;
	return {
		parentKey,
		childCount: evaluable,
		childrenWithSubjectInGloss: satisfied,
		pass,
		failingChildKeys: failing,
	};
}
