// Line identity palette — muted to sit on warm paper. Used ONLY inside badges,
// dots, and thin rule lines — never as backgrounds or glows.
// Index order mirrors the canonical Tokyo Metro letters (G, M, H, T, C, Y, Z,
// N, F, E); the matching CSS vars live in App.svelte.
export const LINE_COLORS = [
	"#D9861A", // 0 — Ginza      · amber
	"#C8331C", // 1 — Marunouchi · red (same hue as the signal accent)
	"#7D8B93", // 2 — Hibiya     · silver
	"#1E7FA8", // 3 — Tozai      · blue
	"#2E7D47", // 4 — Chiyoda    · green
	"#A8885A", // 5 — Yurakucho  · gold
	"#6B5BB3", // 6 — Hanzomon   · violet
	"#0E8E83", // 7 — Namboku    · teal
	"#8B5E34", // 8 — Fukutoshin · brown
	"#9B2A6E", // 9 — Oedo       · ruby
];

export const LINE_CODES = ["G", "M", "H", "T", "C", "Y", "Z", "N", "F", "E"];
export const LINE_NAMES = [
	"Ginza",
	"Marunouchi",
	"Hibiya",
	"Tozai",
	"Chiyoda",
	"Yurakucho",
	"Hanzomon",
	"Namboku",
	"Fukutoshin",
	"Oedo",
];

export function getLineColor(colorIndex: number): string {
	return LINE_COLORS[colorIndex % LINE_COLORS.length];
}

export function getLineCode(colorIndex: number): string {
	return LINE_CODES[colorIndex % LINE_CODES.length];
}

export function getLineName(colorIndex: number): string {
	return LINE_NAMES[colorIndex % LINE_NAMES.length];
}

export function getLineCssVar(colorIndex: number): string {
	return `var(--line-${colorIndex % LINE_COLORS.length})`;
}
