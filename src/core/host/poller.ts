/**
 * Poller — per-host pull (docs/design/14_cli_host.md §3-2, §6). Host runtime side (docs/design/15_cli.md §8): owns
 * pull, interval and stop handling, and hands responses to the module (module.ts). The only module is workers.
 *
 * - Interval = max(config pollIntervalMs, server poll.min_interval_ms). Waits even on `has_more`. No backoff
 * - 429 `poll_too_soon` waits for Retry-After (not a stop)
 * - A stop code from anywhere (pull or result report) ends the loop at once and aborts running tasks without
 *   reporting. No auto resume — run `start` again
 * - 401/403/429/5xx without `code` and network errors are not stops — retried on the next interval
 * - Ends when the module's active count hits 0, so empty polls don't burn quota (docs/design/14_cli_host.md §10).
 *   A normal end, not a stop. The workers module turns off workers missing from each pull's `workers` list
 * - Resync (`reload`) runs **only while waiting between pulls**. The loop is sequential so it never overlaps a pull;
 *   afterward it sleeps until the originally scheduled pull, since pulling early hits 429 poll_too_soon.
 *   Running tasks (Executor threads) don't read the worker list, so they keep going
 */
import type { ApiClient, ApiError } from '../api.ts';
import { POLL_INTERVAL_MAX_MS, StopError, type PullResponse, type Quota } from '../domain/index.ts';
import type { Logger } from '../logger.ts';
import { sleep } from '../time.ts';
import type { HostModule, ModuleEnded } from './module.ts';
import { endReceive, pullStep, type PullTrigger } from './pull-step.ts';
import type { Receiver } from './receiver.ts';

export interface PollerOptions {
	api: ApiClient;
	logger: Logger;
	intervalMs: number;
	/** Enabled module, already prepared (workers: sync, docs/design/14_cli_host.md §3-4) */
	module: HostModule;
	/** Quota from the sync response — if the first pull is quota_exhausted, its reset time is attached */
	quota?: Quota;
	/** The user stopped it (Ctrl+C or stop file) */
	signal: AbortSignal;
	/** Every successful pull */
	onPull?(res: PullResponse): void;
	/** A failure that is not a stop */
	onError?(err: ApiError): void;
}

/** Why poll pulled — the interval, or a retry after a failed pull (failures wait an interval; `poll_too_soon` waits Retry-After) */
const INTERVAL_TRIGGER: readonly PullTrigger[] = ['interval'];
const RETRY_TRIGGER: readonly PullTrigger[] = ['retry'];

export class Poller implements Receiver {
	private readonly opts: PollerOptions;
	private stopError: StopError | null = null;
	private readonly wake = new AbortController();
	private lastQuota: Quota | null = null;
	private resyncState: 'idle' | 'pending' | 'running' = 'idle';
	/** New for each wait — a resync request wakes the sleep. `wake` is for stops only and is single-use */
	private napWake: AbortController | null = null;
	/** Workers to turn off during the wait (`worker delete`) */
	private drops: string[] = [];

	constructor(opts: PollerOptions) {
		this.opts = opts;
		this.lastQuota = opts.quota ?? null;
	}

	/** Called when a module receives a stop code (workers: while reporting a result — TaskRunner) */
	stop(err: StopError): void {
		this.stopError ??= err;
		this.wake.abort();
	}

	/** Requests a resync. Runs in the next wait (at once if sleeping) */
	requestResync(): void {
		if (this.resyncState !== 'idle') return;
		this.resyncState = 'pending';
		this.napWake?.abort();
	}

	requestDrop(names: string[]): void {
		this.drops.push(...names);
		this.napWake?.abort();
	}

	/**
	 * Can accept a new request — no resync pending or running. Merging a request into a running resync would miss
	 * files created after it started reading, so callers consume the request file only when idle
	 */
	get resyncIdle(): boolean {
		return this.resyncState === 'idle';
	}

	/** The stop error (with resetAt) if stopped, ModuleEnded if no workers stayed active, null if the user stopped it */
	async run(): Promise<StopError | ModuleEnded | null> {
		const { api, logger, signal, module } = this.opts;
		const sleepSignal = AbortSignal.any([signal, this.wake.signal]);
		let noActive = false;
		// For logs only — the previous pull failed (same meaning as live's retry). Does not affect pull timing
		let retrying = false;

		while (!signal.aborted && this.stopError === null) {
			let wait = this.opts.intervalMs;
			const out = await pullStep({
				api,
				logger,
				module,
				isStopped: () => this.stopError !== null,
				onPull: this.opts.onPull,
				onError: this.opts.onError,
				retryHint: 'at the next interval',
				trigger: retrying ? RETRY_TRIGGER : INTERVAL_TRIGGER
			});
			retrying = out.kind === 'too_soon' || out.kind === 'failed';
			if (out.kind === 'skipped') break;
			if (out.kind === 'stopped') {
				this.stop(out.err);
				break;
			}
			if (out.kind === 'pulled') {
				this.lastQuota = out.res.quota;
				// Cap the server interval too — past 2^31 ms a Node timer fires after 1 ms and empty polls run away (#1410)
				wait = Math.min(
					Math.max(this.opts.intervalMs, out.res.poll.min_interval_ms),
					POLL_INTERVAL_MAX_MS
				);
				if (out.noActive) {
					noActive = true;
					break;
				}
			} else if (out.kind === 'too_soon') {
				wait = Math.min(out.retryAfterMs, POLL_INTERVAL_MAX_MS);
			}
			if (await this.nap(wait, sleepSignal)) {
				noActive = true;
				break;
			}
		}

		if (this.stopError === null) this.resyncState = 'idle';
		return endReceive(module, this.stopError, this.lastQuota, noActive);
	}

	/**
	 * Sleeps until the next pull. A resync request wakes it to resync, then it sleeps **until the original time**.
	 * Returns true when nothing is active after a resync or drop (ends like 0 active at start)
	 */
	private async nap(wait: number, sleepSignal: AbortSignal): Promise<boolean> {
		const until = Date.now() + wait;
		while (!this.opts.signal.aborted && this.stopError === null) {
			if (this.drops.length > 0) {
				this.opts.module.dropLocal(this.drops.splice(0));
				if (this.opts.module.activeCount === 0) return true;
			}
			if (this.resyncState === 'pending') {
				this.resyncState = 'running';
				try {
					await this.opts.module.resync();
				} catch (err) {
					if (!(err instanceof StopError)) throw err;
					this.stop(err);
					return false;
				} finally {
					this.resyncState = 'idle';
				}
				if (this.opts.module.activeCount === 0) return true;
			}
			const left = until - Date.now();
			if (left <= 0) return false;
			this.napWake = new AbortController();
			await sleep(left, AbortSignal.any([sleepSignal, this.napWake.signal]));
			this.napWake = null;
		}
		return false;
	}
}
