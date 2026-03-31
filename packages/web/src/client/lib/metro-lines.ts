// Tokyo Metro line colors — same palette as SystemMap.svelte and App.svelte CSS vars
export const LINE_COLORS = [
	"#F39700", // Ginza (G)        — orange
	"#E60012", // Marunouchi (M)   — red
	"#9CAEB7", // Hibiya (H)       — silver
	"#009BBF", // Tozai (T)        — sky blue
	"#009944", // Chiyoda (C)      — green
	"#C1A470", // Yurakucho (Y)    — gold
	"#8F76D6", // Hanzomon (Z)     — purple
	"#00AC9B", // Namboku (N)      — emerald
	"#9C5E31", // Fukutoshin (F)   — brown
	"#B6007A", // Oedo (E)         — ruby
];

// Tokyo Metro line letter codes
export const LINE_CODES = ["G", "M", "H", "T", "C", "Y", "Z", "N", "F", "E"];

export function getLineColor(colorIndex: number): string {
	return LINE_COLORS[colorIndex % LINE_COLORS.length];
}

export function getLineCode(colorIndex: number): string {
	return LINE_CODES[colorIndex % LINE_CODES.length];
}
