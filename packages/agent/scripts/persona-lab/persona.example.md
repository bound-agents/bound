# Persona draft goes here

Copy this file to `persona.md` (which is gitignored - your working draft stays
local and free to edit without tripping the pre-commit hook) and put the full
persona prompt in it. `compare.ts` reads `persona.md` by default; override with
`--persona <path>`.

The persona is injected as the `persona` row in cluster_config for each run,
exactly as the live daemon assembles it.
