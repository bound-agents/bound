/**
 * Bundled skills shipped with the binary and seeded on startup.
 *
 * Source of truth: the markdown under `packages/agent/src/bundled-skills/<name>/`.
 * That tree is embedded into `bundled-skills.generated.ts` by
 * `scripts/embed-bundled-skills.ts` (so `bun build --compile` can include it with
 * no FS access). Edit the markdown, then regenerate:
 *
 *   bun run scripts/embed-bundled-skills.ts
 *
 * A test (bundled-skills-sync.test.ts) fails if the generated file is stale.
 */

export type { BundledSkill, BundledSkillFile } from "./bundled-skills-types";
export { BUNDLED_SKILLS } from "./bundled-skills.generated";
