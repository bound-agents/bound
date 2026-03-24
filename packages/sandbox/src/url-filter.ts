export class UrlFilter {
	constructor(private allowedPrefixes: string[]) {}

	isAllowed(url: string): boolean {
		if (this.allowedPrefixes.length === 0) return true; // No restrictions if empty
		return this.allowedPrefixes.some((prefix) => url.startsWith(prefix));
	}

	enforce(url: string): void {
		if (!this.isAllowed(url)) {
			throw new Error(
				`Outbound request to ${url} blocked: not in allowlist. Allowed prefixes: ${this.allowedPrefixes.join(", ")}`,
			);
		}
	}
}

export function createUrlFilter(allowedPrefixes: string[]): UrlFilter {
	return new UrlFilter(allowedPrefixes);
}
