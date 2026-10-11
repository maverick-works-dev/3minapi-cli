/**
 * Live channel connection — one per host (docs/design/14_cli_host.md §13-1, §13-2, §13-5).
 * Knows nothing of topic meaning — filters frames into `onSignal(topic)` and keeps the connection alive. Pull and stop
 * decisions belong to the receiver (live-receiver.ts).
 *
 * - Node global `WebSocket` (undici). The token goes only in the `Authorization` header, never the URL. The second
 *   argument's `{ headers }` is an undici extension. No `setGlobalDispatcher` — uses the proxy dispatcher that
 *   `NODE_USE_ENV_PROXY` installs
 * - keepalive: send text `ping`, expect `pong`. Send the constant exactly — the server answers keepalive only on an
 *   exact match. Node WebSocket cannot send protocol pings
 * - ⚠️ undici emits `close` **when TCP closes**, not when the server close frame arrives (observed about 10 s later).
 *   `close()` on a vanished peer never emits it. So pong timeout and connect timeout abandon the socket without waiting
 *   (a generation number ignores late events) — this also keeps a late 4000 from an old socket from causing a 5-minute wait
 * - Close codes are not stop signals. 4000 = wait the backoff cap; 4001 = `onCheckHost` (the receiver decides via
 *   `GET /host`); anything else (incl. 1006) = jittered reconnect
 * - Failures before open (non-101 response, DNS, refused, TLS, proxy) are indistinguishable — undici hides the status.
 *   No `GET /host` for them. After 30 min of such failures on a once-connected host, refetch the URL (`onRefreshUrl`,
 *   at most once per 30 min)
 * - Reconnect: first uniform 0–30 s, then full jitter `random(0, min(cap, 30 s·2^n))`. Reset only when a connection
 *   that lasted over 60 s drops (not on 4001). Unlimited attempts
 */
import {
	LIVE_CLOSE,
	LIVE_CONNECT_TIMEOUT_MS,
	LIVE_PING,
	LIVE_PING_INTERVAL_MS,
	LIVE_PONG,
	LIVE_PONG_TIMEOUT_MS,
	LIVE_RECONNECT_FIRST_JITTER_MS,
	LIVE_RECONNECT_MAX_MS,
	LIVE_RECONNECT_STABLE_MS,
	LIVE_URL_REFRESH_AFTER_MS,
	type LiveState
} from '../domain/index.ts';
import type { Logger } from '../logger.ts';
import { stripControl } from '../text.ts';

export interface LiveTiming {
	pingIntervalMs: number;
	pongTimeoutMs: number;
	connectTimeoutMs: number;
	/** Upper bound of the first reconnect's uniform jitter, and the backoff base */
	firstJitterMs: number;
	maxBackoffMs: number;
	stableMs: number;
	refreshAfterMs: number;
}

export const LIVE_TIMING: LiveTiming = {
	pingIntervalMs: LIVE_PING_INTERVAL_MS,
	pongTimeoutMs: LIVE_PONG_TIMEOUT_MS,
	connectTimeoutMs: LIVE_CONNECT_TIMEOUT_MS,
	firstJitterMs: LIVE_RECONNECT_FIRST_JITTER_MS,
	maxBackoffMs: LIVE_RECONNECT_MAX_MS,
	stableMs: LIVE_RECONNECT_STABLE_MS,
	refreshAfterMs: LIVE_URL_REFRESH_AFTER_MS
};

export interface LiveConnectionOptions {
	/** Only URLs that passed `isTrustedLiveUrl` — the caller checks */
	url: string;
	token: string;
	logger: Logger;
	/** Connected — the receiver does a catch-up pull */
	onOpen(): void;
	onSignal(topic: string): void;
	/** 4001 — the receiver decides a stop via `GET /host`. Then reconnects at the next backoff step */
	onCheckHost(): Promise<void>;
	/** Pre-open failures persisted — the receiver refetches the URL via `GET /host` */
	onRefreshUrl(): Promise<void>;
	/** State changed (control DB `live_state`) */
	onState?(state: LiveState): void;
	now?(): number;
	random?(): number;
	timing?: Partial<LiveTiming>;
}

/**
 * undici's extended constructor for global `WebSocket` — sends the second argument's `headers` on the upgrade request.
 * lib.dom types only have the standard (protocols) shape, so it is widened here. The header test in
 * test/live-connection.test.ts catches Node changes
 */
const WebSocketWithHeaders = WebSocket as unknown as new (
	url: string,
	init: { headers: Record<string, string> }
) => WebSocket;

/** Why the connection was lost — decides the reconnect wait */
type LostKind = 'replaced' | 'check_host' | 'dropped' | 'no_pong' | 'not_opened';

export class LiveConnection {
	private readonly opts: LiveConnectionOptions;
	private readonly timing: LiveTiming;
	private readonly now: () => number;
	private readonly random: () => number;
	private url: string;
	private ws: WebSocket | null = null;
	/** Socket generation — ignores late events from abandoned sockets */
	private gen = 0;
	private closed = false;
	private attempt = 0;
	private attempts = 0;
	private openedAt: number | null = null;
	/** When pre-open failures started, after having connected once */
	private failingSince: number | null = null;
	private lastRefreshAt = Number.NEGATIVE_INFINITY;
	private pingTimer: NodeJS.Timeout | null = null;
	private pongTimer: NodeJS.Timeout | null = null;
	private connectTimer: NodeJS.Timeout | null = null;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private state: LiveState = {
		connected: false,
		since: null,
		reconnects: 0,
		everConnected: false,
		lastError: null
	};

	constructor(opts: LiveConnectionOptions) {
		this.opts = opts;
		this.timing = { ...LIVE_TIMING, ...opts.timing };
		this.now = opts.now ?? Date.now;
		this.random = opts.random ?? Math.random;
		this.url = opts.url;
	}

	get connected(): boolean {
		return this.state.connected;
	}

	get liveState(): LiveState {
		return { ...this.state };
	}

	/** Connects immediately the first time */
	start(): void {
		this.connect();
	}

	/** URL for the next connection — pass only URLs that passed `isTrustedLiveUrl` */
	setUrl(url: string): void {
		if (url === this.url) return;
		this.url = url;
		this.opts.logger.info('live url updated');
	}

	/** Shuts down — clears all timers and abandons the socket. Does not reconnect */
	close(): void {
		this.closed = true;
		this.gen++;
		this.clearTimers();
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
		this.abandon(1000);
	}

	private connect(): void {
		if (this.closed) return;
		const gen = ++this.gen;
		if (this.attempts++ > 0) this.setState({ reconnects: this.state.reconnects + 1 });
		let ws: WebSocket;
		try {
			ws = new WebSocketWithHeaders(this.url, {
				headers: { authorization: `Bearer ${this.opts.token}` }
			});
		} catch (err) {
			this.opts.logger.warn('cannot open the live connection', { message: (err as Error).message });
			void this.lost('not_opened', 'invalid live url');
			return;
		}
		ws.binaryType = 'arraybuffer';
		this.ws = ws;
		let opened = false;
		this.connectTimer = setTimeout(() => {
			if (gen !== this.gen || opened) return;
			this.abandon();
			void this.lost('not_opened', 'timed out');
		}, this.timing.connectTimeoutMs);

		ws.addEventListener('open', () => {
			if (gen !== this.gen) return;
			opened = true;
			this.clearTimer('connectTimer');
			this.openedAt = this.now();
			this.failingSince = null;
			this.setState({
				connected: true,
				since: new Date(this.openedAt).toISOString(),
				everConnected: true,
				lastError: null
			});
			this.opts.logger.info('live connected');
			this.pingTimer = setInterval(() => this.ping(gen), this.timing.pingIntervalMs);
			this.pingTimer.unref();
			this.opts.onOpen();
		});
		ws.addEventListener('message', (ev) => {
			if (gen === this.gen) this.onMessage(ev.data);
		});
		ws.addEventListener('error', () => {
			// undici hides the cause — handled by the following close
			if (gen === this.gen) this.opts.logger.debug('live socket error');
		});
		ws.addEventListener('close', (ev) => {
			if (gen !== this.gen) return;
			this.ws = null;
			if (!opened) return void this.lost('not_opened', null);
			const reason = stripControl(String(ev.reason ?? '')).slice(0, 123);
			this.opts.logger.info('live disconnected', { code: ev.code, reason });
			if (ev.code === LIVE_CLOSE.REPLACED) return void this.lost('replaced', null);
			if (ev.code === LIVE_CLOSE.CHECK_HOST) return void this.lost('check_host', null);
			void this.lost('dropped', `closed (${ev.code})`);
		});
	}

	private ping(gen: number): void {
		if (gen !== this.gen || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
		this.ws.send(LIVE_PING);
		if (this.pongTimer) return;
		this.pongTimer = setTimeout(() => {
			if (gen !== this.gen) return;
			this.opts.logger.warn('no pong from the live connection; reconnecting');
			this.abandon();
			void this.lost('no_pong', null);
		}, this.timing.pongTimeoutMs);
		this.pongTimer.unref();
	}

	/** Server → CLI frame (docs/design/14_cli_host.md §13-2). Only JSON `{topic}` is a signal; binary, non-JSON and unknown shapes are ignored */
	private onMessage(data: unknown): void {
		if (typeof data !== 'string') {
			this.opts.logger.debug('ignored a non-text live frame');
			return;
		}
		if (data === LIVE_PONG) {
			this.clearTimer('pongTimer');
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			this.opts.logger.debug('ignored a live frame that is not JSON');
			return;
		}
		const topic = (parsed as { topic?: unknown } | null)?.topic;
		if (typeof parsed !== 'object' || Array.isArray(parsed) || typeof topic !== 'string') {
			this.opts.logger.debug('ignored a live frame without a topic');
			return;
		}
		this.opts.logger.debug('live signal', { topic: stripControl(topic).slice(0, 32) });
		this.opts.onSignal(topic);
	}

	/** Lost — waits according to the cause, then reconnects */
	private async lost(kind: LostKind, detail: string | null): Promise<void> {
		this.clearTimers();
		const now = this.now();
		const upFor = this.openedAt === null ? 0 : now - this.openedAt;
		this.openedAt = null;
		this.setState({
			connected: false,
			// Set the disconnect time once, when the connection drops — later reconnect failures must not reset the elapsed time
			since:
				this.state.connected || this.state.since === null
					? new Date(now).toISOString()
					: this.state.since,
			lastError: describe(kind, detail)
		});
		if (this.closed) return;
		// Reset only after a long-lived connection, so flapping connections don't restart at the first jitter each time.
		// Not on 4001 (docs/design/14_cli_host.md §13-5)
		if (upFor >= this.timing.stableMs && kind !== 'check_host') this.attempt = 0;

		if (kind === 'not_opened' && this.state.everConnected) {
			this.failingSince ??= now;
			if (
				now - this.failingSince >= this.timing.refreshAfterMs &&
				now - this.lastRefreshAt >= this.timing.refreshAfterMs
			) {
				this.lastRefreshAt = now;
				await this.call(() => this.opts.onRefreshUrl());
			}
		}
		if (kind === 'check_host') await this.call(() => this.opts.onCheckHost());
		if (this.closed) return;

		const delay =
			kind === 'replaced'
				? this.timing.maxBackoffMs
				: this.random() *
					Math.min(this.timing.maxBackoffMs, this.timing.firstJitterMs * 2 ** this.attempt);
		this.attempt++;
		this.opts.logger.info('live reconnecting', { in_ms: Math.round(delay), kind });
		// Not unref'd — while disconnected this may be the only timer, and the process would silently exit
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, delay);
	}

	/** Keeps a callback failure from stopping reconnects */
	private async call(fn: () => Promise<void>): Promise<void> {
		try {
			await fn();
		} catch (err) {
			this.opts.logger.warn('live callback failed', { message: (err as Error).message });
		}
	}

	/** Abandons the current socket without waiting for close (see ⚠️ above). Bumps the generation to ignore late events */
	private abandon(code?: number): void {
		const ws = this.ws;
		this.ws = null;
		this.gen++;
		if (!ws) return;
		try {
			ws.close(code);
		} catch {
			// already closed
		}
	}

	private clearTimers(): void {
		this.clearTimer('pingTimer');
		this.clearTimer('pongTimer');
		this.clearTimer('connectTimer');
	}

	private clearTimer(name: 'pingTimer' | 'pongTimer' | 'connectTimer'): void {
		const t = this[name];
		if (!t) return;
		clearTimeout(t);
		this[name] = null;
	}

	private setState(patch: Partial<LiveState>): void {
		const next = { ...this.state, ...patch };
		if (JSON.stringify(next) === JSON.stringify(this.state)) return;
		this.state = next;
		this.opts.onState?.({ ...next });
	}
}

/** Reason shown in `status` and logs */
function describe(kind: LostKind, detail: string | null): string {
	switch (kind) {
		case 'replaced':
			return 'replaced by a newer connection for this host (another 3minapi start?)';
		case 'check_host':
			return 'closed by the server to check this host';
		case 'no_pong':
			return 'no reply to keepalive (connection lost or buffered by a proxy)';
		case 'not_opened':
			return detail === 'timed out'
				? 'could not connect: timed out'
				: 'could not connect (network, proxy, firewall or server — the cause is not visible)';
		case 'dropped':
			return `connection lost: ${detail ?? 'closed'}`;
	}
}
