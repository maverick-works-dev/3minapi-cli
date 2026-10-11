/**
 * workers module sync — initial sync and `reload` resync (docs/design/14_cli_host.md §3-4, §10).
 */
import { ApiError, type ApiClient } from '../../core/api.ts';
import {
	BIN,
	CliError,
	StopError,
	SYNC_WORKERS_MAX,
	WORKER_KEY_ENV,
	WORKER_SECRET_ENV,
	isReservedWorkerName,
	type CommandContext,
	type HostLive,
	type Quota,
	type ReceiveMode,
	type SyncRejected,
	type SyncWorkersRequest,
	type SyncWorkersResponse
} from '../../core/domain/index.ts';
import type { RunnerLock } from '../../core/host/runner-lock.ts';
import {
	rememberQuota,
	clearRunnerRecords,
	recordEnd,
	recordStop,
	stopHint,
	type Session
} from '../../core/host/session.ts';
import { formatCount } from '../../core/text.ts';
import { describeAt, formatInterval, formatLocal, sleep } from '../../core/time.ts';
import type { ReloadResult } from './reload-result.ts';
import { publicKeyEnv, workerEnv } from './runtime/env.ts';
import { WorkerSet, type SyncContext } from './worker-set.ts';
import { collectWorkers, type LocalWorker } from './workers.ts';

export interface SyncOptions {
	root: string;
	workersDir: string;
	/** `--serve --public` — accept push-served workers */
	isPublic: boolean;
	/** Retry interval when the initial sync fails without a `code` — poll uses the configured interval, live `LIVE_RETRY_MS` (docs/design/14_cli_host.md §13-9) */
	intervalMs: number;
	signal: AbortSignal;
	/** This host's built-in read worker — null means this run doesn't register it (host id unknown or no data.db) */
	builtin: BuiltinSpec | null;
	/** Host facts sent with every sync — settings apply only on restart, so fixed once at start (docs/design/14_cli_host.md §10) */
	facts: HostFacts;
	/**
	 * Live channel URL from a `reload` resync response (docs/design/14_cli_host.md §13-5) — used from the next reconnect.
	 * The initial sync's URL comes back as the return value. Not called when absent (the mode never changes mid-run;
	 * the next reconnect keeps the existing URL)
	 */
	onLive?(live: HostLive): void;
}

export interface HostFacts {
	/** Receive mode — **always** sent on every sync. If omitted the server stores none, and `poll` clears the connection facts (docs/design/14_cli_host.md §3-4) */
	receiveMode: ReceiveMode;
	/** Not sent for live (`null`) — the configured interval is meaningless there */
	pollIntervalMs: number;
	concurrency: number;
	cliVersion: string;
	platform: string;
}

export interface BuiltinSpec {
	name: string;
	description: string;
}

/**
 * Collects worker files and syncs them to the server (docs/design/14_cli_host.md §3-4, 1 call) — once before polling.
 * Resync during a run is resyncWorkers.
 * - Stop codes are thrown as is (polling never starts)
 * - Failures without a code (network, 5xx, edge) are not stops (docs/design/14_cli_host.md §6-3) — retried at the
 *   configured interval until success; no polling meanwhile
 * - Workers that fail to load are left out of the request so their description isn't overwritten with null. If an
 *   earlier run registered them they stay active; whether they exist is known only from the first pull's list (worker-set.ts)
 * - The server rejects the whole request with 400 for names differing only by case (§3-4) — the rule-breaking one is dropped before sending
 * - 400 `invalid_request` would repeat on resend — no retry, exit 1
 * - With 0 active workers, logs the reason and ends (exit 1). No polling calls
 *
 * null if the user stops. The quota is returned so the poller can report the reset time on the first pull's quota_exhausted
 */
export async function syncWorkers(
	ctx: CommandContext,
	session: Session,
	api: ApiClient,
	opts: SyncOptions
): Promise<{ workers: WorkerSet; quota: Quota; live: HostLive | null } | null> {
	const { out } = ctx;
	const collected = await collectForSync(ctx, opts);

	let res: SyncWorkersResponse | undefined;
	while (!opts.signal.aborted) {
		try {
			res = await api.syncWorkers(syncBody(collected, builtinFor(collected, opts), opts.facts));
			break;
		} catch (err) {
			if (err instanceof StopError) {
				recordStop(session, err, ctx.now());
				throw new StopError(err.reason, `${err.message}\n${stopHint(err.reason)}`, err.resetAt);
			}
			if (!(err instanceof ApiError)) throw err;
			if (err.code === 'invalid_request') {
				// The same request will be rejected again — retrying would leave the run stuck with neither polling nor exit
				session.logger.error('the server rejected the worker sync request (a CLI bug)', {
					message: err.message
				});
				throw new CliError(
					`the server rejected the list of workers: ${err.message}\n` +
						"This is likely a bug in 3minapi. Please report it with the output of '3minapi worker list'."
				);
			} else {
				session.logger.warn('worker sync failed; trying again at the next interval', {
					status: err.status,
					message: err.message
				});
			}
			out.warn(
				`could not register the workers: ${err.message}\nTrying again in ${formatInterval(opts.intervalMs)}.`
			);
		}
		await sleep(opts.intervalMs, opts.signal);
	}
	if (!res) return null;
	clearRunnerRecords(session);

	const workers = new WorkerSet(localNames(collected), builtinFor(collected, opts)?.name ?? null);
	const rejected = workers.applySync(
		res,
		syncContext(ctx, opts),
		collected.unsent.map((w) => w.name)
	);
	announceSync(ctx, session, res, workers, rejected, collected, 'workers synced');

	if (workers.activeCount === 0) {
		recordEnd(session, 'no_active_workers', [], ctx.now());
		throw new CliError(
			collected.local.length === 0
				? `no workers in ${opts.workersDir}. Create one with '${BIN} worker new <name>', then run start again.`
				: `none of the workers in ${opts.workersDir} could be registered (see above). Fix them and run start again.`
		);
	}
	return { workers, quota: res.quota, live: res.live ?? null };
}

/**
 * `reload` (#1393) — re-reads and syncs worker files during a run (1 call), with the same collection, request,
 * decisions and warnings as the initial sync. Differences: one attempt (polling continues), the previous list is
 * kept on failure, only stop codes are thrown (full stop). Progress and result go to the result file `reload` prints
 */
export async function resyncWorkers(
	ctx: CommandContext,
	session: Session,
	api: ApiClient,
	opts: SyncOptions,
	workers: WorkerSet,
	lock: RunnerLock
): Promise<void> {
	const { out } = ctx;
	// Every file and request made before this time is included in this resync — the requester uses it to recognize its result
	const startedAt = Date.now();
	lock.writeReload({ state: 'running', startedAt });
	out.info(`${out.err.dim(formatLocal(ctx.now()))}  reloading worker files (3minapi reload)...`);
	let result: ReloadResult;
	try {
		const collected = await collectForSync(ctx, opts);
		const res = await api.syncWorkers(syncBody(collected, builtinFor(collected, opts), opts.facts));
		const rejected = workers.resync(
			localNames(collected),
			res,
			syncContext(ctx, opts),
			collected.unsent.map((w) => w.name),
			builtinFor(collected, opts)?.name ?? null
		);
		announceSync(ctx, session, res, workers, rejected, collected, 'workers resynced');
		if (res.live) opts.onLive?.(res.live);
		const names = (r: string) => res.workers.filter((w) => w.result === r).map((w) => w.name);
		result = {
			ok: true,
			created: names('created'),
			updated: names('updated'),
			unchanged: names('unchanged'),
			rejected: [
				...rejected.map((r) => ({ name: r.name, code: r.code, error: r.error })),
				...collected.caseClashes.map(({ worker, others }) => ({
					name: worker.name,
					code: 'name_case_conflict',
					error: `differs from ${others.join(', ')} only by letter case`
				})),
				...collected.reserved.map((w) => ({
					name: w.name,
					code: 'invalid_worker_name',
					error: RESERVED_FILE_MESSAGE
				}))
			],
			notLoaded: collected.unsent.map((w) => ({
				name: w.name,
				message: w.message ?? 'could not load'
			})),
			active: workers.activeNames(),
			quota: res.quota
		};
	} catch (err) {
		if (err instanceof StopError) {
			lock.writeReload({
				state: 'done',
				startedAt,
				finishedAt: Date.now(),
				result: { ok: false, error: err.message, stopped: err.reason }
			});
			throw err;
		}
		// Failures other than stop codes (network, 5xx, over 200 workers, folder error) don't stop the run — it continues with the previous list
		const message = err instanceof Error ? err.message : String(err);
		session.logger.warn('worker reload failed; keeping the current workers', { message });
		out.warn(`reload failed: ${message} — keeping the current workers.`);
		result = { ok: false, error: message };
	}
	lock.writeReload({ state: 'done', startedAt, finishedAt: Date.now(), result });
}

interface Collected {
	local: LocalWorker[];
	sent: LocalWorker[];
	unsent: LocalWorker[];
	caseClashes: { worker: LocalWorker; others: string[] }[];
	/** Files starting with `_` — names reserved for built-in workers, not sent (colliding with a built-in name makes the whole request 400) */
	reserved: LocalWorker[];
}

const RESERVED_FILE_MESSAGE = 'names starting with "_" are reserved for built-in workers';

/** Collects worker files and splits them into send and skip — shared by start and reload */
async function collectForSync(ctx: CommandContext, opts: SyncOptions): Promise<Collected> {
	const local = await collectWorkers(opts.workersDir, workerEnv(opts.root, ctx.env));
	if (local.length > SYNC_WORKERS_MAX) {
		throw new CliError(
			`${opts.workersDir} has ${local.length} workers — at most ${SYNC_WORKERS_MAX} can be registered from one host.`
		);
	}
	// Names breaking the rules are sent — the server rejects them with invalid_worker_name and a reason (docs/design/14_cli_host.md §6-4)
	const reserved = local.filter((w) => isReservedWorkerName(w.name));
	const { sent, caseClashes } = withoutCaseClashes(
		local.filter(
			(w) => (w.problem === null || w.problem === 'invalid_name') && !isReservedWorkerName(w.name)
		)
	);
	const unsent = local.filter((w) => w.problem === 'load_failed' || w.problem === 'duplicate');
	if (opts.builtin && sent.length >= SYNC_WORKERS_MAX) {
		ctx.out.warn(
			`${opts.workersDir} has ${sent.length} workers to register — the most one host can register — so the built-in results reader ` +
				'is left out this run; remote AIs cannot read saved results.'
		);
	}
	return { local, sent, unsent, caseClashes, reserved };
}

/**
 * WorkerSet's local names — `_` files excluded; they are neither synced nor run. Including one would put a file
 * named like the built-in worker into the active count (exit decision), so start would never end after all file workers go off
 */
function localNames(collected: Collected): string[] {
	return collected.local.filter((w) => !isReservedWorkerName(w.name)).map((w) => w.name);
}

/**
 * The built-in worker is registered only when there are file workers to send — without them start ends anyway
 * (0 active), leaving only an unreceived built-in on the server. Left out if file workers fill the request limit (collectForSync reports it)
 */
function builtinFor(collected: Collected, opts: SyncOptions): BuiltinSpec | null {
	// File workers come first under the request limit (SYNC_WORKERS_MAX) — when full, drop the built-in so the whole request isn't 400
	return collected.sent.length > 0 && collected.sent.length < SYNC_WORKERS_MAX
		? opts.builtin
		: null;
}

function syncBody(
	collected: Collected,
	builtin: BuiltinSpec | null,
	facts: HostFacts
): SyncWorkersRequest {
	const workers = collected.sent.map((w) => ({
		name: w.name,
		description: w.meta?.description ?? null
	}));
	if (builtin) workers.push({ name: builtin.name, description: builtin.description });
	return {
		workers,
		receive_mode: facts.receiveMode,
		poll_interval_ms: facts.receiveMode === 'live' ? null : facts.pollIntervalMs,
		concurrency: facts.concurrency,
		cli_version: facts.cliVersion,
		platform: facts.platform
	};
}

/** Push-serving check — public keys are re-read on every sync */
function syncContext(ctx: CommandContext, opts: SyncOptions): SyncContext {
	const publicKeys = opts.isPublic ? publicKeyEnv(opts.root, ctx.env) : {};
	return {
		public: opts.isPublic,
		hasPushKeys: (name) =>
			Boolean(publicKeys[WORKER_SECRET_ENV(name)] && publicKeys[WORKER_KEY_ENV(name)])
	};
}

/** Writes the sync result to log and terminal — rejections, collisions, load failures, push serving, active list */
function announceSync(
	ctx: CommandContext,
	session: Session,
	res: SyncWorkersResponse,
	workers: WorkerSet,
	rejected: SyncRejected[],
	collected: Collected,
	event: 'workers synced' | 'workers resynced'
): void {
	const { out } = ctx;
	rememberQuota(session, res.quota, ctx.now());
	session.logger.info(event, {
		workers: res.workers,
		rejected: rejected.map((r) => ({ name: r.name, code: r.code })),
		push_served: workers.pushServedNames(),
		not_sent: collected.local.filter((w) => !collected.sent.includes(w)).map((w) => w.name),
		// Export values at sync time, so the local dashboard can show workers without importing their files
		local: collected.local.map((w) => ({
			name: w.name,
			description: w.meta?.description ?? null,
			timeout_ms: w.meta?.timeoutMs ?? null,
			input_schema: w.meta?.hasInputSchema ?? false,
			problem: w.problem,
			message: w.message
		}))
	});
	for (const r of rejected) {
		if (r.name === workers.builtin) {
			// No file for the user to fix — only state that the remote AI can't read stored results
			out.warn(
				`the built-in results reader ${r.name} was not registered: ${r.error} Remote AIs cannot read saved results this run.`
			);
			continue;
		}
		out.warn(`${r.error} ${r.name} is off for this run — fix it and run '${BIN} reload'.`);
	}
	for (const w of collected.reserved) {
		out.warn(
			`${w.name}: ${RESERVED_FILE_MESSAGE}, so it is not registered — rename the file and run '${BIN} reload'.`
		);
	}
	for (const { worker, others } of collected.caseClashes) {
		out.warn(
			`${worker.name}: differs from ${others.join(', ')} only by letter case. Worker names ignore case, ` +
				`so it is not registered — rename the file and run '${BIN} reload'.`
		);
	}
	for (const w of collected.unsent) {
		// Whether it exists on the server is known at the next pull — if not, the poller reports it again
		out.warn(
			`${w.name}: ${w.message}. It was left out of the registration; if an earlier run registered it, ` +
				'its tasks fail until the file loads.'
		);
	}
	const served = workers.pushServedNames();
	if (served.length > 0) {
		out.info(`public   ${served.join(', ')} — served as public workers on this machine (--public)`);
	}
	out.info(workersLine(ctx, res, workers));
}

/**
 * Filters names differing only by case — the server rejects the whole request with 400 for case-insensitive
 * duplicates (docs/design/14_cli_host.md §3-4). Keeps the rule-conforming (lowercase) name and drops the other; drops both if both break the rules
 */
function withoutCaseClashes(workers: LocalWorker[]): {
	sent: LocalWorker[];
	caseClashes: { worker: LocalWorker; others: string[] }[];
} {
	const byKey = new Map<string, LocalWorker[]>();
	for (const w of workers) {
		const key = w.name.toLowerCase();
		byKey.set(key, [...(byKey.get(key) ?? []), w]);
	}
	const sent: LocalWorker[] = [];
	const caseClashes: { worker: LocalWorker; others: string[] }[] = [];
	for (const group of byKey.values()) {
		if (group.length === 1) {
			sent.push(group[0]);
			continue;
		}
		for (const w of group) {
			if (w.problem === null) sent.push(w);
			else
				caseClashes.push({
					worker: w,
					others: group.filter((o) => o !== w).map((o) => o.name)
				});
		}
	}
	return { sent, caseClashes };
}

function workersLine(ctx: CommandContext, res: SyncWorkersResponse, workers: WorkerSet): string {
	const active = workers.activeNames();
	const count = (result: string) => res.workers.filter((w) => w.result === result).length;
	const changes = [
		count('created') > 0 ? `${count('created')} new` : null,
		count('updated') > 0 ? `${count('updated')} updated` : null
	].filter(Boolean);
	const { remaining, limit, reset_at } = res.quota;
	return [
		`workers  ${active.length} active (${active.join(', ') || 'none'})` +
			(changes.length > 0 ? ctx.out.err.dim(` · registered: ${changes.join(', ')}`) : ''),
		...(workers.builtinActive
			? [`reader   ${workers.builtin} — remote AIs can query the saved results through it`]
			: []),
		`quota    ${formatCount(remaining)} of ${formatCount(limit)} calls left · resets ${describeAt(reset_at, ctx.now())}`
	].join('\n');
}
