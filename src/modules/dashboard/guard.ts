/**
 * Request checks for the local dashboard (docs/design/15_cli.md §9) — raw results may contain personal data.
 *
 * - Host = 127.0.0.1, localhost, [::1]:<port> only (DNS rebinding). In LAN mode also this PC's LAN IPv4, hostname and
 *   `<hostname>.local` — re-read per request (stays reachable when DHCP changes the address). Foreign domain names are still rejected
 * - Origin, when present, must be our own; Sec-Fetch-Site only none or same-origin (requests sent by other pages)
 * - GET and HEAD only — read-only, so there are no mutating requests
 * - Token: new per run. The browser enters once with `?token=` and it is swapped for an HttpOnly cookie (less time in the address bar and history)
 *
 * Unlike localGuard of `start --serve` — that one blocks every browser request; here the browser is the intended client.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { hostname, networkInterfaces } from 'node:os';

export interface GuardRequest {
	method: string | undefined;
	host: string | undefined;
	origin: string | undefined;
	secFetchSite: string | undefined;
}

export interface Denial {
	status: number;
	message: string;
}

export interface GuardScope {
	/** Also accept other devices on the local network (`dashboard --lan`) */
	lan?: boolean;
	/** Fixed by tests. Otherwise this PC's interfaces and hostname are read */
	lanNames?: () => string[];
}

const LOOPBACK_NAMES = ['127.0.0.1', 'localhost', '[::1]'];

export function allowedHosts(port: number, scope: GuardScope = {}): string[] {
	const names = scope.lan ? [...LOOPBACK_NAMES, ...(scope.lanNames ?? lanNames)()] : LOOPBACK_NAMES;
	return names.map((name) => `${name.toLowerCase()}:${port}`);
}

/**
 * Is this request from another device — remote if Host is not a loopback name or the peer address is not loopback. Not decided by
 * the global `--lan` (in LAN mode the host itself still opens 127.0.0.1 with full features). A LAN address on the same PC counts as
 * remote, an SSH tunnel as local. Unknown address (socket closed) → remote, the safer side. Host already passed checkRequest/allowedHosts
 */
export function isRemoteViewer(
	req: { host: string | undefined; remoteAddress: string | undefined },
	port: number
): boolean {
	if (!allowedHosts(port).includes((req.host ?? '').toLowerCase())) return true;
	return !isLoopbackAddress(req.remoteAddress);
}

function isLoopbackAddress(address: string | undefined): boolean {
	if (!address) return false;
	const v4 = address.toLowerCase().replace(/^::ffff:/, '');
	return v4 === '::1' || /^127\.\d+\.\d+\.\d+$/.test(v4);
}

/**
 * Names other devices use for this PC — non-internal IPv4 addresses, hostname, `<hostname>.local` (mDNS). The bind is `0.0.0.0`,
 * so IPv6 addresses can't connect and are left out
 */
export function lanNames(): string[] {
	const names = new Set<string>();
	for (const addrs of Object.values(networkInterfaces())) {
		for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) names.add(a.address);
	}
	const host = hostname().toLowerCase();
	if (host) {
		names.add(host);
		names.add(host.endsWith('.local') ? host : `${host}.local`);
	}
	return [...names];
}

export function checkRequest(
	req: GuardRequest,
	port: number,
	scope: GuardScope = {}
): Denial | null {
	const host = (req.host ?? '').toLowerCase();
	if (!allowedHosts(port, scope).includes(host)) {
		return {
			status: 403,
			message: scope.lan
				? "Host header must be this PC's address or name"
				: 'Host header must be 127.0.0.1 or localhost'
		};
	}
	if (req.origin !== undefined && req.origin.toLowerCase() !== `http://${host}`) {
		return { status: 403, message: 'requests from other web pages are not accepted' };
	}
	const site = req.secFetchSite;
	if (site !== undefined && site !== 'none' && site !== 'same-origin') {
		return { status: 403, message: 'requests from other web pages are not accepted' };
	}
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		return { status: 405, message: 'the dashboard is read-only — use GET' };
	}
	return null;
}

/** The cookie name includes the port — cookies ignore ports and would mix with another run's cookie */
export function cookieName(port: number): string {
	return `tm_dashboard_${port}`;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(';')) {
		const i = part.indexOf('=');
		if (i !== -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
	}
	return undefined;
}

/** Hashes both sides with SHA-256 before comparing, so differing lengths leak no timing difference */
export function tokenMatches(given: string | undefined | null, token: string): boolean {
	if (!given) return false;
	return timingSafeEqual(sha256(given), sha256(token));
}

function sha256(value: string): Buffer {
	return createHash('sha256').update(value).digest();
}
