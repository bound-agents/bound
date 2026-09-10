/**
 * Pure view-logic for SkillsView's per-row action bar (#269).
 *
 * The Svelte template can't be mounted in this package's `bun test` setup (no
 * Svelte compile step in the runner, so a `.svelte` import resolves to a path
 * string), so the decisions the row makes about its delete controls live here
 * as pure functions the template imports and calls directly. Testing these
 * covers the same code the UI runs, rather than re-implementing the gate.
 */

/** A row's delete-control state, decided from the skill and its confirm flag. */
export interface DeleteControls {
	/** Whether any delete affordance renders at all. Built-ins never show one. */
	readonly showDeleteBranch: boolean;
	/** With the branch shown, which controls appear. */
	readonly controls: "none" | "delete" | "confirm-cancel";
}

/**
 * Decide the delete controls for a skill row.
 *
 * Built-in (bundled) skills have no web deletion control — removal is
 * CLI/API-only. Ordinary skills show a single **Delete** button that, once
 * armed, swaps to **Confirm Delete** + **Cancel**.
 */
export function deleteControlsFor(
	skill: { is_builtin: boolean },
	confirming: boolean,
): DeleteControls {
	if (skill.is_builtin) return { showDeleteBranch: false, controls: "none" };
	return {
		showDeleteBranch: true,
		controls: confirming ? "confirm-cancel" : "delete",
	};
}
