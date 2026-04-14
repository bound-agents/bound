import { describe, expect, it } from "bun:test";
import type { Advisory } from "@bound/shared";
import { deduplicateAdvisories } from "../advisory-utils";

function createAdvisory(overrides: Partial<Advisory> = {}): Advisory {
	return {
		id: crypto.randomUUID(),
		type: "cost",
		status: "proposed",
		title: "Test Advisory",
		detail: "Test detail",
		action: null,
		impact: null,
		evidence: null,
		proposed_at: new Date().toISOString(),
		defer_until: null,
		resolved_at: null,
		created_by: "test-user",
		modified_at: new Date().toISOString(),
		...overrides,
	};
}

describe("deduplicateAdvisories", () => {
	describe("grouping by title + status", () => {
		it("groups 5 advisories with same title + status into one DedupedAdvisory with count=5", () => {
			const advisories: Advisory[] = [
				createAdvisory({
					id: "1",
					title: "High Costs",
					status: "proposed",
					proposed_at: new Date("2026-04-13T10:00:00Z").toISOString(),
				}),
				createAdvisory({
					id: "2",
					title: "High Costs",
					status: "proposed",
					proposed_at: new Date("2026-04-13T10:05:00Z").toISOString(),
				}),
				createAdvisory({
					id: "3",
					title: "High Costs",
					status: "proposed",
					proposed_at: new Date("2026-04-13T10:10:00Z").toISOString(),
				}),
				createAdvisory({
					id: "4",
					title: "High Costs",
					status: "proposed",
					proposed_at: new Date("2026-04-13T10:15:00Z").toISOString(),
				}),
				createAdvisory({
					id: "5",
					title: "High Costs",
					status: "proposed",
					proposed_at: new Date("2026-04-13T10:20:00Z").toISOString(),
				}),
			];

			const result = deduplicateAdvisories(advisories);

			expect(result).toHaveLength(1);
			expect(result[0].count).toBe(5);
			expect(result[0].sources).toHaveLength(5);
			expect(result[0].representative.id).toBe("5"); // Most recent
		});

		it("groups advisories correctly with different titles", () => {
			const advisories: Advisory[] = [
				createAdvisory({
					id: "1",
					title: "High Costs",
					status: "proposed",
					proposed_at: new Date("2026-04-13T10:00:00Z").toISOString(),
				}),
				createAdvisory({
					id: "2",
					title: "High Costs",
					status: "proposed",
					proposed_at: new Date("2026-04-13T10:05:00Z").toISOString(),
				}),
				createAdvisory({
					id: "3",
					title: "Memory Issues",
					status: "proposed",
					proposed_at: new Date("2026-04-13T10:10:00Z").toISOString(),
				}),
				createAdvisory({
					id: "4",
					title: "Memory Issues",
					status: "approved",
					proposed_at: new Date("2026-04-13T10:15:00Z").toISOString(),
				}),
			];

			const result = deduplicateAdvisories(advisories);

			expect(result).toHaveLength(3);
			// First group: High Costs + proposed (2 items)
			const highCostsProposed = result.find(
				(r) => r.representative.title === "High Costs" && r.representative.status === "proposed",
			);
			expect(highCostsProposed?.count).toBe(2);

			// Second group: Memory Issues + proposed (1 item)
			const memoryProposed = result.find(
				(r) => r.representative.title === "Memory Issues" && r.representative.status === "proposed",
			);
			expect(memoryProposed?.count).toBe(1);

			// Third group: Memory Issues + approved (1 item)
			const memoryApproved = result.find(
				(r) => r.representative.title === "Memory Issues" && r.representative.status === "approved",
			);
			expect(memoryApproved?.count).toBe(1);
		});
	});

	describe("sorting order", () => {
		it("sorts unresolved (proposed, approved) before resolved (applied, dismissed, deferred)", () => {
			const advisories: Advisory[] = [
				createAdvisory({
					id: "1",
					title: "Applied",
					status: "applied",
					proposed_at: new Date("2026-04-13T10:00:00Z").toISOString(),
				}),
				createAdvisory({
					id: "2",
					title: "Proposed",
					status: "proposed",
					proposed_at: new Date("2026-04-13T09:00:00Z").toISOString(),
				}),
				createAdvisory({
					id: "3",
					title: "Dismissed",
					status: "dismissed",
					proposed_at: new Date("2026-04-13T10:30:00Z").toISOString(),
				}),
				createAdvisory({
					id: "4",
					title: "Approved",
					status: "approved",
					proposed_at: new Date("2026-04-13T08:00:00Z").toISOString(),
				}),
			];

			const result = deduplicateAdvisories(advisories);

			const statuses = result.map((r) => r.representative.status);
			// First two should be unresolved (proposed and approved)
			expect(["proposed", "approved"]).toContain(statuses[0]);
			expect(["proposed", "approved"]).toContain(statuses[1]);
			// Last two should be resolved (applied and dismissed)
			expect(["applied", "dismissed", "deferred"]).toContain(statuses[2]);
			expect(["applied", "dismissed", "deferred"]).toContain(statuses[3]);
		});

		it("sorts by most recent proposed_at within unresolved group", () => {
			const advisories: Advisory[] = [
				createAdvisory({
					id: "1",
					title: "Old",
					status: "proposed",
					proposed_at: new Date("2026-04-13T08:00:00Z").toISOString(),
				}),
				createAdvisory({
					id: "2",
					title: "New",
					status: "proposed",
					proposed_at: new Date("2026-04-13T10:00:00Z").toISOString(),
				}),
				createAdvisory({
					id: "3",
					title: "Middle",
					status: "approved",
					proposed_at: new Date("2026-04-13T09:00:00Z").toISOString(),
				}),
			];

			const result = deduplicateAdvisories(advisories);

			expect(result[0].representative.title).toBe("New");
			expect(result[1].representative.title).toBe("Middle");
			expect(result[2].representative.title).toBe("Old");
		});

		it("sorts by most recent proposed_at within resolved group", () => {
			const advisories: Advisory[] = [
				createAdvisory({
					id: "1",
					title: "Old",
					status: "applied",
					proposed_at: new Date("2026-04-13T08:00:00Z").toISOString(),
				}),
				createAdvisory({
					id: "2",
					title: "New",
					status: "dismissed",
					proposed_at: new Date("2026-04-13T10:00:00Z").toISOString(),
				}),
				createAdvisory({
					id: "3",
					title: "Middle",
					status: "deferred",
					proposed_at: new Date("2026-04-13T09:00:00Z").toISOString(),
				}),
			];

			const result = deduplicateAdvisories(advisories);

			expect(result[0].representative.title).toBe("New");
			expect(result[1].representative.title).toBe("Middle");
			expect(result[2].representative.title).toBe("Old");
		});
	});

	describe("sources array", () => {
		it("includes all sources in descending order by proposed_at", () => {
			const advisories: Advisory[] = [
				createAdvisory({
					id: "1",
					title: "Issue",
					status: "proposed",
					proposed_at: new Date("2026-04-13T10:00:00Z").toISOString(),
				}),
				createAdvisory({
					id: "2",
					title: "Issue",
					status: "proposed",
					proposed_at: new Date("2026-04-13T10:10:00Z").toISOString(),
				}),
				createAdvisory({
					id: "3",
					title: "Issue",
					status: "proposed",
					proposed_at: new Date("2026-04-13T10:05:00Z").toISOString(),
				}),
			];

			const result = deduplicateAdvisories(advisories);

			expect(result[0].sources).toHaveLength(3);
			expect(result[0].sources[0].id).toBe("2"); // Most recent
			expect(result[0].sources[1].id).toBe("3"); // Middle
			expect(result[0].sources[2].id).toBe("1"); // Oldest
		});

		it("preserves single advisory in sources array", () => {
			const advisories: Advisory[] = [
				createAdvisory({
					id: "1",
					title: "Unique",
					status: "proposed",
				}),
			];

			const result = deduplicateAdvisories(advisories);

			expect(result[0].count).toBe(1);
			expect(result[0].sources).toHaveLength(1);
			expect(result[0].sources[0].id).toBe("1");
		});
	});

	describe("representative advisory", () => {
		it("uses most recent advisory as representative", () => {
			const advisories: Advisory[] = [
				createAdvisory({
					id: "1",
					title: "Issue",
					status: "proposed",
					proposed_at: new Date("2026-04-13T10:00:00Z").toISOString(),
					detail: "Old detail",
				}),
				createAdvisory({
					id: "2",
					title: "Issue",
					status: "proposed",
					proposed_at: new Date("2026-04-13T10:10:00Z").toISOString(),
					detail: "New detail",
				}),
			];

			const result = deduplicateAdvisories(advisories);

			expect(result[0].representative.id).toBe("2");
			expect(result[0].representative.detail).toBe("New detail");
		});
	});

	describe("edge cases", () => {
		it("handles empty array", () => {
			const result = deduplicateAdvisories([]);
			expect(result).toEqual([]);
		});

		it("handles single advisory", () => {
			const advisories: Advisory[] = [
				createAdvisory({
					id: "1",
					title: "Single",
					status: "proposed",
				}),
			];

			const result = deduplicateAdvisories(advisories);

			expect(result).toHaveLength(1);
			expect(result[0].count).toBe(1);
			expect(result[0].representative.id).toBe("1");
		});

		it("does not mutate input array", () => {
			const advisories: Advisory[] = [
				createAdvisory({
					id: "1",
					title: "Issue",
					status: "proposed",
				}),
			];
			const original = [...advisories];

			deduplicateAdvisories(advisories);

			expect(advisories).toEqual(original);
		});

		it("handles all resolved statuses correctly", () => {
			const advisories: Advisory[] = [
				createAdvisory({
					id: "1",
					title: "Applied",
					status: "applied",
					proposed_at: new Date("2026-04-13T10:00:00Z").toISOString(),
				}),
				createAdvisory({
					id: "2",
					title: "Dismissed",
					status: "dismissed",
					proposed_at: new Date("2026-04-13T10:05:00Z").toISOString(),
				}),
				createAdvisory({
					id: "3",
					title: "Deferred",
					status: "deferred",
					proposed_at: new Date("2026-04-13T10:10:00Z").toISOString(),
				}),
			];

			const result = deduplicateAdvisories(advisories);

			expect(result).toHaveLength(3);
			// Most recent comes first
			expect(result[0].representative.status).toBe("deferred");
			expect(result[1].representative.status).toBe("dismissed");
			expect(result[2].representative.status).toBe("applied");
		});

		it("handles all unresolved statuses correctly", () => {
			const advisories: Advisory[] = [
				createAdvisory({
					id: "1",
					title: "Approved",
					status: "approved",
					proposed_at: new Date("2026-04-13T10:00:00Z").toISOString(),
				}),
				createAdvisory({
					id: "2",
					title: "Proposed",
					status: "proposed",
					proposed_at: new Date("2026-04-13T10:05:00Z").toISOString(),
				}),
			];

			const result = deduplicateAdvisories(advisories);

			expect(result).toHaveLength(2);
			// Most recent comes first
			expect(result[0].representative.status).toBe("proposed");
			expect(result[1].representative.status).toBe("approved");
		});
	});

	describe("complex scenarios", () => {
		it("handles mix of duplicates and unique advisories", () => {
			const advisories: Advisory[] = [
				// Duplicate group (3 items)
				createAdvisory({
					id: "1",
					title: "High Costs",
					status: "proposed",
					proposed_at: new Date("2026-04-13T10:00:00Z").toISOString(),
				}),
				createAdvisory({
					id: "2",
					title: "High Costs",
					status: "proposed",
					proposed_at: new Date("2026-04-13T10:05:00Z").toISOString(),
				}),
				createAdvisory({
					id: "3",
					title: "High Costs",
					status: "proposed",
					proposed_at: new Date("2026-04-13T10:10:00Z").toISOString(),
				}),
				// Unique
				createAdvisory({
					id: "4",
					title: "Memory",
					status: "proposed",
					proposed_at: new Date("2026-04-13T09:00:00Z").toISOString(),
				}),
				// Duplicate group (2 items, resolved)
				createAdvisory({
					id: "5",
					title: "Fixed",
					status: "applied",
					proposed_at: new Date("2026-04-13T08:00:00Z").toISOString(),
				}),
				createAdvisory({
					id: "6",
					title: "Fixed",
					status: "applied",
					proposed_at: new Date("2026-04-13T08:30:00Z").toISOString(),
				}),
			];

			const result = deduplicateAdvisories(advisories);

			expect(result).toHaveLength(3);
			// Unresolved come first
			expect(result[0].representative.title).toBe("High Costs");
			expect(result[0].count).toBe(3);
			expect(result[1].representative.title).toBe("Memory");
			expect(result[1].count).toBe(1);
			// Resolved come last
			expect(result[2].representative.title).toBe("Fixed");
			expect(result[2].count).toBe(2);
		});
	});
});
