export function sortRows(
	rows: Record<string, unknown>[],
	sortKey: string | null | undefined,
	sortDir: "asc" | "desc",
): Record<string, unknown>[] {
	if (!sortKey) {
		return [...rows];
	}

	return [...rows].sort((a, b) => {
		const aVal = a[sortKey];
		const bVal = b[sortKey];

		// Null values go to end regardless of direction
		if (aVal === null || aVal === undefined) {
			if (bVal === null || bVal === undefined) {
				return 0;
			}
			return 1;
		}
		if (bVal === null || bVal === undefined) {
			return -1;
		}

		// Compare values
		let comparison = 0;
		if (typeof aVal === "string" && typeof bVal === "string") {
			comparison = aVal.localeCompare(bVal, undefined, {
				sensitivity: "base",
			});
		} else if (typeof aVal === "number" && typeof bVal === "number") {
			comparison = aVal - bVal;
		} else {
			// Fallback to string comparison
			const aStr = String(aVal);
			const bStr = String(bVal);
			comparison = aStr.localeCompare(bStr, undefined, {
				sensitivity: "base",
			});
		}

		return sortDir === "asc" ? comparison : -comparison;
	});
}
