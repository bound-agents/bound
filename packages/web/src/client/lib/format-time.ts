export function formatRelativeTime(isoString: string): string {
	const date = new Date(isoString);
	const now = new Date();

	const diffMs = now.getTime() - date.getTime();
	const diffSecs = Math.floor(diffMs / 1000);
	const diffMins = Math.floor(diffSecs / 60);
	const diffHours = Math.floor(diffMins / 60);
	const diffDays = Math.floor(diffHours / 24);

	if (diffSecs < 60) {
		return "now";
	}
	if (diffMins < 60) {
		return `${diffMins}m ago`;
	}
	if (diffHours < 24) {
		return `${diffHours}h ago`;
	}
	if (diffDays < 7) {
		return `${diffDays}d ago`;
	}
	return date.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
	});
}

export function isToday(isoString: string): boolean {
	const date = new Date(isoString);
	const now = new Date();

	return (
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate()
	);
}

/** "Feb 13, 2026". Invalid input renders as the empty option. */
export function formatDate(iso: string, { empty = iso }: { empty?: string } = {}): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return empty;
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** 24-hour "HH:MM" in local time; missing or invalid input renders as the empty option. */
export function fmtHhmm(
	iso: string | undefined | null,
	{ empty = "" }: { empty?: string } = {},
): string {
	if (!iso) return empty;
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return empty;
	return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${Math.round((bytes / k ** i) * 10) / 10} ${sizes[i]}`;
}
