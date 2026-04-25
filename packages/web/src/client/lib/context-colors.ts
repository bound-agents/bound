// Signage-palette colors for context-debug section bars. Each SDK section name
// maps to one line color; anything unknown falls back to ink-2.
export const SECTION_COLORS: Record<string, string> = {
	system: "var(--ink)",
	tools: "var(--line-Y)", // gold
	history: "var(--line-M)", // red
	memory: "var(--line-T)", // blue
	conversation: "var(--line-M)", // red
	"task-digest": "var(--line-T)",
	"skill-context": "var(--line-Y)",
	"volatile-other": "var(--line-N)",
	scratchpad: "var(--ink-3)",
	pinned: "var(--accent)",
	summary: "var(--ink)",
	default: "var(--ink-2)",
	detail: "var(--ink-4)",
};

export const FREE_SPACE_COLOR = "var(--paper-3)";
