/**
 * Local dashboard server (docs/design/15_cli.md §9) — binds 127.0.0.1 and accepts only GET and HEAD. No 3Min API traffic.
 * LAN mode binds 0.0.0.0 — plain HTTP, so the command opens it only after a warning and consent (docs/design/15_cli.md §9-6).
 *
 *   /                 Overview      ?range=today|7d|30d
 *   /runs             Runs          ?range&worker&state&after&no (after = keyset cursor, no = first row number)
 *   /runs/<task_id>   Run detail    one-off: ?path&offset (slice of a large result). Recurring: run list ?runs_before (run_no keyset)
 *                                   — legacy `?run=N` redirects 303 to the run detail
 *   /runs/<task_id>/<run_no>  run detail of a recurring task  ?path&offset. One-off → 303 to /runs/<task_id>
 *   /workers          Workers
 *   /workers/<name>   worker file text
 *   /logs             Logs          ?channel&level&n
 *   /assets/app.css · /assets/app.js
 *
 * Request checks are in guard.ts. The first request must carry `?token=`; if valid, an HttpOnly cookie is set and it redirects to the token-free URL.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CliError, UsageError } from '../../core/domain/index.ts';
import { APP_CSS, APP_JS } from './assets.ts';
import {
	LOG_LEVELS,
	RANGES,
	RUN_RANGES,
	RUN_STATES,
	decodeCursor,
	hostName,
	knownWorkers,
	listRuns,
	logChannels,
	overview,
	isRepeat,
	readLog,
	repeatRuns,
	runDetail,
	runLog,
	runOfTask,
	taskLog,
	workerSource,
	workersView,
	type LevelFilter,
	type Range,
	type Run,
	type RunState,
	type Sources,
	type TaskLog
} from './data.ts';
import {
	checkRequest,
	cookieName,
	isRemoteViewer,
	lanNames,
	readCookie,
	tokenMatches
} from './guard.ts';
import { shortTaskId, type Html, type ViewContext } from './views/html.ts';
import { layout, message, type PageOptions } from './views/layout.ts';
import { LOG_LINE_CHOICES, logsPage } from './views/logs.ts';
import { overviewPage } from './views/overview.ts';
import { repeatPage, runOfTaskPage, runPage, runsPage } from './views/runs.ts';
import { workerCodePage, workersPage } from './views/workers.ts';

/** One Runs page — the rest via "Older" */
export const RUNS_PAGE_LIMIT = 100;
export const REFRESH_MS = 5_000;
/** Overview aggregates the whole period (about 0.4 s for 30 days / 600k rows) — refreshed less often than lists */
export const OVERVIEW_REFRESH_MS = 15_000;

export interface DashboardOptions extends Sources {
	/** 0 = any free port */
	port: number;
	version: string;
	/** Fixed by tests. Otherwise generated per run */
	token?: string;
	/**
	 * Errors while handling a request — short on screen, full detail here (the command writes it to the terminal), including auto-refresh errors
	 */
	onError?(err: unknown, url: string): void;
	/** Also accept other devices on the local network — binds 0.0.0.0 */
	lan?: boolean;
	/** Fixed by tests. Otherwise this PC's LAN IPv4 and hostname (guard.ts `lanNames`) */
	lanNames?: () => string[];
	/** Tests pin it to 127.0.0.1 — binding 0.0.0.0 makes macOS and Windows show an incoming-connection prompt */
	listenHost?: string;
	/**
	 * Access log — token exchanges (cookie issued) and rejections (Host/Origin 403, token 401). Routine requests like auto refresh are not passed.
	 * `path` never includes the query — the token arrives in the query
	 */
	onAccess?(event: AccessEvent): void;
}

export interface AccessEvent {
	kind: 'granted' | 'denied';
	status: number;
	remote: string | undefined;
	host: string | undefined;
	path: string;
}

export interface Dashboard {
	/** Tokenized URL for this PC (127.0.0.1) — the one to open in a browser */
	url: string;
	/** URL without token */
	origin: string;
	/** Links for other devices (with token) — LAN mode only, otherwise empty */
	lanUrls: string[];
	/** Token-free URLs for other devices — recorded in status and the lock file */
	lanOrigins: string[];
	port: number;
	close(): Promise<void>;
}

interface Reply {
	status: number;
	type: string;
	body: string;
	headers?: Record<string, string>;
}

/** CSP — scripts and styles from same origin ('self') only (served only from /assets), no inline scripts or style attributes, nothing sent cross-origin */
const SECURITY_HEADERS: Record<string, string> = {
	'Content-Security-Policy':
		"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
	'X-Content-Type-Options': 'nosniff',
	'X-Frame-Options': 'DENY',
	'Referrer-Policy': 'no-referrer',
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Resource-Policy': 'same-origin',
	'Cache-Control': 'no-store'
};

export async function startDashboard(opts: DashboardOptions): Promise<Dashboard> {
	const token = opts.token ?? randomBytes(32).toString('hex');
	const bindAddress = opts.listenHost ?? (opts.lan ? '0.0.0.0' : '127.0.0.1');
	let port = 0;
	const server = createServer((req, res) => {
		let reply: Reply;
		// Filled by handle — remote after the guard, host after the token check
		const ctx: PageContext = { host: null, remote: true, lan: opts.lan === true };
		try {
			reply = handle(opts, token, port, req, ctx);
		} catch (err) {
			opts.onError?.(err, req.url ?? '/');
			// CliError is a user-fixable message (path, action). Anything else is a bug — details go to the terminal
			reply = page(
				ctx,
				opts,
				500,
				'Error',
				null,
				err instanceof CliError
					? message('Something went wrong', err.message)
					: message(
							'Unexpected error',
							`This is a bug in the CLI — the details are in the terminal running 3minapi dashboard${terminalWhere(ctx)}.`
						)
			);
		}
		send(req, res, reply);
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(opts.port, bindAddress, () => {
			server.off('error', reject);
			resolve();
		});
	}).catch((err: NodeJS.ErrnoException) => {
		// A user-fixable failure — must not look like a CLI bug
		if (err.code === 'EADDRINUSE') {
			throw new UsageError(`port ${opts.port} is already in use — pick another with --port`);
		}
		if (err.code === 'EACCES') {
			throw new UsageError(
				`cannot listen on port ${opts.port}: permission denied — pick a port above 1023 with --port`
			);
		}
		throw new CliError(`cannot start the dashboard on ${bindAddress}:${opts.port}: ${err.message}`);
	});
	port = (server.address() as AddressInfo).port;
	const origin = `http://127.0.0.1:${port}`;
	// A bare-hostname URL (`http://mac:port`) often doesn't resolve on the LAN — show only IPs and .local
	const lanOrigins = opts.lan
		? (opts.lanNames ?? lanNames)()
				.filter((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name) || name.endsWith('.local'))
				.map((name) => `http://${name}:${port}`)
		: [];
	return {
		url: `${origin}/?token=${token}`,
		origin,
		lanUrls: lanOrigins.map((o) => `${o}/?token=${token}`),
		lanOrigins,
		port,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			})
	};
}

function handle(
	opts: DashboardOptions,
	token: string,
	port: number,
	req: IncomingMessage,
	pageCtx: PageContext
): Reply {
	const access = (kind: AccessEvent['kind'], status: number) => {
		let path = '/';
		try {
			path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
		} catch {
			// Log even if the path can't be parsed
		}
		opts.onAccess?.({
			kind,
			status,
			remote: req.socket.remoteAddress,
			host: req.headers.host,
			path
		});
	};
	const denied = checkRequest(
		{
			method: req.method,
			host: req.headers.host,
			origin: req.headers.origin,
			secFetchSite: header(req, 'sec-fetch-site')
		},
		port,
		{ lan: opts.lan, lanNames: opts.lanNames }
	);
	if (denied) {
		if (denied.status === 403) access('denied', 403);
		return text(denied.status, denied.message);
	}
	pageCtx.remote = isRemoteViewer(
		{ host: req.headers.host, remoteAddress: req.socket.remoteAddress },
		port
	);

	const url = new URL(req.url ?? '/', 'http://127.0.0.1');
	const cookie = cookieName(port);

	// Favicon the browser requests on its own — it may come without the cookie, and a 401 would log a rejection per normal visit in LAN mode. The empty response exposes nothing
	if (url.pathname === '/favicon.ico')
		return { status: 204, type: 'text/plain; charset=utf-8', body: '' };

	// Arrived with a token — if valid, swap it for a cookie and drop it from the address bar
	const given = url.searchParams.get('token');
	if (given !== null) {
		if (!tokenMatches(given, token)) {
			access('denied', 401);
			return unauthorized(pageCtx, opts);
		}
		access('granted', 303);
		url.searchParams.delete('token');
		return {
			status: 303,
			type: 'text/plain; charset=utf-8',
			body: '',
			headers: {
				Location: `${url.pathname}${url.search}`,
				'Set-Cookie': `${cookie}=${token}; Path=/; HttpOnly; SameSite=Strict`
			}
		};
	}
	if (!tokenMatches(readCookie(req.headers.cookie, cookie), token)) {
		access('denied', 401);
		return unauthorized(pageCtx, opts);
	}

	const path = url.pathname;
	const q = url.searchParams;
	if (path === '/assets/app.css')
		return { status: 200, type: 'text/css; charset=utf-8', body: APP_CSS };
	if (path === '/assets/app.js')
		return { status: 200, type: 'text/javascript; charset=utf-8', body: APP_JS };

	// Only after auth and when rendering a view — the host name isn't shown to token-less visitors, and the DB isn't opened for those requests or static files
	const ctx: ViewContext = { ...pageCtx, host: hostName(opts) };
	pageCtx.host = ctx.host;

	if (path === '/') {
		const range = pick(q.get('range'), RANGES, '7d');
		return page(
			ctx,
			opts,
			200,
			'Overview',
			'overview',
			overviewPage(overview(opts, range), opts.now(), ctx),
			true
		);
	}
	if (path === '/runs') {
		const range = pick(q.get('range'), RUN_RANGES, '7d');
		const state = pick<RunState | undefined>(q.get('state'), RUN_STATES, undefined);
		const worker = q.get('worker') || undefined;
		const after = decodeCursor(q.get('after'));
		const filter = { range, ...(state ? { state } : {}), ...(worker ? { worker } : {}) };
		const { runs, next } = listRuns(opts, filter, RUNS_PAGE_LIMIT, after);
		const workers = knownWorkers(opts);
		if (worker && !workers.includes(worker)) workers.push(worker);
		// Auto refresh on the first page only — older pages don't change while being read
		return page(
			ctx,
			opts,
			200,
			'Runs',
			'runs',
			runsPage(
				{ runs, next, paged: after !== null, firstNo: after ? firstNo(q.get('no')) : 1 },
				filter,
				workers,
				ctx
			),
			after === null
		);
	}
	const run = /^\/runs\/([^/]+)(?:\/(\d+))?$/.exec(path);
	if (run && decodePart(run[1]) !== null) {
		const taskId = decodePart(run[1])!;
		const base = `/runs/${encodeURIComponent(taskId)}`;
		const runNo = run[2] !== undefined ? positive(run[2]) : undefined;
		if (run[2] !== undefined) {
			if (runNo === undefined) return notFound(ctx, opts);
			// One URL per run — `/007` redirects to `/7` (keeping the slice position)
			if (run[2] !== String(runNo)) return redirect(`${base}/${runNo}${q.size > 0 ? `?${q}` : ''}`);
		}
		// Legacy run URL (`?run=N`) — redirect to the run detail, keeping the slice position
		const legacy = runNo === undefined ? positive(q.get('run')) : undefined;
		if (legacy !== undefined) {
			q.delete('run');
			q.delete('runs_before');
			return redirect(`${base}/${legacy}${q.size > 0 ? `?${q}` : ''}`);
		}
		const detail = runDetail(opts, taskId);
		if (!detail) {
			return page(
				ctx,
				opts,
				404,
				'Not found',
				'runs',
				message(
					'Run not found',
					`No task ${taskId} in the history or saved results on host ${ctx.host}.`
				)
			);
		}
		const offset = Number(q.get('offset') ?? 0);
		const view = {
			path: q.get('path') || '$',
			offset: Number.isInteger(offset) && offset >= 0 ? offset : 0
		};
		const repeat = isRepeat(detail.run);
		if (!repeat) {
			// One-off tasks have no run URLs — go to the task
			if (runNo !== undefined) return redirect(base);
			return page(
				ctx,
				opts,
				200,
				`Run ${shortTaskId(taskId)}`,
				'runs',
				runPage(
					detail,
					view,
					taskLogSection(opts, detail.run, () => taskLog(opts, detail.run)),
					ctx
				)
			);
		}
		if (runNo !== undefined) {
			const one = runOfTask(opts, detail.run, runNo);
			const log = one.result
				? taskLogSection(opts, detail.run, () =>
						runLog(opts, detail.run, runNo, one.from, Date.parse(one.result!.created_at))
					)
				: null;
			return page(
				ctx,
				opts,
				200,
				`Run ${shortTaskId(taskId)} · ${runNo}`,
				'runs',
				runOfTaskPage(detail.run, runNo, one, view, log, ctx)
			);
		}
		const runsBefore = positive(q.get('runs_before'));
		// Auto refresh only on the first page of an active recurrence — new runs appear on top. Older pages don't change while being read
		return page(
			ctx,
			opts,
			200,
			`Run ${shortTaskId(taskId)}`,
			'runs',
			repeatPage(detail.run, repeatRuns(opts, taskId, runsBefore), runsBefore !== undefined, ctx),
			runsBefore === undefined && detail.run.state === 'running'
		);
	}
	if (path === '/workers') {
		return page(ctx, opts, 200, 'Workers', 'workers', workersPage(workersView(opts), ctx), true);
	}
	const worker = /^\/workers\/([^/]+)$/.exec(path);
	if (worker && decodePart(worker[1]) !== null) {
		const name = decodePart(worker[1])!;
		const files = workerSource(opts, name);
		if (!files) {
			return page(
				ctx,
				opts,
				404,
				'Not found',
				'workers',
				message('Worker not found', `No worker file named ${name} in the workers folder.`)
			);
		}
		return page(ctx, opts, 200, name, 'workers', workerCodePage(name, files, ctx));
	}
	if (path === '/logs') {
		const channels = logChannels(opts);
		const raw = q.get('channel') || null;
		// This value becomes a log folder name — existing channels only (path traversal). An unknown channel (old bookmark etc.) is
		// reported as such rather than silently swapped for the app log
		const unknown = raw !== null && !channels.includes(raw) ? raw : null;
		const channel = unknown === null ? raw : null;
		const level = pick<LevelFilter>(q.get('level'), LOG_LEVELS, 'debug');
		const count = pick(Number(q.get('n')), LOG_LINE_CHOICES, LOG_LINE_CHOICES[0]);
		const read = readLog(opts, channel, { lines: count, minLevel: level });
		return page(
			ctx,
			opts,
			200,
			'Logs',
			'logs',
			unknown === null
				? logsPage(read, { channel, channels, level, count }, ctx)
				: message('No such log', `No log for worker ${unknown} on host ${ctx.host}.`),
			true
		);
	}
	return notFound(ctx, opts);
}

function notFound(ctx: PageContext, opts: DashboardOptions): Reply {
	return page(ctx, opts, 404, 'Not found', null, message('Not found', 'There is no page here.'));
}

/** Same-origin redirect — used only after auth */
function redirect(location: string): Reply {
	return {
		status: 303,
		type: 'text/plain; charset=utf-8',
		body: '',
		headers: { Location: location }
	};
}

/** Path segment — malformed percent-encoding (`%E0`) gives null (→ 404). A client input error must not look like a 500/bug */
function decodePart(raw: string): string | null {
	try {
		return decodeURIComponent(raw);
	} catch {
		return null;
	}
}

/** Safe integer ≥ 1 (query or path value), else undefined. Larger values stringify as `1e+21` and break the URL */
function positive(raw: string | null): number | undefined {
	if (raw === null || raw === '') return undefined;
	const n = Number(raw);
	return Number.isSafeInteger(n) && n >= 1 ? n : undefined;
}

/** First row number of the next page — display only, so odd values become 1 */
function firstNo(raw: string | null): number {
	const n = Number(raw);
	return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** Log section of run detail — on a log read failure (permissions etc.) only this section fails, so the result still shows. Cause goes to the terminal */
function taskLogSection(opts: DashboardOptions, run: Run, read: () => TaskLog): TaskLog {
	try {
		return read();
	} catch (err) {
		opts.onError?.(err, `/runs/${run.task_id} (log)`);
		return { lines: [], deleted: false, error: (err as Error)?.message ?? String(err) };
	}
}

function pick<T>(value: unknown, choices: readonly T[], fallback: T): T {
	return (choices as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

function header(req: IncomingMessage, name: string): string | undefined {
	const v = req.headers[name];
	return Array.isArray(v) ? v[0] : v;
}

/** View info — filled while handling the request. host only after auth (no name on a 401 or a 500 before it) */
type PageContext = PageOptions['ctx'];

function page(
	ctx: PageContext,
	opts: DashboardOptions,
	status: number,
	title: string,
	section: PageOptions['section'],
	body: Html,
	refresh = false
): Reply {
	const refreshMs = section === 'overview' ? OVERVIEW_REFRESH_MS : REFRESH_MS;
	return {
		status,
		type: 'text/html; charset=utf-8',
		body: layout({ title, section, version: opts.version, refresh, refreshMs, ctx }, body).value
	};
}

/** For remote viewers, say whose terminal it is — the viewing device doesn't have it */
function terminalWhere(ctx: PageContext): string {
	if (!ctx.remote) return '';
	return ctx.host !== null ? ` on host ${ctx.host}` : ' on the computer running the dashboard';
}

function unauthorized(ctx: PageContext, opts: DashboardOptions): Reply {
	return page(
		ctx,
		opts,
		401,
		'Sign in',
		null,
		message(
			'Open the link from the terminal',
			`This dashboard needs the link that 3minapi dashboard printed — it works for that run only. Each run makes a new link; ${ctx.remote ? 'on the computer running the dashboard, ' : ''}3minapi dashboard url prints it again.`
		)
	);
}

function text(status: number, body: string): Reply {
	return { status, type: 'text/plain; charset=utf-8', body };
}

function send(req: IncomingMessage, res: ServerResponse, reply: Reply): void {
	res.writeHead(reply.status, {
		...SECURITY_HEADERS,
		'Content-Type': reply.type,
		'Content-Length': Buffer.byteLength(reply.body),
		...reply.headers
	});
	res.end(req.method === 'HEAD' ? undefined : reply.body);
}
