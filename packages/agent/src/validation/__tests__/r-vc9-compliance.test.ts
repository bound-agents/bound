import Database from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import {
	buildTokenFrequencyTable,
	checkR_VC9,
	checkR_VC9b,
	extractSlugTokens,
} from "../r-vc9-compliance";

describe("extractSlugTokens", () => {
	it("extracts tokens from a multi-word slug", () => {
		const tokens = extractSlugTokens("_summary:transit-systems-and-routing");
		expect(tokens).toEqual(["transit", "systems", "and", "routing"]);
	});

	it("returns empty array for empty slug", () => {
		const tokens = extractSlugTokens("_summary:");
		expect(tokens).toEqual([]);
	});

	it("returns empty array for key without colon", () => {
		const tokens = extractSlugTokens("nokey");
		expect(tokens).toEqual([]);
	});

	it("drops ISO-8601 date stamps when matching the full token", () => {
		// For the full ISO-8601 match, the entire token is dropped.
		// But digit-boundary splits turn "agent-eval-research-2026-04-16" into
		// multiple tokens: ["agent", "eval", "research", "2026", "04", "16"].
		// The full date "2026-04-16" would only match if it were a single token.
		const tokens = extractSlugTokens("_summary:agent-eval-research-2026-04-16");
		// Digit-boundary splits produce: agent, eval, research, 2026, 04, 16
		// 2026, 04, 16 are each 3+ chars and not full ISO-8601 dates, so kept.
		expect(tokens).toContain("agent");
		expect(tokens).toContain("eval");
		expect(tokens).toContain("research");
		// 2026, 04, 16 should be included because they don't match the full ISO-8601 pattern individually
		expect(tokens).toContain("2026");
		// 04 and 16 are only 2 chars each, so dropped (< MIN_TOKEN_LENGTH)
		expect(tokens).not.toContain("04");
		expect(tokens).not.toContain("16");
	});

	it("handles digit boundaries correctly", () => {
		const tokens = extractSlugTokens("_summary:tokyo-metro-graphviz");
		expect(tokens).toEqual(["tokyo", "metro", "graphviz"]);
	});

	it("preserves numeric tokens of length >= 3", () => {
		const tokens = extractSlugTokens("_summary:foo123bar");
		// Split on digit boundaries: foo, 123, bar
		// All are >= 3 chars, so kept
		expect(tokens).toEqual(["foo", "123", "bar"]);
	});
});

describe("buildTokenFrequencyTable", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		db.exec(`
			CREATE TABLE semantic_memory (
				id TEXT PRIMARY KEY,
				key TEXT NOT NULL,
				value TEXT NOT NULL,
				deleted INTEGER DEFAULT 0
			);
			CREATE TABLE memory_edges (
				source_key TEXT NOT NULL,
				target_key TEXT NOT NULL,
				relation TEXT NOT NULL,
				deleted INTEGER DEFAULT 0
			);
		`);
	});

	it("returns empty map for empty corpus", () => {
		const freq = buildTokenFrequencyTable(db);
		expect(freq.size).toBe(0);
	});

	it("counts tokens from a single entry", () => {
		db.prepare("INSERT INTO semantic_memory VALUES (?, ?, ?, ?)").run(
			"id1",
			"_summary:test",
			"hello world test",
			0,
		);
		const freq = buildTokenFrequencyTable(db);
		expect(freq.get("hello")).toBe(1);
		expect(freq.get("world")).toBe(1);
		expect(freq.get("test")).toBe(1);
	});

	it("counts tokens from multiple entries", () => {
		db.prepare("INSERT INTO semantic_memory VALUES (?, ?, ?, ?)").run(
			"id1",
			"_summary:test1",
			"hello world",
			0,
		);
		db.prepare("INSERT INTO semantic_memory VALUES (?, ?, ?, ?)").run(
			"id2",
			"_summary:test2",
			"hello there",
			0,
		);
		const freq = buildTokenFrequencyTable(db);
		expect(freq.get("hello")).toBe(2);
		expect(freq.get("world")).toBe(1);
		expect(freq.get("there")).toBe(1);
	});

	it("de-duplicates tokens within a single entry", () => {
		db.prepare("INSERT INTO semantic_memory VALUES (?, ?, ?, ?)").run(
			"id1",
			"_summary:test",
			"hello hello world hello",
			0,
		);
		const freq = buildTokenFrequencyTable(db);
		// hello appears once per entry, not 3 times
		expect(freq.get("hello")).toBe(1);
		expect(freq.get("world")).toBe(1);
	});

	it("ignores soft-deleted entries", () => {
		db.prepare("INSERT INTO semantic_memory VALUES (?, ?, ?, ?)").run(
			"id1",
			"_summary:test1",
			"hello world",
			0,
		);
		db.prepare("INSERT INTO semantic_memory VALUES (?, ?, ?, ?)").run(
			"id2",
			"_summary:test2",
			"hello there",
			1, // deleted
		);
		const freq = buildTokenFrequencyTable(db);
		expect(freq.get("hello")).toBe(1);
		expect(freq.get("world")).toBe(1);
		expect(freq.get("there")).toBeUndefined();
	});
});

describe("checkR_VC9", () => {
	let freq: Map<string, number>;

	beforeEach(() => {
		freq = new Map();
		// Set up a corpus with transit, systems, routing each at frequency 5+
		for (let i = 0; i < 5; i++) {
			freq.set("transit", (freq.get("transit") ?? 0) + 1);
			freq.set("systems", (freq.get("systems") ?? 0) + 1);
			freq.set("routing", (freq.get("routing") ?? 0) + 1);
		}
		// Add a low-frequency token
		freq.set("obscure", 1);
	});

	it("passes when slug has 3+ tokens both in body and with corpus freq >= 5", () => {
		const key = "_summary:transit-systems-routing";
		const value = "We discussed transit systems and routing patterns four times";
		const result = checkR_VC9(key, value, freq);
		expect(result.pass).toBe(true);
		expect(result.bothConditions.length).toBeGreaterThanOrEqual(3);
	});

	it("fails when slug tokens are absent from value body", () => {
		const key = "_summary:foo-bar-baz";
		const value = "This entry is about something completely different";
		const result = checkR_VC9(key, value, freq);
		expect(result.pass).toBe(false);
	});

	it("fails when slug tokens have corpus frequency < 5", () => {
		const key = "_summary:obscure-uncommon-rare";
		freq.set("uncommon", 2);
		freq.set("rare", 3);
		const value = "This entry mentions obscure uncommon rare things";
		const result = checkR_VC9(key, value, freq);
		expect(result.pass).toBe(false);
	});

	it("drops ISO-8601 dates from slug before checking", () => {
		const key = "_summary:agent-eval-2026-04-16";
		const value = "Agent evaluation entry";
		const result = checkR_VC9(key, value, freq);
		// "2026-04-16" as a whole matches ISO-8601 regex, so is dropped.
		// Digit-boundary splits may produce "2026" (4 chars, kept).
		// But the key extraction should not include the full ISO date.
		expect(result.slugTokens).not.toContain("2026-04-16");
	});
});

describe("checkR_VC9b", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		db.exec(`
			CREATE TABLE semantic_memory (
				id TEXT PRIMARY KEY,
				key TEXT NOT NULL,
				value TEXT NOT NULL,
				deleted INTEGER DEFAULT 0
			);
			CREATE TABLE memory_edges (
				source_key TEXT NOT NULL,
				target_key TEXT NOT NULL,
				relation TEXT NOT NULL,
				deleted INTEGER DEFAULT 0
			);
		`);
	});

	it("passes when no children exist (degenerate case)", () => {
		db.prepare("INSERT INTO semantic_memory VALUES (?, ?, ?, ?)").run(
			"parent-id",
			"_summary:parent-topic",
			"Parent gloss text here",
			0,
		);
		const result = checkR_VC9b(db, "_summary:parent-topic", "Parent gloss text here");
		expect(result.pass).toBe(true);
		expect(result.childCount).toBe(0);
	});

	it("passes when all children's slug tokens appear in parent gloss", () => {
		db.prepare("INSERT INTO semantic_memory VALUES (?, ?, ?, ?)").run(
			"parent-id",
			"_summary:parent-topic",
			"Discussion of transit systems and routing details",
			0,
		);
		db.prepare("INSERT INTO semantic_memory VALUES (?, ?, ?, ?)").run(
			"child1-id",
			"_detail:transit-network",
			"Child 1 content",
			0,
		);
		db.prepare("INSERT INTO semantic_memory VALUES (?, ?, ?, ?)").run(
			"child2-id",
			"_detail:systems-design",
			"Child 2 content",
			0,
		);
		db.prepare("INSERT INTO memory_edges VALUES (?, ?, ?, ?)").run(
			"_summary:parent-topic",
			"_detail:transit-network",
			"summarizes",
			0,
		);
		db.prepare("INSERT INTO memory_edges VALUES (?, ?, ?, ?)").run(
			"_summary:parent-topic",
			"_detail:systems-design",
			"summarizes",
			0,
		);
		const result = checkR_VC9b(
			db,
			"_summary:parent-topic",
			"Discussion of transit systems and routing details",
		);
		expect(result.pass).toBe(true);
		expect(result.childrenWithSubjectInGloss).toBeGreaterThanOrEqual(2);
	});

	it("passes at exactly 80% child coverage threshold", () => {
		db.prepare("INSERT INTO semantic_memory VALUES (?, ?, ?, ?)").run(
			"parent-id",
			"_summary:parent",
			"transit routing systems planning",
			0,
		);
		// 5 children: 4 with tokens in gloss, 1 without = 80%
		for (let i = 0; i < 4; i++) {
			db.prepare("INSERT INTO semantic_memory VALUES (?, ?, ?, ?)").run(
				`child${i}-id`,
				`_detail:transit-${i}`,
				"content",
				0,
			);
			db.prepare("INSERT INTO memory_edges VALUES (?, ?, ?, ?)").run(
				"_summary:parent",
				`_detail:transit-${i}`,
				"summarizes",
				0,
			);
		}
		// 5th child with no matching tokens
		db.prepare("INSERT INTO semantic_memory VALUES (?, ?, ?, ?)").run(
			"child4-id",
			"_detail:unknown-topic",
			"content",
			0,
		);
		db.prepare("INSERT INTO memory_edges VALUES (?, ?, ?, ?)").run(
			"_summary:parent",
			"_detail:unknown-topic",
			"summarizes",
			0,
		);
		const result = checkR_VC9b(db, "_summary:parent", "transit routing systems planning");
		expect(result.pass).toBe(true);
		expect(result.childrenWithSubjectInGloss).toBe(4);
		expect(result.childCount).toBe(5);
	});

	it("fails below 80% child coverage threshold", () => {
		db.prepare("INSERT INTO semantic_memory VALUES (?, ?, ?, ?)").run(
			"parent-id",
			"_summary:parent",
			"transit routing systems planning",
			0,
		);
		// 4 children: 3 with tokens in gloss, 1 without = 75%
		for (let i = 0; i < 3; i++) {
			db.prepare("INSERT INTO semantic_memory VALUES (?, ?, ?, ?)").run(
				`child${i}-id`,
				`_detail:transit-${i}`,
				"content",
				0,
			);
			db.prepare("INSERT INTO memory_edges VALUES (?, ?, ?, ?)").run(
				"_summary:parent",
				`_detail:transit-${i}`,
				"summarizes",
				0,
			);
		}
		// 4th child with no matching tokens
		db.prepare("INSERT INTO semantic_memory VALUES (?, ?, ?, ?)").run(
			"child3-id",
			"_detail:unknown-topic",
			"content",
			0,
		);
		db.prepare("INSERT INTO memory_edges VALUES (?, ?, ?, ?)").run(
			"_summary:parent",
			"_detail:unknown-topic",
			"summarizes",
			0,
		);
		const result = checkR_VC9b(db, "_summary:parent", "transit routing systems planning");
		expect(result.pass).toBe(false);
		expect(result.childrenWithSubjectInGloss).toBe(3);
		expect(result.childCount).toBe(4);
	});

	it("excludes children with empty slug tokens from evaluation", () => {
		db.prepare("INSERT INTO semantic_memory VALUES (?, ?, ?, ?)").run(
			"parent-id",
			"_summary:parent",
			"transit systems",
			0,
		);
		// 2 normal children
		db.prepare("INSERT INTO semantic_memory VALUES (?, ?, ?, ?)").run(
			"child1-id",
			"_detail:transit-info",
			"content",
			0,
		);
		db.prepare("INSERT INTO memory_edges VALUES (?, ?, ?, ?)").run(
			"_summary:parent",
			"_detail:transit-info",
			"summarizes",
			0,
		);
		db.prepare("INSERT INTO semantic_memory VALUES (?, ?, ?, ?)").run(
			"child2-id",
			"_detail:systems-doc",
			"content",
			0,
		);
		db.prepare("INSERT INTO memory_edges VALUES (?, ?, ?, ?)").run(
			"_summary:parent",
			"_detail:systems-doc",
			"summarizes",
			0,
		);
		// 1 child with empty slug (no colon)
		db.prepare("INSERT INTO semantic_memory VALUES (?, ?, ?, ?)").run(
			"child3-id",
			"no-key-structure",
			"content",
			0,
		);
		db.prepare("INSERT INTO memory_edges VALUES (?, ?, ?, ?)").run(
			"_summary:parent",
			"no-key-structure",
			"summarizes",
			0,
		);
		const result = checkR_VC9b(db, "_summary:parent", "transit systems");
		// Only 2 evaluable children, both have tokens in gloss = 100%
		expect(result.childCount).toBe(2);
		expect(result.childrenWithSubjectInGloss).toBe(2);
		expect(result.pass).toBe(true);
	});

	it("lists failing child keys in failingChildKeys", () => {
		db.prepare("INSERT INTO semantic_memory VALUES (?, ?, ?, ?)").run(
			"parent-id",
			"_summary:parent",
			"transit systems",
			0,
		);
		db.prepare("INSERT INTO semantic_memory VALUES (?, ?, ?, ?)").run(
			"child1-id",
			"_detail:transit-info",
			"content",
			0,
		);
		db.prepare("INSERT INTO memory_edges VALUES (?, ?, ?, ?)").run(
			"_summary:parent",
			"_detail:transit-info",
			"summarizes",
			0,
		);
		db.prepare("INSERT INTO semantic_memory VALUES (?, ?, ?, ?)").run(
			"child2-id",
			"_detail:missing-topic",
			"content",
			0,
		);
		db.prepare("INSERT INTO memory_edges VALUES (?, ?, ?, ?)").run(
			"_summary:parent",
			"_detail:missing-topic",
			"summarizes",
			0,
		);
		const result = checkR_VC9b(db, "_summary:parent", "transit systems");
		expect(result.failingChildKeys).toContain("_detail:missing-topic");
		expect(result.failingChildKeys).not.toContain("_detail:transit-info");
	});
});
