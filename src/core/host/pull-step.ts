/**
 * One pull — shared by the poller (poll) and the live receiver (docs/design/14_cli_host.md §3-2, §6, §13-6).
 * The caller decides **when** to pull (interval, signal, retry). This owns only ordering and failure classification.
 *
 * Order: module beforePull (pending reports) → skip if stopped → pull → onPull (host) → module.onPull → end if 0 active
 */
import { ApiError, type ApiClient } from '../api.ts';
import { StopError, type PullResponse, type Quota } from '../domain/index.ts';
import type { Logger } from '../logger.ts';
import type { HostModule, ModuleEnded } from './module.ts';

/**
 * What caused a pull — used only in logs (`trigger` on `pulled`). Signals carry no payload, so per-task cause is
 * matched to `task started` by time. Causes merged into one pull are joined with `+` (e.g. `catch_up+signal`)
 *   interval  poll interval
 *   catch_up  catch-up right after a live (re)connect
 *   signal    live signal (a topic the module subscribes to)
 *   has_more  the previous response had `has_more`
 *   slot_free a pull deferred while slots were full — a slot freed up
 *   retry     the previous pull failed (no `code`, or `poll_too_soon`) — poll and live
 */
export type PullTrigger = 'interval' | 'catch_up' | 'signal' | 'has_more' | 'slot_free' | 'retry';

export interface PullStepOptions {
	api: ApiClient;
	logger: Logger;
	module: HostModule;
	/** Whether the receiver stopped — true once a report during beforePull gets a stop code (TaskRunner onStop) */
	isStopped(): boolean;
	/** Every successful pull */
	onPull?(res: PullResponse): void;
	/** A failure that is not a stop */
	onError?(err: ApiError): void;
	/** "When again" for failure logs — poll: next interval; live: after LIVE_RETRY_MS */
	retryHint: string;
	/** Don't report `poll_too_soon` via onError — normal for live while merging signals */
	quietTooSoon?: boolean;
	/** Cause of this pull — logged only */
	trigger: readonly PullTrigger[];
}

export type PullOutcome =
	/** Success. `noActive` = nothing is active any more (end) */
	| { kind: 'pulled'; res: PullResponse; noActive: boolean }
	/** Stop code — the caller stops */
	| { kind: 'stopped'; err: StopError }
	/** Already stopped during beforePull — did not pull */
	| { kind: 'skipped' }
	/** 429 `poll_too_soon` — retry after Retry-After */
	| { kind: 'too_soon'; retryAfterMs: number }
	/** Failure without `code` and the like — not a stop */
	| { kind: 'failed'; err: ApiError };

export async function pullStep(opts: PullStepOptions): Promise<PullOutcome> {
	const { api, logger, module } = opts;
	try {
		await module.beforePull();
		if (opts.isStopped()) return { kind: 'skipped' };
		const res = await api.pullTasks(module.pullMax());
		logger.debug('pulled', {
			trigger: opts.trigger.join('+'),
			tasks: res.tasks.length,
			cancelled: res.cancelled.length,
			has_more: res.has_more,
			remaining: res.quota.remaining
		});
		opts.onPull?.(res);
		module.onPull(res);
		return { kind: 'pulled', res, noActive: module.activeCount === 0 };
	} catch (err) {
		if (err instanceof StopError) return { kind: 'stopped', err };
		if (!(err instanceof ApiError)) throw err;
		const tooSoon = err.code === 'poll_too_soon' && err.retryAfterMs !== null;
		if (err.code === 'invalid_request') {
			// Not a stop — the CLI sent a request that breaks the contract (a bug)
			logger.error('the server rejected the pull request (a CLI bug)', {
				trigger: opts.trigger.join('+'),
				message: err.message
			});
		} else if (!tooSoon) {
			logger.warn(`pull failed; trying again ${opts.retryHint}`, {
				trigger: opts.trigger.join('+'),
				status: err.status,
				message: err.message
			});
		}
		if (!(tooSoon && opts.quietTooSoon)) opts.onError?.(err);
		return tooSoon
			? { kind: 'too_soon', retryAfterMs: err.retryAfterMs! }
			: { kind: 'failed', err };
	}
}

/**
 * Ends receiving — shared by poller and live receiver. On a stop: halt the module and return StopError with the reset
 * time. Otherwise shutdown, then ModuleEnded if nothing is active, or null for a user stop
 */
export async function endReceive(
	module: HostModule,
	stopError: StopError | null,
	lastQuota: Quota | null,
	noActive: boolean
): Promise<StopError | ModuleEnded | null> {
	if (stopError !== null) {
		await module.halt(stopError.reason);
		// The quota_exhausted body has no reset time — use the last successful response's (docs/design/14_cli_host.md §6-3)
		return new StopError(
			stopError.reason,
			stopError.message,
			stopError.resetAt ?? lastQuota?.reset_at
		);
	}
	await module.shutdown();
	return noActive ? module.ended() : null;
}
