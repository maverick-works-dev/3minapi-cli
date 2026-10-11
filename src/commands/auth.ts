import { statSync } from 'node:fs';
import path from 'node:path';
import type { ControlDb, EndRecord } from '../core/control-db.ts';
import {
	deleteHostToken,
	isHostToken,
	resolveHostToken,
	saveHostToken,
	type HostToken
} from '../core/credentials.ts';
import {
	BIN,
	ENV,
	ExitCode,
	HOST_TOKEN_PREFIX,
	LOCAL_SERVER_TOKEN_FILE,
	MONTH_MS,
	StopError,
	UsageError,
	type Command,
	type CommandContext,
	type HostResponse,
	type LiveState,
	type OutputPort,
	type ResolvedConfig,
	builtinResultsName,
	isReservedWorkerName
} from '../core/domain/index.ts';
import { readAllStdin, readSecret } from '../core/prompt.ts';
import { readRunner, runnerMode, type RunnerState } from '../core/host/runner-lock.ts';
import { readDashboard, type DashboardState } from '../modules/dashboard/lock.ts';
import { looseMode } from '../core/secure-fs.ts';
import { defaultProjectRoot } from '../core/project.ts';
import {
	clearStop,
	openSession,
	recordStop,
	rememberQuota,
	stopHint,
	type Session
} from '../core/host/session.ts';
import { hostUsage, type HostUsage } from '../core/host/usage.ts';
import { formatBytes, formatCount, stripControl } from '../core/text.ts';
import {
	describeAt,
	formatLocal,
	formatThroughput,
	maxTasksPerMinute,
	relative
} from '../core/time.ts';
import {
	HOST_META,
	cacheHostIdentity,
	hostChangedWarning
} from '../modules/workers/builtin/host-identity.ts';
import { ResultStore, resultsDbBytes, resultsDbPath } from '../modules/workers/results/store.ts';
import { workerFiles } from '../modules/workers/workers.ts';
import { parseSettings } from '../modules/workers/repeat-scheduler.ts';
import { ApiError } from '../core/api.ts';
import { client, noticeUpdate, workersPath } from './common.ts';
import { readLatest, updateInfo } from '../core/update-notice.ts';

// Tokens are never taken as flags — they would stay in shell history and the process list (clig.dev). Prompt or stdin only.
/**
 * One line on what to do after login: project → worker file → start.
 * Only a hint, so login still succeeds when the workers folder is unreadable — it then points to `worker new`
 */
function nextAfterLogin(ctx: CommandContext, config: ResolvedConfig): string {
	const root = config.projectRoot;
	if (!root) {
		return `Next: ${BIN} init   ${ctx.out.out.dim(`(creates ${defaultProjectRoot(ctx.home)})`)}`;
	}
	let hasWorkers = false;
	try {
		hasWorkers = workerFiles(workersPath(root, config)).size > 0;
	} catch {
		// workers folder missing or unreadable — start and doctor report the cause
	}
	return hasWorkers ? `Next: ${BIN} start` : `Next: ${BIN} worker new <name>`;
}

export const login: Command = {
	name: 'login',
	summary: 'Save the host token issued on the 3Min API dashboard',
	usage: '[--with-token]',
	description:
		'Prompts for the host token (tm_host_...). Use --with-token to read it from stdin instead,\n' +
		'e.g. in CI: echo "$TOKEN" | 3minapi login --with-token\n' +
		'The token is checked with the server (one API call) before it is saved.',
	options: {
		'with-token': { type: 'boolean', description: 'Read the token from stdin' }
	},
	args: { min: 0, max: 0 },
	async run(ctx) {
		const { out, env, values } = ctx;
		let token: string;
		if (values['with-token']) {
			if (ctx.stdin.isTTY) {
				throw new UsageError(
					`--with-token reads the token from stdin. Pipe it in: echo "$TOKEN" | ${BIN} login --with-token`
				);
			}
			token = (await readAllStdin(ctx.stdin)).trim();
		} else {
			token = (
				await readSecret(ctx.stdin, out, `Paste your host token (${HOST_TOKEN_PREFIX}...): `)
			).trim();
		}
		if (!isHostToken(token)) {
			throw new UsageError(
				`that is not a host token (expected ${HOST_TOKEN_PREFIX} followed by 48 hex characters)`
			);
		}

		const session = openSession(ctx);
		try {
			let host: HostResponse;
			try {
				host = await client(ctx, session, token).getHost();
			} catch (err) {
				// The new token was rejected — don't save it. This says nothing about the stored token, so no stop reason is recorded
				if (err instanceof StopError) {
					session.logger.warn('login rejected', { reason: err.reason });
					throw new StopError(err.reason, `${err.message}\n${stopHint(err.reason)}`, err.resetAt);
				}
				throw err;
			}
			const file = saveHostToken(ctx.dirs.config, token, ctx.now());
			clearStop(session);
			const previous = cacheHostIdentity(session.db, token, host.host, ctx.now());
			rememberQuota(session, host.quota, ctx.now());
			session.logger.info('logged in', { host_id: host.host.id, host_name: host.host.name });
			// Logged in again as a different host — the previous host's history and results are kept (#1403)
			if (previous !== null) {
				out.warn(hostChangedWarning(previous, host.host));
				session.logger.warn('host changed', { previous_host_id: previous, host_id: host.host.id });
			}

			if (env[ENV.token]) {
				out.warn(`${ENV.token} is set and takes precedence over the saved token.`);
			}
			const projectRoot = session.config.projectRoot;
			out.result(
				{
					host: host.host,
					workers: host.workers,
					quota: host.quota,
					credentials: file,
					previousHostId: previous,
					projectRoot
				},
				[
					`${out.out.green('logged in')}  ${stripControl(host.host.name)}`,
					`token saved to ${file}`,
					quotaLine(out, host, ctx.now()),
					'',
					nextAfterLogin(ctx, session.config)
				].join('\n')
			);
			return ExitCode.Ok;
		} finally {
			session.close();
		}
	}
};

export const logout: Command = {
	name: 'logout',
	summary: 'Remove the saved host token from this machine',
	usage: '',
	description:
		'Only deletes the token saved on this machine. To revoke it, delete the token on the dashboard.',
	options: {},
	args: { min: 0, max: 0 },
	async run({ dirs, env, out }) {
		// Logout must work even with a broken config — don't open the config or DB
		const removed = deleteHostToken(dirs.config);
		if (env[ENV.token]) {
			out.warn(`${ENV.token} is still set — unset it to stop using that token.`);
		}
		out.result({ removed }, removed ? 'Logged out.' : 'No saved token. Already logged out.');
		return ExitCode.Ok;
	}
};

export const status: Command = {
	name: 'status',
	summary: "Show this host: whether 'start' is running, its workers, and remaining quota",
	usage: '',
	description:
		'Checks the token with the server, which counts as one API call. Also shows how much disk this\n' +
		'host uses (task history, saved results, logs), and how it fetches tasks: live (connection state)\n' +
		'or poll (interval, and at most concurrency x polls per minute). If the server cannot be reached (network), shows\n' +
		'what this PC knows — including the quota from the last server response — and exits with 1.',
	options: {},
	args: { min: 0, max: 0 },
	async run(ctx) {
		const { out } = ctx;
		const token = resolveHostToken(ctx.dirs.config, ctx.env);
		if (!token) {
			// The dashboard runs without login (docs/design/15_cli.md §9-1) — report it when up, especially when open to the LAN
			const board = readDashboard(ctx.dirs.data);
			out.result(
				{ loggedIn: false, dashboard: dashboardJson(board) },
				[
					`Not logged in. Run '${BIN} login'.`,
					...(board.state === 'stopped'
						? []
						: [row('dashboard', dashboardText(out, board, ctx.now()))])
				].join('\n')
			);
			return ExitCode.Failure;
		}
		warnLooseToken(out, token);

		const session = openSession(ctx);
		try {
			const overrides = overridesIn(ctx, token);
			let host: HostResponse;
			try {
				host = await client(ctx, session, token.token).getHost();
			} catch (err) {
				if (err instanceof StopError) {
					recordStop(session, err, ctx.now());
					throw new StopError(err.reason, `${err.message}\n${stopHint(err.reason)}`, err.resetAt);
				}
				// Show what this PC knows only when the server was unreachable (network, no response). A server error (5xx, 404, …),
				// a user interrupt or a CLI bug ends with that error as is
				if (!(err instanceof ApiError) || err.status !== null || ctx.signal.aborted) throw err;
				offlineStatus(ctx, session, token, overrides, err);
				return ExitCode.Failure;
			}
			clearStop(session);
			const previousHost = cacheHostIdentity(session.db, token.token, host.host, ctx.now());
			rememberQuota(session, host.quota, ctx.now());
			if (previousHost !== null) out.warn(hostChangedWarning(previousHost, host.host));

			const now = ctx.now();
			const runner = readRunner(ctx.dirs.data);
			const board = readDashboard(ctx.dirs.data);
			const update = noticeUpdate(ctx, session, runner.state === 'running');
			// Compare local files with the server list, no extra call. The next start registers workers missing on the server (docs/design/14_cli_host.md §10)
			// With a running runner, compare against the folder it reads — if it reads another project (`--config`, or a start
			// launched before the project was recorded), every live worker would look "server only" and get a worker delete hint (#1388)
			const compareDir =
				runner.state === 'running' && runner.info.workersDir
					? runner.info.workersDir
					: projectWorkersDir(session.config);
			const local = compareDir === null ? null : workerNamesIn(compareDir);
			const registered = new Set(host.workers.map((w) => w.name));
			// `_` files are not registered (names reserved for built-in workers) — start output explains why
			const unregistered =
				local?.filter((n) => !registered.has(n) && !isReservedWorkerName(n)) ?? [];
			// The other direction — workers left only on the server with no file; tasks for them keep failing. Not cleaned up
			// automatically, only a worker delete hint. Outside a project (local=null) this can't be judged, so it stays empty
			const localSet = new Set(local ?? []);
			// Built-in read workers have no file by design — no delete hint
			const builtin = builtinResultsName(host.host.id);
			const serverOnly =
				local === null
					? []
					: host.workers.map((w) => w.name).filter((n) => !localSet.has(n) && n !== builtin);
			const lastEnd = runner.state === 'stopped' ? readEnd(session) : null;
			// Address and interval come from the running runner — they may differ from this shell's config (start -d keeps its launch environment)
			const shell = session.config.values;
			const running = runner.state === 'running' ? runner.info : null;
			const apiUrl = running?.apiUrl ?? shell.apiUrl;
			const urlMismatch = running?.apiUrl !== undefined && running.apiUrl !== shell.apiUrl;
			// Receive mode also comes from the running runner; otherwise this shell's config (what the next start would use)
			const mode = running ? runnerMode(running) : shell.receiveMode;
			const intervalMs = running?.intervalMs ?? shell.pollIntervalMs;
			// live has no interval — interval-derived values are null (not 0)
			const effectiveMs = mode === 'poll' ? Math.max(intervalMs, host.poll.min_interval_ms) : null;
			const concurrency = running?.concurrency ?? shell.concurrency;
			const liveState = running && mode === 'live' ? readLiveState(session.db) : null;
			const results = savedResults(session.config.projectRoot);
			const usage = hostUsage(session.db, ctx.dirs.logs);
			const repeats = readRepeats(session.db, session.config.projectRoot);
			const data = {
				loggedIn: true,
				token: { source: token.source, location: token.location },
				apiUrl: shell.apiUrl,
				mode,
				// live has no interval — null, as in start -d --json (docs/design/15_cli.md §4)
				pollIntervalMs: mode === 'poll' ? shell.pollIntervalMs : null,
				effectivePollIntervalMs: effectiveMs,
				concurrency,
				maxTasksPerMinute:
					effectiveMs === null ? null : maxTasksPerMinute(concurrency, effectiveMs),
				liveState,
				host: host.host,
				workers: host.workers,
				quota: host.quota,
				poll: host.poll,
				localWorkers: local,
				unregisteredWorkers: unregistered,
				serverOnlyWorkers: serverOnly,
				running: runner.state === 'running',
				runner: runner.state === 'running' ? runner.info : null,
				repeats,
				dashboard: dashboardJson(board),
				lastEnd: lastEnd && { ...lastEnd, endedAt: new Date(lastEnd.endedAt).toISOString() },
				results,
				usage: usageJson(usage, session.config.projectRoot, results),
				overrides,
				update
			};
			const workers = host.workers.map((w) => w.name);
			out.result(
				data,
				[
					row(
						'host',
						`${stripControl(host.host.name)} ${out.out.dim(`(${stripControl(host.host.id)})`)}`
					),
					row(
						'token',
						token.source === 'env' ? `from ${token.location}` : `saved in ${token.location}`
					),
					...overrideRows(out, overrides),
					row('remote', `${apiUrl}${urlMismatch ? out.out.dim(' (runner)') : ''}`),
					...(urlMismatch
						? [
								row(
									'',
									`${out.out.yellow('warn')} this shell uses ${shell.apiUrl} — host, workers and quota here come from that server`
								)
							]
						: []),
					row(
						'workers',
						workers.length === 0
							? 'none registered yet'
							: `${workers.length} (${workers.join(', ')})`
					),
					...(unregistered.length > 0
						? [
								row(
									'',
									`${out.out.yellow('not registered')} ${unregistered.join(', ')} ${out.out.dim(
										runner.state !== 'running'
											? `· the next '${BIN} start' tries to register them`
											: runner.info.reload
												? `· '${BIN} reload' to register`
												: `· restart '${BIN} start' to register`
									)}`
								)
							]
						: []),
					...serverOnly.map((n) =>
						row(
							'',
							`${out.out.yellow('server only')} ${n} ${out.out.dim(
								`· no file in ${compareDir} — '${BIN} worker delete ${n}' removes it from 3Min API`
							)}`
						)
					),
					quotaLine(out, host, now),
					effectiveMs === null
						? row('mode', liveText(out, running !== null, liveState, concurrency, now))
						: row(
								'poll',
								`every ${secs(effectiveMs)}${running ? '' : ' when started'}, ${formatThroughput(concurrency, effectiveMs)} ${out.out.dim(
									`(server minimum ${secs(host.poll.min_interval_ms)}) · about ${formatCount(Math.round(MONTH_MS / effectiveMs))} calls per month` +
										(running && running.intervalMs !== shell.pollIntervalMs
											? ` · runner setting; this shell has ${secs(shell.pollIntervalMs)}`
											: '')
								)}`
							),
					row('runner', runnerText(out, runner, now, lastEnd)),
					...repeatRows(out, repeats, concurrency, runner.state === 'running'),
					row('dashboard', dashboardText(out, board, now)),
					...storageRows(out, usage, results),
					...(running && running.port !== null
						? [row('listen', serveText(out, running.port, running.public, ctx.dirs.config))]
						: [])
				].join('\n')
			);
			return ExitCode.Ok;
		} finally {
			session.close();
		}
	}
};

/** `THREEMINAPI_HOME`, `THREEMINAPI_TOKEN` — for development and tests. When set, status says this is not the default host (#1403) */
interface Overrides {
	/** The state folder was moved — its path */
	home: string | null;
	/** The token was read from the environment */
	token: boolean;
}

function overridesIn(ctx: CommandContext, token: HostToken): Overrides {
	const home = ctx.env[ENV.home];
	return {
		home: home && path.isAbsolute(home) ? home : null,
		token: token.source === 'env'
	};
}

function overrideRows(out: OutputPort, o: Overrides): string[] {
	const rows: string[] = [];
	if (o.home !== null) {
		rows.push(
			row(
				'',
				`${out.out.yellow('note')} ${ENV.home} is set — not this PC's default host folder (for development and tests)`
			)
		);
	}
	if (o.token) {
		rows.push(
			row(
				'',
				`${out.out.yellow('note')} ${ENV.token} is set — not the token saved by '${BIN} login' (for development, CI and tests)`
			)
		);
	}
	return rows;
}

type SavedResults = ReturnType<typeof savedResults>;

function usageJson(usage: HostUsage, root: string | null, results: SavedResults) {
	return {
		controlDb: usage.controlDb,
		dataDb:
			root && results
				? { file: resultsDbPath(root), bytes: results.dbBytes, results: results.count }
				: null,
		logs: usage.logs
	};
}

/** Disk usage — control DB (no auto-delete), data.db (no auto-delete), logs (retention period and total size) */
function storageRows(out: OutputPort, usage: HostUsage, results: SavedResults): string[] {
	const rows: string[] = [];
	if (usage.controlDb) {
		const { tasks, unfinished, bytes } = usage.controlDb;
		rows.push(
			row(
				'history',
				`${formatCount(tasks)} task(s)${unfinished > 0 ? `, ${formatCount(unfinished)} not finished` : ''} · control.db ${formatBytes(bytes)} ${out.out.dim(
					`('${BIN} tasks prune')`
				)}`
			)
		);
	}
	if (results) {
		rows.push(
			row(
				'results',
				`${formatCount(results.count)} saved · data.db ${formatBytes(results.dbBytes)} ${out.out.dim(
					`('${BIN} worker results' · never deleted automatically — '${BIN} worker results prune')`
				)}`
			)
		);
	}
	rows.push(
		row(
			'logs',
			`${formatCount(usage.logs.files)} file(s) · ${formatBytes(usage.logs.bytes)} ${out.out.dim(`('${BIN} logs')`)}`
		)
	);
	return rows;
}

/**
 * status when the server is unreachable — only what this PC knows. Quota is the last server response's value and its time; host is cached
 */
function offlineStatus(
	ctx: CommandContext,
	session: Session,
	token: HostToken,
	overrides: Overrides,
	err: Error
): void {
	const { out } = ctx;
	const now = ctx.now();
	const runner = readRunner(ctx.dirs.data);
	const board = readDashboard(ctx.dirs.data);
	let cached: { id: string; name: string } | null = null;
	let last: ReturnType<Session['db']['getQuota']> = null;
	try {
		const id = session.db.getMeta(HOST_META.id);
		const name = session.db.getMeta(HOST_META.name);
		cached = id && name ? { id, name } : null;
		last = session.db.getQuota();
	} catch {
		// just skip the display
	}
	const results = savedResults(session.config.projectRoot);
	const usage = hostUsage(session.db, ctx.dirs.logs);
	const repeats = readRepeats(session.db, session.config.projectRoot);
	// Receive mode and connection state are local, so they show without the server — most needed during network outages (#1462)
	const running = runner.state === 'running' ? runner.info : null;
	const shell = session.config.values;
	const mode = running ? runnerMode(running) : shell.receiveMode;
	const concurrency = running?.concurrency ?? shell.concurrency;
	const liveState = running && mode === 'live' ? readLiveState(session.db) : null;
	const intervalMs = mode === 'poll' ? (running?.intervalMs ?? shell.pollIntervalMs) : null;
	out.warn(`cannot reach 3Min API (${err.message}) — showing what this PC knows.`);
	out.result(
		{
			loggedIn: true,
			offline: true,
			error: err.message,
			token: { source: token.source, location: token.location },
			apiUrl: session.config.values.apiUrl,
			host: cached,
			lastQuota: last && { ...last.quota, at: new Date(last.at).toISOString() },
			mode,
			pollIntervalMs: intervalMs,
			liveState,
			running: runner.state === 'running',
			runner: runner.state === 'running' ? runner.info : null,
			repeats,
			dashboard: dashboardJson(board),
			results,
			usage: usageJson(usage, session.config.projectRoot, results),
			overrides,
			// Based on the last received recommended version — the notice line is shown only when the server was reached
			update: updateInfo(ctx.version, readLatest(session.db), runner.state === 'running')
		},
		[
			row(
				'host',
				cached
					? `${cached.name} ${out.out.dim(`(${cached.id}) · last known`)}`
					: out.out.dim('unknown')
			),
			row(
				'token',
				token.source === 'env' ? `from ${token.location}` : `saved in ${token.location}`
			),
			...overrideRows(out, overrides),
			row('remote', `${session.config.values.apiUrl} ${out.out.yellow('(not reachable)')}`),
			last
				? row(
						'quota',
						`${formatCount(last.quota.used)} / ${formatCount(last.quota.limit)} calls used ${out.out.dim(
							`· last checked ${formatLocal(last.at)} (${relative(last.at, now)}) · resets ${describeAt(last.quota.reset_at, now, { local: true })}`
						)}`
					)
				: row('quota', out.out.dim('unknown — no server response saved yet')),
			intervalMs === null
				? row('mode', liveText(out, running !== null, liveState, concurrency, now))
				: row(
						'poll',
						`every ${secs(intervalMs)}${running ? '' : ' when started'} ${out.out.dim('(setting — the server minimum is not known offline)')}`
					),
			row('runner', runnerText(out, runner, now, null)),
			...repeatRows(
				out,
				repeats,
				(runner.state === 'running' ? runner.info.concurrency : undefined) ??
					session.config.values.concurrency,
				runner.state === 'running'
			),
			row('dashboard', dashboardText(out, board, now)),
			...storageRows(out, usage, results)
		].join('\n')
	);
}

/** Active recurring tasks — read from the control DB (visible while the runner is off). Read failure gives an empty list */
interface RepeatInfo {
	task_id: string;
	worker: string;
	runs: number;
	failed: number;
	/** null = until cancelled */
	max_runs: number | null;
	interval_seconds: number;
	/** Next run due — ISO UTC. null if not yet scheduled */
	next_at: string | null;
	/** Run rows stored in data.db — never auto-deleted, so they accumulate. null if unreadable */
	results: number | null;
}

function readRepeats(db: ControlDb, root: string | null): RepeatInfo[] {
	let rows;
	try {
		rows = db.repeatTasks();
	} catch {
		return [];
	}
	// Result rows per recurrence — shows what accumulates without auto-delete (docs/design/15_cli.md §8-5)
	const saved = savedRuns(
		root,
		rows.map((r) => r.task_id)
	);
	return rows.flatMap((row) => {
		const settings = parseSettings(row.repeat);
		if (!settings) return [];
		return [
			{
				task_id: row.task_id,
				worker: row.worker,
				runs: row.runs ?? 0,
				failed: row.failed ?? 0,
				max_runs: settings.max_runs ?? null,
				interval_seconds: settings.interval_seconds,
				next_at: row.next_at == null ? null : new Date(row.next_at).toISOString(),
				results: saved === null ? null : (saved.get(row.task_id)?.runs ?? 0)
			}
		];
	});
}

/** Stored run rows per recurrence — as in savedResults, read failure (including a data.db before rebuild) is null */
function savedRuns(
	root: string | null,
	ids: string[]
): Map<string, { runs: number; lastRunNo: number }> | null {
	if (!root || ids.length === 0 || resultsDbBytes(root) === null) return null;
	try {
		const store = ResultStore.openReadOnly(root);
		if (!store) return new Map();
		try {
			return store.runCounts(ids);
		} finally {
			store.close();
		}
	} catch {
		return null;
	}
}

/** `12/100`; unlimited is `12/∞`. Runs share the slots (concurrency) with one-off tasks */
function repeatRows(
	out: OutputPort,
	repeats: RepeatInfo[],
	concurrency: number,
	running: boolean
): string[] {
	if (repeats.length === 0) return [];
	return [
		row(
			'repeating',
			`${repeats.length} ${out.out.dim(`· runs share the ${concurrency} slot(s) with single tasks`)}`
		),
		...repeats.map((r) => {
			const failed = r.failed > 0 ? `, ${r.failed} failed` : '';
			const next =
				!running || r.next_at === null
					? `resumes on '${BIN} start'`
					: `next ${formatLocal(Date.parse(r.next_at))}`;
			return row(
				'',
				`${r.worker}  ${r.task_id.length > 13 ? r.task_id.slice(-12) : r.task_id}  ` +
					`${r.runs}/${r.max_runs ?? '∞'}${failed} ${out.out.dim(
						`· every ${r.interval_seconds}s · ${next}` +
							(r.results === null ? '' : ` · ${formatCount(r.results)} result row(s) saved`)
					)}`
			);
		})
	];
}

function quotaLine(out: OutputPort, host: HostResponse, now: number): string {
	const { used, limit, reset_at } = host.quota;
	const when = describeAt(reset_at, now, { local: true });
	const usage = `${formatCount(used)} / ${formatCount(limit)} calls used`;
	return row('quota', `${usage} ${out.out.dim(`· resets ${when}`)}`);
}

function runnerText(
	out: OutputPort,
	runner: RunnerState,
	now: number,
	lastEnd: EndRecord | null
): string {
	if (runner.state === 'starting') return 'starting';
	if (runner.state === 'stopped' && lastEnd) {
		const deleted = lastEnd.deletedWorkers;
		const why =
			deleted.length > 0
				? `${deleted.join(', ')} ${deleted.length === 1 ? 'was' : 'were'} deleted on the server`
				: 'no worker could be registered';
		return (
			`not running ${out.out.dim(`· ended ${formatLocal(lastEnd.endedAt)} with no active workers (${why})`)}\n` +
			row('', out.out.dim(`'${BIN} start' registers the workers whose files are still there`))
		);
	}
	if (runner.state === 'stopped') return `not running ${out.out.dim(`· '${BIN} start' to run`)}`;
	const { pid, startedAt, detached } = runner.info;
	const where = detached ? 'in the background' : 'in a terminal';
	return `running ${where} (pid ${pid}) ${out.out.dim(`· since ${formatLocal(startedAt)} (${relative(startedAt, now)})`)}`;
}

/** Past times only — `relative` returns "in …" when the difference is zero or in the future */
function elapsed(since: number, now: number): string {
	const ago = relative(Math.min(since, now), now);
	return ago.endsWith(' ago') ? ago.slice(0, -' ago'.length) : 'less than a minute';
}

function readLiveState(db: ControlDb): LiveState | null {
	try {
		return db.getLiveState();
	} catch {
		return null;
	}
}

/**
 * live row — connection state, time since, reconnect count, last reason. Surfaces failure (there is no fallback polling): if it
 * never connected in this run, points to doctor and `--mode poll`. Even when connected, tasks are pulled only on a signal — a
 * worker deleted on the server is turned off at the next pull (#1462)
 */
function liveText(
	out: OutputPort,
	running: boolean,
	state: LiveState | null,
	concurrency: number,
	now: number
): string {
	const what = `live, up to ${concurrency} at a time ${out.out.dim('· fetches when 3Min API signals; idle ≈ 0 calls')}`;
	if (!running) return `${what} ${out.out.dim('(when started)')}`;
	if (state === null || state.since === null) return `${what}\n${row('', 'connecting…')}`;
	// Written by another process (the runner) — if clock skew puts it in the future, treat it as now
	const since = Math.min(Date.parse(state.since), now);
	const reconnects =
		state.reconnects > 0
			? ` · ${state.reconnects} reconnect${state.reconnects === 1 ? '' : 's'}`
			: '';
	if (state.connected) {
		return `${what}\n${row('', `${out.out.green('connected')} ${out.out.dim(`since ${formatLocal(since)} (${relative(since, now)})${reconnects}`)}`)}`;
	}
	const lines = [
		`${out.out.yellow('disconnected')} for ${elapsed(since, now)} ${out.out.dim(`— no tasks are fetched until it reconnects${reconnects}`)}`,
		...(state.lastError ? [out.out.dim(state.lastError)] : []),
		...(state.everConnected
			? []
			: [
					`never connected this run — on a company network, run '${BIN} doctor' or restart with '${BIN} start --mode poll'`
				])
	];
	return [what, ...lines.map((l) => row('', l))].join('\n');
}

/** Running dashboard. The lock holds no token — the link comes from `dashboard url` */
function dashboardJson(board: DashboardState) {
	return {
		running: board.state === 'running',
		info: board.state === 'running' ? board.info : null
	};
}

function dashboardText(out: OutputPort, board: DashboardState, now: number): string {
	if (board.state === 'starting') return 'starting';
	if (board.state === 'stopped')
		return `not running ${out.out.dim(`· '${BIN} dashboard' to open`)}`;
	const { pid, startedAt, detached, lan, origins } = board.info;
	const where = detached ? 'in the background' : 'in a terminal';
	const scope = lan ? ` · ${out.out.yellow('LAN (plain HTTP)')}` : '';
	const address = origins.length > 0 ? ` · ${origins[lan && origins.length > 1 ? 1 : 0]}` : '';
	return (
		`running ${where} (pid ${pid})${scope}${address} ${out.out.dim(`· since ${formatLocal(startedAt)} (${relative(startedAt, now)})`)}\n` +
		row('', out.out.dim(`'${BIN} dashboard url' for the link · '${BIN} dashboard stop' to stop`))
	);
}

/** The local server of `start --serve`. Locks without `public` (0.2 and earlier) show only the port */
function serveText(
	out: OutputPort,
	port: number,
	isPublic: boolean | undefined,
	configDir: string
): string {
	if (isPublic === undefined) return `port ${port}`;
	if (isPublic)
		return `port ${port} on all interfaces ${out.out.dim('(public workers, signed requests only)')}`;
	return `http://127.0.0.1:${port} ${out.out.dim(`(token in ${path.join(configDir, LOCAL_SERVER_TOKEN_FILE)})`)}`;
}

/** 5000 → 5s, 1500 → 1500 ms */
function secs(ms: number): string {
	return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms} ms`;
}

/** Absolute path of the project's workers folder; null outside a project */
function projectWorkersDir(config: ResolvedConfig): string | null {
	return config.projectRoot ? workersPath(config.projectRoot, config) : null;
}

/** Worker names in the folder (not imported). null if the folder is missing or unreadable */
function workerNamesIn(dir: string): string[] | null {
	if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return null;
	try {
		return [...workerFiles(dir).keys()];
	} catch {
		return null;
	}
}

/**
 * Saved results in this project's data.db (docs/design/15_cli.md §8-5) — read-only, creates no tables. null outside a project
 * or when the file is missing; a read failure just skips the display
 */
function savedResults(
	root: string | null
): { count: number; bytes: number; dbBytes: number } | null {
	if (!root) return null;
	const dbBytes = resultsDbBytes(root);
	if (dbBytes === null) return null;
	try {
		const store = ResultStore.openReadOnly(root);
		if (!store) return { count: 0, bytes: 0, dbBytes };
		try {
			return { ...store.usage(), dbBytes };
		} finally {
			store.close();
		}
	} catch {
		return null;
	}
}

/** Whether the last start ended with 0 active workers — a read failure just skips the display */
function readEnd(session: Session): EndRecord | null {
	try {
		return session.db.getEnd();
	} catch {
		return null;
	}
}

/** Longest label (`dashboard`, 9 chars) + a 2-space gap — a label filling the column would touch its value */
const STATUS_LABEL_WIDTH = 11;

function row(label: string, value: string): string {
	return `${label.padEnd(STATUS_LABEL_WIDTH)}${value}`;
}

function warnLooseToken(out: OutputPort, token: HostToken): void {
	if (token.source !== 'file') return;
	const mode = looseMode(token.location);
	if (mode !== null) {
		out.warn(
			`${token.location} is readable by other users (mode ${mode.toString(8)}). Run: chmod 600 "${token.location}"`
		);
	}
}
