/**
 * Shared types for bundled skills.
 *
 * Kept free of runtime imports so the codegen script (scripts/embed-bundled-skills.ts),
 * the generated module (bundled-skills.generated.ts), and the runtime barrel
 * (bundled-skills.ts) can all reference these shapes without import cycles.
 */

/** A single file belonging to a bundled skill. */
export interface BundledSkillFile {
	/** Path relative to the skill root, e.g. "SKILL.md" or "references/tools.md". */
	path: string;
	content: string;
}

/** A skill shipped with the binary and seeded to the files/skills tables on startup. */
export interface BundledSkill {
	name: string;
	description: string;
	allowedTools: string | null;
	compatibility: string | null;
	/** All files for the skill, including SKILL.md. Sorted by path for determinism. */
	files: BundledSkillFile[];
}
