export function attachedSessionHosts(
	thread: { attachedSessionHosts?: unknown } | null | undefined,
): string[] {
	const hosts = thread?.attachedSessionHosts;
	return Array.isArray(hosts) ? (hosts as string[]) : [];
}

/** "MSI" for one host, "MSI +2" for three. */
export function attachedSessionLabel(hosts: string[]): string {
	if (hosts.length === 0) return "";
	if (hosts.length === 1) return hosts[0];
	return `${hosts[0]} +${hosts.length - 1}`;
}

export function attachedSessionTitle(hosts: string[]): string {
	const plural = hosts.length === 1 ? "session" : "sessions";
	return `Attached ${plural} on ${hosts.join(", ")}`;
}
