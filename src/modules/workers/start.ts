/**
 * The workers part of `start` — runner, initial sync, task execution, local server (`--serve`) and banner lines
 * (docs/design/15_cli.md §4, §8; docs/design/14_cli_host.md §10).
 *
 * `--serve`, `--port` and `--public` are workers module options — they only make sense in a long-running process,
 * so they attach to `start` (docs/design/15_cli.md §4).
 */
import path from 'node:path';
import { ApiClient } from '../../core/api.ts';
import { getOrCreateLocalServerToken } from '../../core/credentials.ts';
import {
	BIN,
	CliError,
	LIVE_RETRY_MS,
	LOCAL_SERVER_TOKEN_FILE,
	StopError,
	isReservedWorkerName,
	type CommandContext,
	type HostLive,
	type Quota,
	type ReceiveMode
} from '../../core/domain/index.ts';
import type { ModuleEnded } from '../../core/host/module.ts';
import type { RunnerLock } from '../../core/host/runner-lock.ts';
import { recordStop, stopHint, type Session } from '../../core/host/session.ts';
import type { Logger } from '../../core/logger.ts';
import { formatLocal } from '../../core/time.ts';
import {
	builtinResultsSpec,
	hostChangedWarning,
	resolveHostIdentity,
	type HostIdentity
} from './builtin/host-identity.ts';
import { resultsWorker } from './builtin/results-worker.ts';
import { startLocalServer, type LocalServer } from './local-server.ts';
import { WorkersModule } from './module.ts';
import { ResultStore } from './results/store.ts';
import { publicKeyEnv, workerEnv } from './runtime/env.ts';
import { Executor } from './runtime/executor.ts';
import { resyncWorkers, syncWorkers, type BuiltinSpec, type SyncOptions } from './sync.ts';
import { TaskRunner, type Reporter } from './task-runner.ts';
import type { WorkerSet } from './worker-set.ts';
import { workerFiles } from './workers.ts';

export interface WorkersStartOptions {
	ctx: CommandContext;
	session: Session;
	/** Same host-token client as the poller — sync, ack, reply */
	api: ApiClient;
	/** Host token — tells whether the cached host id belongs to this token (only a fingerprint is stored) */
	token: string;
	userAgent: string;
	lock: RunnerLock;
	root: string;
	workersDir: string;
	serve: boolean;
	isPublic: boolean;
	/** The user stopped — ends initial-sync retries */
	signal: AbortSignal;
	/** Stop code received while replying — the host stops the poller */
	onStop(err: StopError): void;
	/** Live channel URL from a `reload` resync response (docs/design/14_cli_host.md §13-5) */
	onLive?(live: HostLive): void;
}

/** workers module after the initial sync */
export interface WorkersRun {
	module: WorkersModule;
	/** Quota from the sync response — if the first pull is quota_exhausted, the poller reports this reset time */
	quota: Quota;
	/** Live channel URL from the initial sync response — absent if the server doesn't support live (docs/design/14_cli_host.md §13-1) */
	live: HostLive | null;
	/**
	 * Closes tasks the previous run left unfinished; returns the count. Call after creating the poller (so a stop
	 * while replying reaches it) and before the first pull or serve (any unfinished row then is from a previous run) (#1417)
	 */
	recover(): Promise<number>;
	/** Opens the local server when `--serve`. Call after creating the poller (so a push task's stop reaches it) */
	serve(): Promise<void>;
	/** Port the local server actually opened — null without `--serve` */
	serverPort(): number | null;
	/** Target on the banner's first line — `workers in ./workers` */
	bannerSubject(): string;
	/** Banner workers lines — local server, warning when no local workers are active */
	bannerLines(): string[];
	/** Notice when the run ends with 0 active workers */
	endMessage(ended: ModuleEnded): string;
	close(): Promise<void>;
}

/** Creates the runner and performs the initial sync. null if the user stops (syncWorkers) */
export async function startWorkers(opts: WorkersStartOptions): Promise<WorkersRun | null> {
	const { ctx, session, api, lock, root, workersDir, serve, isPublic } = opts;
	const { out } = ctx;
	const cfg = session.config.values;
	// Open the result store first — if it fails, the built-in read worker isn't registered either (nothing to read)
	const results = openResults(ctx, session, root);
	let host: HostIdentity | null = null;
	try {
		// With no files to send the run ends after sync anyway — skip the host lookup (1 call without a cache)
		if (results && hasSyncableFiles(workersDir)) {
			host = await lookupHost(ctx, session, api, opts.token);
		}
		// Host of the results this run stores — if the lookup fails it stays NULL and isn't visible remotely (#1403)
		if (results && host) results.setHost(host.id);
	} catch (err) {
		results?.close();
		throw err;
	}
	const builtin: BuiltinSpec | null = host ? builtinResultsSpec(host) : null;
	let workers!: WorkerSet;
	const isBuiltin = (name: string) => builtin !== null && name === workers?.builtin;
	const readBuiltin = host ? resultsWorker(root, host.id) : null;
	const executor = new Executor({
		workersDir,
		concurrency: cfg.concurrency,
		// Re-read per task — .env edits apply without a restart, like code
		env: () => workerEnv(root, ctx.env),
		logger: session.logger,
		builtin: (name) => (isBuiltin(name) ? readBuiltin : null)
	});
	const syncOpts: SyncOptions = {
		root,
		workersDir,
		isPublic: serve && isPublic,
		// live has no configured interval — failures without a code retry every LIVE_RETRY_MS (docs/design/14_cli_host.md §13-9)
		intervalMs: cfg.receiveMode === 'live' ? LIVE_RETRY_MS : cfg.pollIntervalMs,
		signal: opts.signal,
		builtin,
		onLive: opts.onLive,
		facts: {
			receiveMode: cfg.receiveMode,
			pollIntervalMs: cfg.pollIntervalMs,
			concurrency: cfg.concurrency,
			cliVersion: ctx.version,
			platform: `${ctx.platform}-${process.arch}`
		}
	};
	let synced;
	try {
		synced = await syncWorkers(ctx, session, api, syncOpts);
	} catch (err) {
		results?.close();
		throw err;
	}
	if (!synced) {
		results?.close();
		return null;
	}
	workers = synced.workers;

	const runner = new TaskRunner({
		executor,
		db: session.db,
		logger: session.logger,
		now: ctx.now,
		onStop: (err) => opts.onStop(err),
		onEvent: (line) => out.info(`${out.err.dim(formatLocal(ctx.now()))}  ${line}`),
		results,
		isBuiltin,
		reader: () => (workers.builtinActive ? workers.builtin : null),
		// Repeat runs happen outside pull responses — they report through the same client as pull
		repeatReporter: api,
		onSlotFree: () => module.notifySlotFree()
	});
	const module = new WorkersModule({
		api,
		runner,
		logger: session.logger,
		workers,
		onWorkersUnregistered: (names) => {
			for (const name of names) {
				out.warn(
					`${out.err.dim(formatLocal(ctx.now()))}  ${name} could not load and is not registered on the server — ` +
						`fix the file and run '${BIN} reload'.`
				);
			}
		},
		resync: () => resyncWorkers(ctx, session, api, syncOpts, workers, lock),
		onWorkersDropped: (names) => {
			for (const name of names) {
				out.info(
					`${out.err.dim(formatLocal(ctx.now()))}  ${name} was deleted with '${BIN} worker delete' — it is off for this run.`
				);
			}
		},
		onWorkersDeleted: (names) => {
			for (const name of names) {
				if (name === workers.builtin) {
					out.warn(
						`${out.err.dim(formatLocal(ctx.now()))}  the built-in results reader ${name} was deleted on the server — ` +
							`remote AIs cannot read saved results until '${BIN} reload'.`
					);
					continue;
				}
				out.warn(
					`${out.err.dim(formatLocal(ctx.now()))}  ${name} was deleted on the server — it is off for this run. ` +
						`If its file is still there, run '${BIN} reload' to register it again.`
				);
			}
		}
	});

	let server: LocalServer | null = null;
	return {
		module,
		quota: synced.quota,
		live: synced.live,
		recover: () => runner.recover(api),
		async serve() {
			if (!serve) return;
			server = await startLocalServer({
				port: cfg.localServerPort,
				public: isPublic,
				token: getOrCreateLocalServerToken(ctx.dirs.config),
				workersDir,
				env: () => publicKeyEnv(root, ctx.env),
				version: ctx.version,
				inactive: (name) => inactiveMessage(workers, name),
				onTask: (task, reporter) => void runner.handle(task, reporter, { ack: false }),
				reporterFor: (key) => pushReporter(api, key, cfg.apiUrl, opts.userAgent),
				// The response only says 'unauthorized' — configuration mistakes are found with `3minapi logs` (#1413)
				onRejected: rejectionLogger(session.logger),
				onError: (err) =>
					session.logger.error('local server request failed', {
						message: (err as Error)?.stack ?? String(err)
					})
			}).catch((err: Error) => {
				throw new CliError(`cannot open the local server: ${err.message}`);
			});
		},
		serverPort: () => server?.port ?? null,
		bannerSubject: () => `workers in ${displayPath(ctx.cwd, workersDir)}`,
		bannerLines: () => bannerLines(ctx, server, isPublic, workers, cfg.receiveMode),
		endMessage: (ended) => {
			const gone = ended.deletedWorkers;
			return (
				(gone.length > 0
					? `no workers left to run — ${gone.join(', ')} ${gone.length === 1 ? 'was' : 'were'} deleted on the server. Stopped.\n`
					: `no workers left to run — none of the workers in ${workersDir} is registered (see above). Stopped.\n`) +
				`Run '${BIN} start' again to register the workers in ${workersDir}.`
			);
		},
		async close() {
			await server?.close();
			results?.close();
		}
	};
}

/**
 * This host — the built-in read worker's name (docs/design/15_cli.md §8-6) and the `host_id` of stored results.
 * One `getHost` call without a cache. Stop codes are logged and thrown (as in the initial sync); other failures
 * warn and this run continues without the built-in worker
 */
async function lookupHost(
	ctx: CommandContext,
	session: Session,
	api: ApiClient,
	token: string
): Promise<HostIdentity | null> {
	try {
		const { host, error, previousHostId } = await resolveHostIdentity(
			session.db,
			api,
			token,
			ctx.now()
		);
		if (host && previousHostId) {
			ctx.out.warn(hostChangedWarning(previousHostId, host));
			session.logger.warn('host changed', { previous_host_id: previousHostId, host_id: host.id });
		}
		if (host) return host;
		ctx.out.warn(
			`could not look up this host (${error}) — the built-in results reader is off this run; remote AIs cannot read saved results.`
		);
		session.logger.warn('host lookup failed; built-in reader off', { message: error });
		return null;
	} catch (err) {
		if (err instanceof StopError) {
			recordStop(session, err, ctx.now());
			throw new StopError(err.reason, `${err.message}\n${stopHint(err.reason)}`, err.resetAt);
		}
		throw err;
	}
}

/** Whether any worker file doesn't start with `_` — checks file names only (no import). Folder errors are reported by sync */
function hasSyncableFiles(workersDir: string): boolean {
	try {
		return [...workerFiles(workersDir).keys()].some((name) => !isReservedWorkerName(name));
	} catch {
		return true;
	}
}

/**
 * Result store (data.db, docs/design/15_cli.md §8-5). If it can't be opened, warns once and runs without storage — oversized results fail as before
 */
function openResults(ctx: CommandContext, session: Session, root: string): ResultStore | null {
	try {
		const { store, warnings } = ResultStore.open(root);
		for (const w of warnings) {
			ctx.out.warn(w);
			session.logger.warn(w);
		}
		return store;
	} catch (err) {
		const message = (err as Error).message;
		ctx.out.warn(
			`cannot open data.db to save worker results: ${message}. Results are not saved this run, and results over 100 KiB fail.`
		);
		session.logger.warn('cannot open data.db; results are not saved', { message });
		return null;
	}
}

/** Rejection reason log — at most once per minute per (worker, reason), so crafted headers can't flood the log */
export function rejectionLogger(logger: Logger): (worker: string, reason: string) => void {
	const last = new Map<string, number>();
	return (worker, reason) => {
		const now = Date.now();
		const key = `${worker}\n${reason}`;
		if (now - (last.get(key) ?? 0) < 60_000) return;
		if (last.size >= 1000) last.clear();
		last.set(key, now);
		logger.warn('public request rejected', { worker, reason });
	};
}

function bannerLines(
	ctx: CommandContext,
	server: LocalServer | null,
	isPublic: boolean,
	workers: WorkerSet,
	mode: ReceiveMode
): string[] {
	const lines: string[] = [];
	if (server) {
		lines.push(
			isPublic
				? `public worker server on port ${server.port} (all interfaces, signed requests only)`
				: `HTTP server on ${server.url} (token in ${path.join(ctx.dirs.config, LOCAL_SERVER_TOKEN_FILE)})`
		);
	}
	if (workers.pullActiveCount === 0) {
		lines.push(
			ctx.out.err.yellow(
				mode === 'live'
					? 'no local workers are active — nothing will be fetched, but each live connect still uses one call'
					: 'no local workers are active — polls will find nothing to run but still use one call each'
			)
		);
	}
	return lines;
}

/** Sentence used when the local server rejects an inactive worker (docs/design/14_cli_host.md §10) */
function inactiveMessage(workers: WorkerSet, name: string): string | null {
	switch (workers.inactiveReason(name)) {
		case null:
			return null;
		case 'rejected':
			return `worker "${name}" was not registered with 3Min API (see the start output). Fix it and run '${BIN} reload'.`;
		case 'deleted_on_server':
			return `worker "${name}" was deleted on the server. If its file is still there, run '${BIN} reload' to register it again.`;
		case 'not_on_server':
			return `worker "${name}" is not registered for this run. Run '${BIN} reload' to register it.`;
	}
}

/** Public mode reply — that worker's tm_task_ key. A stop code also closes the poller's client */
function pushReporter(main: ApiClient, key: string, apiUrl: string, userAgent: string): Reporter {
	const client = new ApiClient({ apiUrl, token: key, userAgent });
	return {
		async report(url, body) {
			if (main.halted) throw main.halted;
			try {
				return await client.report(url, body);
			} catch (err) {
				if (err instanceof StopError) main.halt(err);
				throw err;
			}
		}
	};
}

/** `./workers` if inside cwd, otherwise the absolute path */
function displayPath(cwd: string, dir: string): string {
	const rel = path.relative(cwd, dir);
	if (rel === '') return '.';
	return rel.startsWith('..') || path.isAbsolute(rel) ? dir : `.${path.sep}${rel}`;
}
