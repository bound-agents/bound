// Signage-palette colors for context-debug section bars. Each SDK section name
// maps to one line color; anything unknown falls back to ink-2.
//
// Volatile context split (R-VC24): `volatile-prefix` is the cacheable stable
// portion (Working Knowledge bodies + Discoverable Archive titles + skill
// index) folded into the system param; `volatile-tail` is the uncached varying
// portion (Working Knowledge updates + Live State + suffix metadata)
// rendered as a developer-role message after history. Distinct colors so the
// cache boundary is visible at a glance in the debugger.
export const SECTION_COLORS: Record<string, string> = {
	system: "var(--ink)",
	tools: "var(--line-Y)", // gold
	history: "var(--line-M)", // red
	memory: "var(--line-T)", // blue
	conversation: "var(--line-M)", // red
	"task-digest": "var(--line-T)",
	"skill-context": "var(--line-Y)",
	"volatile-prefix": "var(--accent)",
	"volatile-tail": "var(--line-N)",
	"volatile-other": "var(--line-N)",
	scratchpad: "var(--ink-3)",
	pinned: "var(--accent)",
	summary: "var(--ink)",
	default: "var(--ink-2)",
	detail: "var(--ink-4)",
};

export const FREE_SPACE_COLOR = "var(--paper-3)";
