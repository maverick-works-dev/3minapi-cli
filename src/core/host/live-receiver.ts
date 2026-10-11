/**
 * Live receiver — takes live channel signals and pulls (docs/design/14_cli_host.md §13-3, §13-6, §13-9).
 * Tasks still arrive by pull; a signal only says "pull now" (no payload). `start` drives it like the poll poller
 * (poller.ts) via receiver.ts.
 *
 * Pull rules (§13-6) — the CLI keeps consistency
 *   - On open, one catch-up pull, then wait for signals. No pulls while disconnected (no fallback polling)
 *   - Keep the minimum interval (server `poll.min_interval_ms`, floor 5 s) — signals within it merge into one pull.
 *     On `poll_too_soon`, pull after Retry-After (signals are not dropped)
 *   - A signal during a pull triggers one more pull after it. On `has_more`, keep pulling without a signal
 *   - With slots full, a signal gets a `max=0` pull (cancellations only) and is deferred → pull as soon as a slot frees
 *   - Failures without `code` retry after `LIVE_RETRY_MS` (no backoff)
 *
 * Topics (§13-3): module topics (workers) → pull; `host` → one immediate `GET /host` (its body code decides a stop,
 * without waiting for the close — a 4001 after the signal arrives about 10 s later); unknown topics → ignored.
 * Work that relied on pulls (§13-9): pending reports also go out on a `LIVE_RETRY_MS` timer. reload runs while idle and
 * does not trigger a pull.
 */
import type { ApiClient, ApiError } from '../api.ts';
import {
	LIVE_RETRY_MS,
	POLL_INTERVAL_MAX_MS,
	POLL_MIN_INTERVAL_MS,
	StopError,
	isTrustedLiveUrl,
	type LiveState,
	type PullResponse,
	type Quota
} from '../domain/index.ts';
import type { Logger } from '../logger.ts';
import { stripControl } from '../text.ts';
import { formatInterval, sleep } from '../time.ts';
import { LiveConnection, type LiveTiming } from './live-connection.ts';
import type { HostModule, ModuleEnded } from './module.ts';
import { endReceive, pullStep, type PullTrigger } from './pull-step.ts';
import type { Receiver } from './receiver.ts';

/**
 * Window in which a 4001 close counts as the same event as the `host` signal's `GET /host` — the server closes with
 * 4001 right after a `host` signal, but the close event arrives when TCP closes, about 10 s later (observed, #1461).
 * Avoids a second check for that 4001
 */
const HOST_CHECK_DEDUPE_MS = 30_000;

export interface LiveReceiverOptions {
	api: ApiClient;
	logger: Logger;
	/** Enabled module, already prepared (workers: sync, docs/design/14_cli_host.md §3-4) */
	module: HostModule;
	/** Quota from the sync response — its reset time is attached on a stop */
	quota?: Quota;
	/** The user stopped it */
	signal: AbortSignal;
	/** URL from the startup sync — already passed `isTrustedLiveUrl` */
	url: string;
	token: string;
	/** Base for checking newly received URLs (docs/design/14_cli_host.md §13-1) */
	apiUrl: string;
	onPull?(res: PullResponse): void;
	onError?(err: ApiError): void;
	onState?(state: LiveState): void;
	/** Got a new URL from `GET /host` — control DB `live_url` */
	onLiveUrl?(url: string): void;
	/** Floor of the minimum interval — tests lower it */
	minIntervalMs?: number;
	/** Interval for failure retries and resending pending reports — tests lower it */
	retryMs?: number;
	timing?: Partial<LiveTiming>;
	now?(): number;
	random?(): number;
}

export class LiveReceiver implements Receiver {
	private readonly opts: LiveReceiverOptions;
	private readonly conn: LiveConnection;
	private readonly now: () => number;
	private readonly minIntervalMs: number;
	private readonly retryMs: number;
	private readonly halted = new AbortController();
	private stopError: StopError | null = null;
	private lastQuota: Quota | null;
	private resyncState: 'idle' | 'pending' | 'running' = 'idle';
	private napWake: AbortController | null = null;
	/** A signal (or the connection) asked for a pull */
	private signalled = false;
	/** Counted to detect signals that arrive during a pull */
	private signalSeq = 0;
	/** The previous response had `has_more` — keep pulling without a signal */
	private more = false;
	/** A pull deferred while slots were full — pull when a slot frees */
	private slotPending = false;
	/**
	 * Causes of the next pull — logged only (`trigger` on `pulled`); the flags above decide whether to pull. Catch-up
	 * and signal share one flag (signalled), so only this tells them apart
	 */
	private triggers = new Set<PullTrigger>();
	/** No pull before this time (minimum interval, Retry-After, failure retry) */
	private notBefore = 0;
	private hostCheck: Promise<void> | null = null;
	/** Workers to turn off while idle (`worker delete`) */
	private drops: string[] = [];
	/** URL used for the current connection — the same URL is not recorded again */
	private url: string;
	private hostCheckedAt = Number.NEGATIVE_INFINITY;

	constructor(opts: LiveReceiverOptions) {
		this.opts = opts;
		this.now = opts.now ?? Date.now;
		this.minIntervalMs = opts.minIntervalMs ?? POLL_MIN_INTERVAL_MS;
		this.retryMs = opts.retryMs ?? LIVE_RETRY_MS;
		this.lastQuota = opts.quota ?? null;
		this.url = opts.url;
		this.conn = new LiveConnection({
			url: opts.url,
			token: opts.token,
			logger: opts.logger,
			onOpen: () => this.pullSoon('catch_up'),
			onSignal: (topic) => this.onSignal(topic),
			onCheckHost: () => this.checkHost('close'),
			onRefreshUrl: () => this.checkHost('refresh'),
			onState: opts.onState,
			timing: opts.timing,
			now: opts.now,
			random: opts.random
		});
		opts.module.onSlotFree(() => {
			if (!this.slotPending) return;
			this.slotPending = false;
			this.more = true;
			this.triggers.add('slot_free');
			this.wake();
		});
	}

	get liveState(): LiveState {
		return this.conn.liveState;
	}

	stop(err: StopError): void {
		this.stopError ??= err;
		this.halted.abort();
		this.conn.close();
		this.wake();
	}

	requestResync(): void {
		if (this.resyncState !== 'idle') return;
		this.resyncState = 'pending';
		this.wake();
	}

	requestDrop(names: string[]): void {
		this.drops.push(...names);
		this.wake();
	}

	get resyncIdle(): boolean {
		return this.resyncState === 'idle';
	}

	/** URL from a `reload` resync or `GET /host`, used from the next reconnect. Checked so the token never goes to another host */
	setUrl(url: string): void {
		if (url === this.url) return;
		if (!isTrustedLiveUrl(url, this.opts.apiUrl)) {
			this.opts.logger.warn('ignored a live url that does not match the API host');
			return;
		}
		this.url = url;
		this.conn.setUrl(url);
		this.opts.onLiveUrl?.(url);
	}

	async run(): Promise<StopError | ModuleEnded | null> {
		const { api, logger, module, signal } = this.opts;
		const sleepSignal = AbortSignal.any([signal, this.halted.signal]);
		// Pending terminal reports — live pulls are rare, so send them separately (docs/design/14_cli_host.md §13-9)
		const flushTimer = setInterval(() => void module.flushPending(), this.retryMs);
		flushTimer.unref();
		let noActive = false;
		this.conn.start();
		try {
			while (!signal.aborted && this.stopError === null) {
				if (this.drops.length > 0) {
					module.dropLocal(this.drops.splice(0));
					if (module.activeCount === 0) {
						noActive = true;
						break;
					}
				}
				if (this.resyncState === 'pending') {
					this.resyncState = 'running';
					try {
						await module.resync();
					} catch (err) {
						if (!(err instanceof StopError)) throw err;
						this.stop(err);
						break;
					} finally {
						this.resyncState = 'idle';
					}
					if (module.activeCount === 0) {
						noActive = true;
						break;
					}
					continue;
				}

				let wait = POLL_INTERVAL_MAX_MS;
				if ((this.signalled || this.more) && this.conn.connected) {
					const left = this.notBefore - this.now();
					if (left > 0) {
						wait = left;
					} else {
						const full = module.pullMax() === 0;
						if (full && !this.signalled) {
							// has_more but no free slot — wait for a slot instead of spending quota on an empty pull
							this.more = false;
							this.slotPending = true;
							// This pull goes out on slot_free, so the leftover causes (has_more, retry) don't apply.
							// signalled is false, so no signal or catch-up cause is pending here
							this.triggers.clear();
							continue;
						}
						const seq = this.signalSeq;
						const was = { signalled: this.signalled, more: this.more };
						const trigger = [...this.triggers];
						this.signalled = false;
						this.more = false;
						// Causes arising during the pull (signals etc.) belong to the next pull — they land after this clear
						this.triggers.clear();
						const out = await pullStep({
							api,
							logger,
							module,
							isStopped: () => this.stopError !== null,
							onPull: this.opts.onPull,
							onError: this.opts.onError,
							retryHint: `in ${formatInterval(this.retryMs)}`,
							quietTooSoon: true,
							trigger
						});
						if (out.kind === 'skipped') break;
						if (out.kind === 'stopped') {
							this.stop(out.err);
							break;
						}
						if (out.kind === 'pulled') {
							this.lastQuota = out.res.quota;
							this.notBefore =
								this.now() +
								Math.min(
									Math.max(this.minIntervalMs, out.res.poll.min_interval_ms),
									POLL_INTERVAL_MAX_MS
								);
							if (out.noActive) {
								noActive = true;
								break;
							}
							// Tasks remain (has_more) or this pulled while full (max=0, deferred pull). Pull again now if a slot
							// is free — a slot freed during the pull already fired its 0 → free notice
							if (full || out.res.has_more) {
								if (module.pullMax() > 0) {
									this.more = true;
									this.triggers.add(full ? 'slot_free' : 'has_more');
								} else this.slotPending = true;
							}
						} else {
							// Keep the signal — wait, then pull again
							this.signalled ||= was.signalled;
							this.more ||= was.more;
							for (const t of trigger) this.triggers.add(t);
							this.triggers.add('retry');
							this.notBefore =
								this.now() +
								(out.kind === 'too_soon'
									? Math.min(out.retryAfterMs, POLL_INTERVAL_MAX_MS)
									: this.retryMs);
						}
						if (this.signalSeq !== seq) this.signalled = true;
						continue;
					}
				}
				this.napWake = new AbortController();
				await sleep(wait, AbortSignal.any([sleepSignal, this.napWake.signal]));
				this.napWake = null;
			}
		} finally {
			clearInterval(flushTimer);
			this.conn.close();
		}
		await this.hostCheck;
		if (this.stopError === null) this.resyncState = 'idle';
		return endReceive(module, this.stopError, this.lastQuota, noActive);
	}

	private onSignal(topic: string): void {
		if (topic === 'host') {
			void this.checkHost('signal');
			return;
		}
		if ((this.opts.module.topics as readonly string[]).includes(topic)) {
			this.pullSoon('signal');
			return;
		}
		// Reserved topics (update, config) also land here (docs/design/14_cli_host.md §13-3)
		this.opts.logger.debug('ignored an unknown live topic', {
			topic: stripControl(topic).slice(0, 32)
		});
	}

	private pullSoon(trigger: 'catch_up' | 'signal'): void {
		this.triggers.add(trigger);
		this.signalled = true;
		this.signalSeq++;
		this.wake();
	}

	private wake(): void {
		this.napWake?.abort();
	}

	/**
	 * One `GET /host` — its body code decides a stop (docs/design/14_cli_host.md §13-3, §13-5). Success costs 1 call, a
	 * stop code 0. The response `live.url` is used from the next reconnect. Joins a check in progress; a 4001 close
	 * right after a **successful** check is the same event and is not re-checked
	 */
	private checkHost(why: 'signal' | 'close' | 'refresh'): Promise<void> {
		if (this.hostCheck) return this.hostCheck;
		if (this.stopError !== null) return Promise.resolve();
		if (why === 'close' && this.now() - this.hostCheckedAt < HOST_CHECK_DEDUPE_MS) {
			return Promise.resolve();
		}
		this.hostCheck = (async () => {
			try {
				const res = await this.opts.api.getHost();
				// Only on success — a 4001 after a network failure must re-check the stop reason
				this.hostCheckedAt = this.now();
				this.lastQuota = res.quota;
				if (res.live) this.setUrl(res.live.url);
				this.opts.logger.info('host checked', { why });
			} catch (err) {
				if (err instanceof StopError) {
					this.stop(err);
					return;
				}
				// Not a stop — the connection keeps reconnecting (next backoff step on 4001)
				this.opts.logger.warn('host check failed', { why, message: (err as Error).message });
			} finally {
				this.hostCheck = null;
			}
		})();
		return this.hostCheck;
	}
}
