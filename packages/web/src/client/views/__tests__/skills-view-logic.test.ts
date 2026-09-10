import { describe, expect, it } from "bun:test";
import { deleteControlsFor } from "../skills-view-logic";

// #269 — SkillsView's per-row delete controls. The Svelte template can't be
// mounted in this package's bun test setup, so it delegates its two decisions
// to `deleteControlsFor` and these assert the exact code the row runs.
describe("deleteControlsFor (#269 delete-control gating)", () => {
	it("built-in rows show no delete branch at all, in either confirm state", () => {
		expect(deleteControlsFor({ is_builtin: true }, false)).toEqual({
			showDeleteBranch: false,
			controls: "none",
		});
		// Even if a stale confirm flag lingers, a built-in shows nothing.
		expect(deleteControlsFor({ is_builtin: true }, true)).toEqual({
			showDeleteBranch: false,
			controls: "none",
		});
	});

	it("ordinary rows show a single Delete control when not confirming", () => {
		expect(deleteControlsFor({ is_builtin: false }, false)).toEqual({
			showDeleteBranch: true,
			controls: "delete",
		});
	});

	it("ordinary rows swap to Confirm+Cancel once armed", () => {
		expect(deleteControlsFor({ is_builtin: false }, true)).toEqual({
			showDeleteBranch: true,
			controls: "confirm-cancel",
		});
	});

	it("an ordinary row exposes exactly one delete-triggering control across the flow", () => {
		// Pre-arm: one Delete button (the only control that arms confirmation).
		const idle = deleteControlsFor({ is_builtin: false }, false);
		expect(idle.controls).toBe("delete");
		// Armed: Confirm Delete (the only control that calls DELETE) plus Cancel —
		// so exactly one DELETE-triggering control is ever present at a time.
		const armed = deleteControlsFor({ is_builtin: false }, true);
		expect(armed.controls).toBe("confirm-cancel");
	});
});
