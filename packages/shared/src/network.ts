/**
 * Whether an IP address must never be used as an outbound network target.
 * Invalid addresses are blocked too: callers use this as a deny-by-default
 * boundary after DNS resolution.
 */
export function isIpAddress(address: string): boolean {
	return parseIpv4(address) !== null || parseIpv6(address) !== null;
}

export function isBlockedAddress(address: string): boolean {
	const ipv4 = parseIpv4(address);
	if (ipv4) return isBlockedIpv4(ipv4);

	const ipv6 = parseIpv6(address);
	if (!ipv6) return true;

	// ::/128 and ::1/128.
	if (ipv6.every((part) => part === 0)) return true;
	if (ipv6.slice(0, 7).every((part) => part === 0) && ipv6[7] === 1) return true;

	const first = ipv6[0];
	// fe80::/10 link-local, fc00::/7 unique-local, ff00::/8 multicast.
	if ((first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00 || (first & 0xff00) === 0xff00) {
		return true;
	}

	// IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) addresses
	// inherit their embedded IPv4 address's safety classification.
	const hasEmbeddedIpv4 =
		ipv6.slice(0, 5).every((part) => part === 0) && (ipv6[5] === 0 || ipv6[5] === 0xffff);
	if (hasEmbeddedIpv4) {
		return isBlockedIpv4([ipv6[6] >> 8, ipv6[6] & 0xff, ipv6[7] >> 8, ipv6[7] & 0xff]);
	}

	return false;
}

function parseIpv4(address: string): [number, number, number, number] | null {
	const parts = address.split(".");
	if (parts.length !== 4) return null;
	const values = parts.map((part) => {
		if (!/^\d{1,3}$/.test(part)) return null;
		const value = Number(part);
		return value <= 255 ? value : null;
	});
	return values.every((value): value is number => value !== null)
		? (values as [number, number, number, number])
		: null;
}

function isBlockedIpv4([a, b]: [number, number, number, number]): boolean {
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		a >= 224
	);
}

function parseIpv6(address: string): number[] | null {
	if (!address || address.includes("%")) return null;
	const halves = address.split("::");
	if (halves.length > 2) return null;

	const parseHalf = (half: string): number[] | null => {
		if (!half) return [];
		const parts = half.split(":");
		const values: number[] = [];
		for (let index = 0; index < parts.length; index++) {
			const part = parts[index];
			if (part.includes(".")) {
				if (index !== parts.length - 1) return null;
				const ipv4 = parseIpv4(part);
				if (!ipv4) return null;
				values.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
				continue;
			}
			if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
			values.push(Number.parseInt(part, 16));
		}
		return values;
	};

	const left = parseHalf(halves[0]);
	const right = parseHalf(halves[1] ?? "");
	if (!left || !right) return null;
	if (halves.length === 1) return left.length === 8 ? left : null;
	if (left.length + right.length >= 8) return null;
	return [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
}
