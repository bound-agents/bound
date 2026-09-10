/**
 * Built-in (bundled) skill identity, derived from the shipped catalog.
 *
 * A skill is "built-in" iff its ID is the deterministic name-based UUID of a
 * bundled skill (the same ID `seedBundledSkill` assigns in seed-skills.ts).
 * This is the ONLY sound discriminator: `skill_root` and a null
 * `created_by_thread` are shared by operator-imported skills, so neither can
 * distinguish built-ins.
 *
 * The catalog import (`BUNDLED_SKILLS`) carries skill metadata but is used here
 * only for its `name` list — callers on the server compute IDs from names, so
 * no markdown body or runtime module is pulled into any browser bundle.
 */
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { BUNDLED_SKILLS } from "./bundled-skills";

/** Deterministic IDs of every bundled skill, computed once from the catalog. */
const BUILTIN_SKILL_IDS: ReadonlySet<string> = new Set(
	BUNDLED_SKILLS.map((skill) => deterministicUUID(BOUND_NAMESPACE, skill.name)),
);

/** True iff `id` is the deterministic ID of a bundled (built-in) skill. */
export function isBuiltinSkillId(id: string): boolean {
	return BUILTIN_SKILL_IDS.has(id);
}
