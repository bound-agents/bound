const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackHost(host: string): boolean {
	return LOOPBACK_HOSTS.has(host);
}

/** Strip the port from a Host header, keeping the brackets of an IPv6 literal. */
export function extractHostName(hostHeader: string): string {
	if (hostHeader.startsWith("[")) {
		const end = hostHeader.indexOf("]");
		return end === -1 ? hostHeader : hostHeader.slice(0, end + 1);
	}
	return hostHeader.split(":")[0];
}

/** DNS-rebinding guard: an absent Host header passes; a present one must name loopback. */
export function hasLoopbackHostHeader(hostHeader: string | null | undefined): boolean {
	if (!hostHeader) return true;
	return isLoopbackHost(extractHostName(hostHeader));
}
