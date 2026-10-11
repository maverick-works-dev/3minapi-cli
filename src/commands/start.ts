/**
 * start — host runtime: runs this PC as a 3Min API host (docs/design/15_cli.md §4, §8).
 *
 * The lock (one per host), stop/reload files and poller are feature-neutral and drive the enabled modules. The only module
 * is workers — its parts (executor, sync, local server, banner lines) live in modules/workers/start.ts.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ApiClient, userAgent } from '../core/api.ts';
import {
	APP_LOG_DIR,
	BIN,
	CliError,
	PROJECT_CONFIG_FILE,
	DEFAULT_LOCAL_SERVER_PORT,
	DETACH_READY_MS,
	ENV,
	ExitCode,
	ConfigError,
	RECEIVE_MODES,
	isTrustedLiveUrl,
	LOCAL_SERVER_TOKEN_FILE,
	MONTH_MS,
	RUNNER_OUT_FILE,
	STOP_CHECK_INTERVAL_MS,
	StopError,
	UsageError,
	type Command,
	type CommandContext,
	type Config,
	type LiveState,
	type ReceiveMode,
	type PullResponse,
	type Quota,
	type ResolvedConfig
} from '../core/domain/index.ts';
import { outputTail, spawnDetached } from '../core/host/detach.ts';
import { LIVE_META } from '../core/control-db.ts';
import { LiveReceiver } from '../core/host/live-receiver.ts';
import { Poller } from '../core/host/poller.ts';
import type { Receiver } from '../core/host/receiver.ts';
import { acquireRunnerLock, readRunner, type RunnerInfo } from '../core/host/runner-lock.ts';
import {
	openSession,
	recordEnd,
	recordStop,
	rememberQuota,
	stopHint,
	type Session
} from '../core/host/session.ts';
import { formatCount } from '../core/text.ts';
import {
	formatInterval,
	formatLocal,
	formatThroughput,
	maxTasksPerMinute,
	sleep
} from '../core/time.ts';
import { startWorkers, type WorkersRun } from '../modules/workers/start.ts';
import { noticeUpdate, requireProject, requireToken, requireWorkersDir } from './common.ts';
import { LatestWatch, readLatest, updateInfo } from '../core/update-notice.ts';

export const start: Command = {
	name: 'start',
	summary:
		'Run this machine as a 3Min API host: fetch tasks and run the worker files until stopped',
	usage: '[--detach] [--mode live|poll] [--serve [--port <port>] [--public]]',
	description:
		'Runs this machine as a 3Min API host. It registers the worker files in the workers\n' +
		'folder with 3Min API as local workers (one API call), then fetches their tasks and\n' +
		'runs them on this machine.\n' +
		'\n' +
		'When to fetch (--mode): live (default) keeps a connection open and fetches when 3Min API\n' +
		'signals a new or cancelled task — idle costs no calls; each connect or reconnect is one\n' +
		'call and each fetch is one. poll fetches every interval instead (pollIntervalMs), and every\n' +
		'poll counts as one call even when nothing is waiting — use it where WebSockets are blocked\n' +
		"(a company proxy or firewall; '3minapi doctor' checks). There is no automatic switch.\n" +
		'\n' +
		'Adding or renaming a worker file, or changing its description, takes effect on\n' +
		"'3minapi reload' (no restart; running tasks keep going) — 'worker new' reloads by itself.\n" +
		'Handler code and .env changes apply to the next task. A worker deleted on the server is\n' +
		'turned off for the run, and start ends when no worker is left.\n' +
		'\n' +
		'The server holds the queue: each fetch takes only as many tasks as can start now (up to the\n' +
		'concurrency setting, default 4). In poll mode at most concurrency x polls per minute run — about\n' +
		'8 a minute at 4 every 30s. A fetched task is run to the end; if this machine stops before it finishes, the\n' +
		'next start reports it failed (host_restarted) instead of running it again.\n' +
		'Stops all calls immediately when the quota runs out or the token is revoked, and does not\n' +
		'start again on its own — run start again after fixing the cause.\n' +
		'\n' +
		'Runs in the foreground by default (Ctrl+C to stop). With --detach it keeps running\n' +
		"after the terminal is closed — stop it with '3minapi stop'. Only one can run per host.\n" +
		'It does not start again after a reboot.\n' +
		'\n' +
		'--serve also opens an HTTP server: POST /task/<worker> on 127.0.0.1, with the token\n' +
		`in ${LOCAL_SERVER_TOKEN_FILE} (Authorization: Bearer <token>). --public listens on all\n` +
		'interfaces instead and serves worker files as public workers: 3Min API POSTs signed tasks\n' +
		'to this machine. Use it for names registered as public workers on the dashboard, with\n' +
		'THREEMINAPI_WORKER_<NAME>_SECRET and THREEMINAPI_WORKER_<NAME>_KEY set; those files are\n' +
		'not registered as local workers. Long-running servers only — serverless platforms are\n' +
		'not supported.',
	options: {
		detach: {
			type: 'boolean',
			short: 'd',
			description: "Run in the background (stop with '3minapi stop')"
		},
		mode: {
			type: 'string',
			valueName: RECEIVE_MODES.join('|'),
			description:
				'When to fetch tasks: live (default — when 3Min API signals) or poll (every interval)'
		},
		serve: {
			type: 'boolean',
			description: 'Also open an HTTP server (127.0.0.1; all interfaces with --public)'
		},
		port: {
			type: 'string',
			valueName: 'port',
			description: `HTTP server port (default ${DEFAULT_LOCAL_SERVER_PORT}, with --serve)`
		},
		public: {
			type: 'boolean',
			description: 'Serve worker files as public workers on all interfaces (with --serve)'
		}
	},
	args: { min: 0, max: 0 },
	async run(ctx) {
		if ((ctx.values.port !== undefined || ctx.values.public) && !ctx.values.serve) {
			throw new UsageError('--port and --public need --serve');
		}
		if (ctx.values.detach && ctx.env[ENV.detached] !== '1') return startDetached(ctx);
		return startForeground(ctx);
	}
};

// ── start (foreground = the actual run) ──────────────────────────────────

async function startForeground(ctx: CommandContext): Promise<ExitCode> {
	const { out } = ctx;
	const token = requireToken(ctx);
	const detachedChild = ctx.env[ENV.detached] === '1';
	const session = openSession(ctx);
	try {
		const { values: cfg } = session.config;
		const { root, dir: workersDir } = requireWorkersDir(session.config);
		const serve = Boolean(ctx.values.serve);
		const isPublic = Boolean(ctx.values.public);

		const lock = acquireRunnerLock(
			ctx.dirs.data,
			{
				detached: detachedChild,
				port: serve ? cfg.localServerPort : null,
				public: serve && isPublic,
				intervalMs: cfg.receiveMode === 'live' ? null : cfg.pollIntervalMs,
				mode: cfg.receiveMode,
				concurrency: cfg.concurrency,
				apiUrl: cfg.apiUrl,
				outFile: detachedChild ? outFilePath(ctx) : null,
				workersDir,
				reload: true,
				localDelete: true
			},
			ctx.now()
		);
		// Worker threads share the process cwd — workers run in the project folder wherever start was launched (#1403)
		ctx.chdir(root);
		ctx.claimInterrupt();
		const shutdown = new AbortController();
		const onAbort = () => shutdown.abort();
		ctx.signal.addEventListener('abort', onAbort, { once: true });
		// Reload requests are consumed only while the poller runs and no resync is in progress. Requests during the startup sync
		// wait until the poller exists. Merging into a running resync would miss new files it has already listed (#1393)
		let polling: Receiver | null = null;
		// The project folder was moved or deleted while running — worker files would be looked up at the old path, so stop.
		// Immediately if the folder is gone; if only the config file is gone, after two checks in a row, so an editor's save
		// (rename → rewrite) doesn't trigger it. Checks the config file actually read, not root/3minapi.json (`--config other.json`)
		const projectFile = session.config.projectFile ?? path.join(root, PROJECT_CONFIG_FILE);
		let projectGone = false;
		let fileMisses = 0;
		const stopWatch = setInterval(() => {
			lock.heartbeat();
			if (!projectGone) {
				fileMisses = existsSync(projectFile) ? 0 : fileMisses + 1;
				if (!existsSync(root) || fileMisses >= PROJECT_GONE_MISSES) {
					projectGone = true;
					session.logger.warn('project folder gone', { root });
					shutdown.abort();
				}
			}
			if (lock.stopRequested()) shutdown.abort();
			else if (polling?.resyncIdle) {
				// Names removed by worker delete — consumed only when no resync is running. A resync revives names the server accepted
				const deleted = lock.takeDeleted();
				if (deleted.length > 0) polling.requestDrop(deleted);
				if (lock.takeReload()) polling.requestResync();
			}
		}, STOP_CHECK_INTERVAL_MS);
		let workers: WorkersRun | null = null;

		try {
			// Recommended version — arrives with every pull. Stored only on change; after the banner, notices on change and every 24h.
			// A background child's stderr is a file nobody reads — using the daily slot there would silence status too, so it only goes to the app log (#1425)
			const debug = (m: string, a?: Record<string, unknown>) => session.logger.debug(m, a);
			const updates = new LatestWatch({
				db: session.db,
				now: ctx.now,
				log: debug,
				announce: () => {
					if (!detachedChild) {
						noticeUpdate(ctx, session, true);
						return;
					}
					const info = updateInfo(ctx.version, readLatest(session.db, debug), true);
					if (info.available) {
						session.logger.info('update available', { current: info.current, latest: info.latest });
					}
				}
			});
			const agent = userAgent(ctx.version, ctx.platform);
			const api = new ApiClient({
				apiUrl: cfg.apiUrl,
				token: token.token,
				userAgent: agent,
				onServerCli: (cli) => updates.observe(cli)
			});
			let receiver!: Receiver;
			resetLiveState(session);
			workers = await startWorkers({
				ctx,
				session,
				api,
				token: token.token,
				userAgent: agent,
				lock,
				root,
				workersDir,
				serve,
				isPublic,
				signal: shutdown.signal,
				onStop: (err) => receiver.stop(err),
				onLive: (live) => {
					if (receiver instanceof LiveReceiver) receiver.setUrl(live.url);
					else rememberLiveUrl(session, live.url, cfg.apiUrl, ctx.now());
				}
			});
			if (projectGone) throw projectGoneError(root);
			if (!workers) {
				out.info('Stopped.');
				return ctx.signal.aborted ? ExitCode.Interrupted : ExitCode.Ok;
			}

			const onPull = pullReporter(ctx, cfg.receiveMode, (quota) =>
				rememberQuota(session, quota, ctx.now())
			);
			const onError = (err: Error) => out.warn(err.message);
			// Stored even in poll mode — doctor uses it to check whether live would work (useful for `--mode poll` hosts)
			if (workers.live) rememberLiveUrl(session, workers.live.url, cfg.apiUrl, ctx.now());
			if (cfg.receiveMode === 'live') {
				const url = liveUrl(workers.live?.url ?? null, cfg.apiUrl);
				receiver = new LiveReceiver({
					api,
					logger: session.logger,
					module: workers.module,
					quota: workers.quota,
					signal: shutdown.signal,
					url,
					token: token.token,
					apiUrl: cfg.apiUrl,
					onPull,
					onError,
					onState: liveStateReporter(ctx, session),
					onLiveUrl: (next) => saveMeta(session, LIVE_META.url, next, ctx.now())
				});
			} else {
				receiver = new Poller({
					api,
					logger: session.logger,
					intervalMs: cfg.pollIntervalMs,
					module: workers.module,
					quota: workers.quota,
					signal: shutdown.signal,
					onPull,
					onError
				});
			}
			const closed = await workers.recover();
			if (closed > 0) {
				out.info(`closed ${closed} task(s) the previous run left unfinished — see '${BIN} tasks'`);
			}
			await workers.serve();

			out.info(banner(ctx, session.config, workers));
			// First notice after the banner — then on change and every 24h (LatestWatch)
			updates.arm();
			session.logger.info('runner started', {
				pid: process.pid,
				detached: detachedChild,
				mode: cfg.receiveMode,
				interval_ms: cfg.receiveMode === 'live' ? null : cfg.pollIntervalMs,
				port: workers.serverPort(),
				public: isPublic
			});

			polling = receiver;
			const stopped = await receiver.run();
			polling = null;
			if (stopped && !(stopped instanceof StopError)) {
				recordEnd(session, stopped.ended, stopped.deletedWorkers, ctx.now());
				throw new CliError(workers.endMessage(stopped));
			}
			if (stopped) {
				recordStop(session, stopped, ctx.now());
				throw new StopError(
					stopped.reason,
					`${stopped.message}\n${stopHint(stopped.reason)}`,
					stopped.resetAt
				);
			}
			if (projectGone) throw projectGoneError(root);
			session.logger.info('runner stopped', { pid: process.pid });
			out.info('Stopped.');
			return ctx.signal.aborted ? ExitCode.Interrupted : ExitCode.Ok;
		} finally {
			clearInterval(stopWatch);
			ctx.signal.removeEventListener('abort', onAbort);
			await workers?.close();
			lock.release();
		}
	} finally {
		session.close();
	}
}

/**
 * live connection URL (docs/design/14_cli_host.md §13-1) — absent from the sync response means the server doesn't support live.
 * No token is sent to an untrusted URL (another host, plain text). Neither falls back to poll automatically: exit 3, and the user picks `--mode poll`
 */
function liveUrl(url: string | null, apiUrl: string): string {
	if (url === null) {
		throw new ConfigError(
			`this server (${apiUrl}) does not support live mode. Run '${BIN} start --mode poll' to fetch tasks at an interval instead.`
		);
	}
	if (!isTrustedLiveUrl(url, apiUrl)) {
		throw new ConfigError(
			`the server gave a live address that is not on ${apiUrl} — not connecting, so your host token is not sent elsewhere. ` +
				`Run '${BIN} start --mode poll' instead, and check the API URL.`
		);
	}
	return url;
}

/** Clears the previous run's connection state so status doesn't show it. The URL (live_url) is kept for doctor */
function resetLiveState(session: Session): void {
	try {
		session.db.deleteMeta(LIVE_META.state);
	} catch (e) {
		session.logger.warn('could not clear the live state', { message: (e as Error).message });
	}
}

/** Stores the server-provided live URL for doctor — only when it is on the API host (no handshake with another host) */
function rememberLiveUrl(session: Session, url: string, apiUrl: string, now: number): void {
	if (isTrustedLiveUrl(url, apiUrl)) saveMeta(session, LIVE_META.url, url, now);
}

function saveMeta(session: Session, key: string, value: string, now: number): void {
	try {
		session.db.setMeta(key, value, now);
	} catch (e) {
		session.logger.warn('could not record live info', { key, message: (e as Error).message });
	}
}

/**
 * Records connection state in the control DB (for status) and warns once if it never connected in this run — surfaces failure
 * (there is no fallback polling). The cause is unknown (WebSocket exposes no status code), so it points to doctor and `--mode poll`
 */
function liveStateReporter(ctx: CommandContext, session: Session): (state: LiveState) => void {
	let warned = false;
	return (state) => {
		try {
			session.db.setLiveState(state, ctx.now());
		} catch (e) {
			session.logger.warn('could not record the live state', { message: (e as Error).message });
		}
		if (state.connected && warned) {
			warned = false;
			ctx.out.info(`${ctx.out.err.dim(formatLocal(ctx.now()))}  live connection open`);
		} else if (!state.connected && !state.everConnected && state.lastError && !warned) {
			warned = true;
			ctx.out.warn(
				`could not open the live connection (${state.lastError}) — retrying in the background; no tasks are fetched until it connects.
` +
					`On a network that blocks WebSockets (a company proxy or firewall), run '${BIN} doctor' or start with '--mode poll'.`
			);
		}
	};
}

/** Consecutive misses (seconds) before the config file counts as gone — an editor save causes a single miss */
const PROJECT_GONE_MISSES = 2;

function projectGoneError(root: string): CliError {
	return new CliError(
		`the project folder ${root} is gone (moved or deleted). Stopped. ` +
			`If you moved it, run '${BIN} start' inside the new folder.`
	);
}

/** Reports when tasks arrive and when remaining quota drops below 10%. The sync already printed the first quota line */
function pullReporter(ctx: CommandContext, mode: ReceiveMode, remember: (quota: Quota) => void) {
	let warnedLow = false;
	return (res: PullResponse) => {
		remember(res.quota);
		const { remaining, limit } = res.quota;
		const left = `${formatCount(remaining)} of ${formatCount(limit)} calls left`;
		if (res.tasks.length > 0) {
			ctx.out.info(
				`${ctx.out.err.dim(formatLocal(ctx.now()))}  received ${res.tasks.length} task(s) · ${left}`
			);
		}
		if (!warnedLow && limit > 0 && remaining < limit * 0.1) {
			warnedLow = true;
			ctx.out.warn(
				`only ${left}. ${
					mode === 'live'
						? 'Each fetch and each reconnect uses one call'
						: 'Every poll uses one call'
				}; all calls stop when the quota runs out.`
			);
		}
	};
}

function banner(ctx: CommandContext, config: ResolvedConfig, workers: WorkersRun): string {
	const lines = [
		`${ctx.out.err.green('started')}  ${workers.bannerSubject()} · pid ${process.pid}`,
		modeLine(config.values),
		...workers.bannerLines()
	];
	lines.push(
		ctx.env[ENV.detached] === '1' ? `stop with '${BIN} stop'` : `Ctrl+C or '${BIN} stop' to stop`
	);
	return lines.join('\n');
}

// ── start --detach ─────────────────────────────────────────────

async function startDetached(ctx: CommandContext): Promise<ExitCode> {
	const { out } = ctx;
	// Check in the parent what would make the child fail — so it doesn't die silently in the background
	requireToken(ctx);
	const config = ctx.loadConfig();
	const root = requireProject(config);
	const current = readRunner(ctx.dirs.data);
	if (current.state === 'running') {
		throw new CliError(
			`3minapi is already running (pid ${current.info.pid}). Only one can run per host.\n` +
				`Stop it with '${BIN} stop' first.`
		);
	}

	const outFile = outFilePath(ctx);
	const startedAt = Date.now();
	// The child picks the same (recorded) project — launched in the project folder so the workers' cwd matches (#1403)
	const child = spawnDetached({
		args: ['start', ...forwardArgs(ctx)],
		cwd: root,
		env: ctx.env,
		outFile
	});

	let exited: number | null = null;
	child.once('exit', (code) => (exited = code ?? 1));
	let info: RunnerInfo | null = null;
	while (Date.now() - startedAt < DETACH_READY_MS && exited === null) {
		const state = readRunner(ctx.dirs.data);
		if (state.state === 'running' && state.info.pid === child.pid) {
			info = state.info;
			break;
		}
		await sleep(100);
	}
	child.unref();

	if (!info) {
		if (exited === null) {
			try {
				child.kill();
			} catch {
				// already exited
			}
		}
		throw new CliError(
			`the background runner did not start${exited !== null ? ` (exit code ${exited})` : ''}.\n` +
				outputTail(outFile)
		);
	}

	const { pollIntervalMs, concurrency, receiveMode } = config.values;
	// live has no interval — interval-derived values are null (unknown), not 0 (docs/design/15_cli.md §4)
	const poll = receiveMode === 'poll';
	out.result(
		{
			running: true,
			pid: info.pid,
			outFile,
			mode: receiveMode,
			intervalMs: poll ? pollIntervalMs : null,
			monthlyCalls: poll ? Math.round(MONTH_MS / pollIntervalMs) : null,
			concurrency,
			maxTasksPerMinute: poll ? maxTasksPerMinute(concurrency, pollIntervalMs) : null
		},
		[
			`${out.out.green('started in the background')}  pid ${info.pid}`,
			modeLine(config.values),
			`output: ${outFile}`,
			`stop with '${BIN} stop' · check with '${BIN} status'`
		].join('\n')
	);
	return ExitCode.Ok;
}

function forwardArgs(ctx: CommandContext): string[] {
	const { values } = ctx;
	const args: string[] = [];
	if (values.serve) args.push('--serve');
	if (values.public) args.push('--public');
	if (typeof values.port === 'string') args.push('--port', values.port);
	if (typeof values.mode === 'string') args.push('--mode', values.mode);
	if (typeof values['api-url'] === 'string') args.push('--api-url', values['api-url']);
	if (typeof values.config === 'string')
		args.push('--config', path.resolve(ctx.cwd, values.config));
	return args;
}

function outFilePath(ctx: CommandContext): string {
	return path.join(ctx.dirs.logs, APP_LOG_DIR, RUNNER_OUT_FILE);
}

function monthlyCalls(intervalMs: number): string {
	return formatCount(Math.round(MONTH_MS / intervalMs));
}

/** Banner's receive-mode line — cost model for live; interval, throughput and empty-poll cost for poll */
function modeLine(cfg: Pick<Config, 'receiveMode' | 'pollIntervalMs' | 'concurrency'>): string {
	if (cfg.receiveMode === 'poll') return pollingLine(cfg.pollIntervalMs, cfg.concurrency);
	return (
		`live — fetches when 3Min API signals, up to ${cfg.concurrency} at a time. ` +
		'Idle ≈ 0 calls · 1 call per connect or reconnect · about 3 calls per task'
	);
}

/** Poll interval, throughput cap, empty-poll cost */
function pollingLine(intervalMs: number, concurrency: number): string {
	return (
		`polling every ${formatInterval(intervalMs)}, ${formatThroughput(concurrency, intervalMs)} — ` +
		`about ${monthlyCalls(intervalMs)} calls per month even when idle`
	);
}
