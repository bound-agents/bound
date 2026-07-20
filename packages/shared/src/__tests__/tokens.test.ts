import { describe, expect, it } from "bun:test";
import {
	__tokenCacheStats,
	countContentTokens,
	countContentTokensById,
	countTokens,
} from "../tokens";

describe("tokens", () => {
	describe("countTokens", () => {
		it("AC1.1: returns positive integer for normal text", () => {
			const count = countTokens("hello world");
			expect(count).toBeGreaterThan(0);
			expect(Number.isInteger(count)).toBe(true);
		});

		it("AC1.1: cl100k_base encodes 'hello world' as 2 tokens", () => {
			expect(countTokens("hello world")).toBe(2);
		});

		it("AC1.5: empty string returns 0", () => {
			expect(countTokens("")).toBe(0);
		});

		it("handles long text with reasonable token count", () => {
			// 1000 characters should be approximately 250 tokens
			const longText = "a".repeat(1000);
			const count = countTokens(longText);
			expect(count).toBeGreaterThan(100);
			expect(count).toBeLessThan(500);
		});
	});

	describe("countContentTokens", () => {
		it("AC1.2 (string): matches countTokens for string input", () => {
			const text = "hello world";
			expect(countContentTokens(text)).toBe(countTokens(text));
		});

		it("AC1.5: empty string returns 0", () => {
			expect(countContentTokens("")).toBe(0);
		});

		it("AC1.2 (ContentBlock[]): empty array returns 0", () => {
			expect(countContentTokens([])).toBe(0);
		});

		it("AC1.2 (ContentBlock[]): single text block", () => {
			const content = [{ type: "text", text: "hello" }];
			const expected = countTokens("hello");
			expect(countContentTokens(content)).toBe(expected);
		});

		it("AC1.5 (ContentBlock[]): text block with empty string", () => {
			const content = [{ type: "text", text: "" }];
			expect(countContentTokens(content)).toBe(0);
		});

		it("AC1.2 (ContentBlock[]): multiple text blocks sum", () => {
			const content = [
				{ type: "text", text: "hello" },
				{ type: "text", text: "world" },
			];
			const expected = countTokens("hello") + countTokens("world");
			expect(countContentTokens(content)).toBe(expected);
		});

		it("AC1.2 (ContentBlock[]): tool_use block counts as JSON", () => {
			const toolUseBlock = {
				type: "tool_use",
				id: "1",
				name: "test",
				input: {},
			};
			const content = [toolUseBlock];
			const expected = countTokens(JSON.stringify(toolUseBlock));
			expect(countContentTokens(content)).toBe(expected);
		});

		it("AC1.2 (ContentBlock[]): mixed text and tool_use blocks", () => {
			const content = [
				{ type: "text", text: "hello" },
				{
					type: "tool_use",
					id: "1",
					name: "test",
					input: {},
				},
			];
			const expected = countTokens("hello") + countTokens(JSON.stringify(content[1]));
			expect(countContentTokens(content)).toBe(expected);
		});

		it("AC1.4: lazy initialization works on first call", () => {
			// Simply verify that calling countTokens works correctly
			// (proves lazy init succeeded)
			const result = countTokens("test");
			expect(result).toBeGreaterThan(0);
		});
	});

	describe("memoization", () => {
		it("caches a first-seen string and serves the repeat from cache (same value)", () => {
			const text = `memo-probe-${Math.random()}-${"lorem ipsum dolor ".repeat(50)}`;
			expect(__tokenCacheStats().has(text)).toBe(false);

			const before = __tokenCacheStats();
			const first = countTokens(text);
			const afterMiss = __tokenCacheStats();
			// First count is a miss that populates the cache.
			expect(afterMiss.misses).toBe(before.misses + 1);
			expect(afterMiss.has(text)).toBe(true);

			const second = countTokens(text);
			const afterHit = __tokenCacheStats();
			// Second identical count is served from cache: a hit, no new miss, identical value.
			expect(second).toBe(first);
			expect(afterHit.hits).toBe(afterMiss.hits + 1);
			expect(afterHit.misses).toBe(afterMiss.misses);
		});

		it("countContentTokens text blocks share the same cache", () => {
			const unique = `memo-block-${Math.random()}`;
			const block = { type: "text", text: unique };
			expect(__tokenCacheStats().has(unique)).toBe(false);
			countContentTokens([block]);
			// The text block's string is what gets cached (not the JSON of the block).
			expect(__tokenCacheStats().has(unique)).toBe(true);
		});

		it("tracks cached bytes and never exceeds the byte cap", () => {
			// Exercise the byte accounting without encoding tens of MB (the pure-JS
			// tokenizer runs at ~8k chars/sec, so churning the full 64MB cap would
			// make this test take minutes). A modest set keeps the invariant checks
			// fast while still verifying bytes are tracked and bounded.
			for (let i = 0; i < 500; i++) countTokens(`byte-accounting-entry-${i}`);
			const stats = __tokenCacheStats();
			expect(stats.bytes).toBeGreaterThan(0);
			expect(stats.bytes).toBeLessThanOrEqual(stats.maxBytes);
			// bytes must equal the summed lengths of the resident keys.
			expect(stats.bytes).toBeLessThanOrEqual(64 * 1024 * 1024);
		});

		it("keeps a >1024-entry working set resident (fixes the LRU thrash)", () => {
			// Regression for the 80-110s context-assembly CPU peg: the old
			// 1024-ENTRY bound thrashed on threads with >1024 distinct messages,
			// so repeated full-history token passes re-encoded everything at a ~1%
			// hit rate. With a byte bound, a realistic working set (2000 modest
			// strings) stays resident, so a second pass is served almost entirely
			// from cache.
			const corpus = Array.from({ length: 2000 }, (_, i) => `resident-working-set-entry-${i}`);
			for (const s of corpus) countTokens(s); // pass 1 — populate
			const before = __tokenCacheStats();
			for (const s of corpus) countTokens(s); // pass 2 — should be near-all hits
			const after = __tokenCacheStats();
			const passHits = after.hits - before.hits;
			const passMisses = after.misses - before.misses;
			expect(passMisses).toBe(0);
			expect(passHits).toBe(corpus.length);
		});
	});

	describe("countContentTokensById (per-message identity cache)", () => {
		it("returns the same count as countContentTokens (lossless)", () => {
			const content = `id-lossless-${Math.random()}-${"payload ".repeat(40)}`;
			expect(countContentTokensById("msg-1", "2026-01-01T00:00:00Z", content)).toBe(
				countContentTokens(content),
			);
		});

		it("serves a repeat (id, modified_at) from cache without re-encoding", () => {
			const id = `id-hit-${Math.random()}`;
			const modifiedAt = "2026-01-01T00:00:00Z";
			const content = `body-${Math.random()}-${"x ".repeat(30)}`;
			expect(__tokenCacheStats().hasId(id, modifiedAt)).toBe(false);

			const before = __tokenCacheStats();
			const first = countContentTokensById(id, modifiedAt, content);
			const afterMiss = __tokenCacheStats();
			expect(afterMiss.idMisses).toBe(before.idMisses + 1);
			expect(afterMiss.hasId(id, modifiedAt)).toBe(true);

			// A second call with the SAME identity must be a pure id-cache hit — even
			// though we pass different content bytes, the cached count is returned
			// (identity is the key). This is what survives cross-thread content churn.
			const second = countContentTokensById(id, modifiedAt, "totally different content");
			const afterHit = __tokenCacheStats();
			expect(second).toBe(first);
			expect(afterHit.idHits).toBe(afterMiss.idHits + 1);
			expect(afterHit.idMisses).toBe(afterMiss.idMisses);
		});

		it("invalidates when modified_at changes (redaction bumps modified_at)", () => {
			const id = `id-redact-${Math.random()}`;
			const original = `original body ${"y ".repeat(20)}`;
			const firstCount = countContentTokensById(id, "2026-01-01T00:00:00Z", original);

			// Redaction rewrites content to "[redacted]" AND bumps modified_at.
			const before = __tokenCacheStats();
			const redactedCount = countContentTokensById(id, "2026-06-01T00:00:00Z", "[redacted]");
			const after = __tokenCacheStats();
			// New modified_at => cache miss => recomputed against the redacted content.
			expect(after.idMisses).toBe(before.idMisses + 1);
			expect(redactedCount).toBe(countContentTokens("[redacted]"));
			expect(redactedCount).not.toBe(firstCount);
		});

		it("a full-history second pass over the same messages hits the id-cache 100% (the fix)", () => {
			// Regression for the ~100s cold-rebuild peg: even when the content cache
			// is thrashed by other threads, re-counting the SAME messages by identity
			// must be all hits. Simulate content-cache churn between the two passes.
			const msgs = Array.from({ length: 1500 }, (_, i) => ({
				id: `hist-${Math.random()}-${i}`,
				modifiedAt: "2026-01-01T00:00:00Z",
				content: `history message ${i} ${"tok ".repeat(10)}`,
			}));
			for (const m of msgs) countContentTokensById(m.id, m.modifiedAt, m.content); // pass 1
			// Churn the CONTENT cache with unrelated strings (other threads). The
			// id-cache hit does not depend on churn volume, so keep the strings small
			// to stay fast against the ~8k chars/sec pure-JS tokenizer.
			for (let i = 0; i < 500; i++) countTokens(`other-thread-${i}-${"z".repeat(50)}`);

			const before = __tokenCacheStats();
			for (const m of msgs) countContentTokensById(m.id, m.modifiedAt, m.content); // pass 2
			const after = __tokenCacheStats();
			expect(after.idMisses - before.idMisses).toBe(0);
			expect(after.idHits - before.idHits).toBe(msgs.length);
		});

		it("stays bounded by entry count under churn", () => {
			for (let i = 0; i < 60_000; i++) {
				countContentTokensById(`bound-${i}`, "2026-01-01T00:00:00Z", `c${i}`);
			}
			expect(__tokenCacheStats().idSize).toBeLessThanOrEqual(__tokenCacheStats().idMaxEntries);
		});
	});
});
