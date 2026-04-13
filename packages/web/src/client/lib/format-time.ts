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
	// Return formatted date like "Feb 13"
	return date.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
	});
}

export function isToday(isoString: string): boolean {
	const date = new Date(isoString);
	const now = new Date();

	return (
		date.getUTCFullYear() === now.getUTCFullYear() &&
		date.getUTCMonth() === now.getUTCMonth() &&
		date.getUTCDate() === now.getUTCDate()
	);
}
