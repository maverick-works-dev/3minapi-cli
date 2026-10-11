/**
 * `dashboard` — a web view that only reads the local DBs and logs (docs/design/15_cli.md §9). No server traffic.
 * Separate from `start` — history is visible while start is off. Both DBs use WAL, so read connections don't block a running start.
 *
 * `--lan` serves plain HTTP to the local network — only after a warning and consent (`[y/N]`; `--yes` when non-TTY or `--json`).
 * `--detach` runs in the background, `dashboard url` shows the link again, `dashboard stop` ends it. One per host (lock — modules/dashboard/lock.ts).
 * See docs/design/15_cli.md §9-6.
 */
import path from 'node:path';
import {
	APP_LOG_DIR,
	BIN,
	CliError,
	DASHBOARD_OUT_FILE,
	DETACH_READY_MS,
	ENV,
	ExitCode,
	STOP_CHECK_INTERVAL_MS,
	UsageError,
	type Command,
	type CommandContext
} from '../core/domain/index.ts';
import { outputTail, spawnDetached } from '../core/host/detach.ts';
import { Logger, pruneLogs } from '../core/logger.ts';
import { openBrowser } from '../core/open-browser.ts';
import { confirm } from '../core/prompt.ts';
import { sleep } from '../core/time.ts';
import {
	acquireDashboardLock,
	dashboardLockPath,
	readDashboard,
	readDashboardLinks,
	readDashboardSettled,
	requestDashboardStop,
	type DashboardInfo,
	type DashboardLinks
} from '../modules/dashboard/lock.ts';
import { startDashboard, type AccessEvent } from '../modules/dashboard/server.ts';
import { workersPath } from './common.ts';
import { stopLocked } from './stop.ts';
import { initHint } from '../core/project.ts';

/** `--lan` warning — printed to stderr even with `--yes`, so there is a record of what was consented to */
const LAN_WARNING = [
	'--lan opens the dashboard to other devices on this network over plain HTTP (not encrypted).',
	'  Saved results (they may contain personal data), logs and the access link travel in clear text.',
	'  Use it only on a network you trust, such as your home or office — not on public or shared Wi-Fi.',
	'  Anyone with the link can see the dashboard: do not share it. If it may have leaked, run',
	`  '${BIN} dashboard stop' and start again — every run makes a new link.`,
	'  macOS and Windows may ask whether to allow incoming connections: allow them, or other devices',
	'  cannot connect. On Linux, a firewall (ufw, firewalld) may need the port opened.'
].join('\n');

export const dashboard: Command = {
	name: 'dashboard',
	summary: 'Open a local, read-only web view of runs, results, workers and logs',
	usage: '[stop | url] [--port <port>] [--no-open] [--lan [--yes]] [--detach]',
	description:
		'Serves a page on 127.0.0.1 and opens it in your browser with a link that works for this run only.\n' +
		'It reads the task history, the results saved in data.db and the logs on this PC — nothing is sent anywhere,\n' +
		`and nothing is changed: use the CLI for that (the page shows the commands). Works while '${BIN} start' is running or not.\n` +
		'Press Ctrl+C to stop it. Only one can run per host.\n' +
		'\n' +
		'--lan also opens it to other devices on the same network (another PC or a phone on your Wi-Fi) over\n' +
		'plain HTTP, which is not encrypted. It shows a warning and asks first; pass --yes to skip the question\n' +
		'(scripts and AI agents — without a terminal, --lan needs --yes). Use it only on a network you trust.\n' +
		'\n' +
		'--detach keeps it running in the background after the terminal is closed.\n' +
		`'${BIN} dashboard url' prints the link again, '${BIN} dashboard stop' ends it, and '${BIN} status' shows it.`,
	options: {
		port: {
			type: 'string',
			valueName: 'port',
			description: 'Port to listen on (default: any free port)'
		},
		open: {
			type: 'boolean',
			negated: true,
			description: 'Print the link without opening a browser'
		},
		lan: {
			type: 'boolean',
			description: 'Also serve other devices on this network (plain HTTP — asks first)'
		},
		yes: {
			type: 'boolean',
			short: 'y',
			description: 'Agree to the --lan warning without asking (scripts, AI agents)'
		},
		detach: {
			type: 'boolean',
			short: 'd',
			description: `Run in the background (stop with '${BIN} dashboard stop')`
		}
	},
	args: { min: 0, max: 1 },
	async run(ctx) {
		const action = ctx.positionals[0];
		if (action !== undefined) {
			if (action !== 'stop' && action !== 'url') {
				throw new UsageError(
					`unknown dashboard action "${action}" — use '${BIN} dashboard stop' or '${BIN} dashboard url'`
				);
			}
			const { values } = ctx;
			if (values.port !== undefined || values.lan || values.detach || values.yes) {
				throw new UsageError(`'${BIN} dashboard ${action}' takes no options`);
			}
			return action === 'stop' ? stopDashboard(ctx) : printUrl(ctx);
		}

		const port = parsePort(ctx.values.port);
		const lan = Boolean(ctx.values.lan);
		const child = ctx.env[ENV.detached] === '1';
		// When detached, the parent asks — the child has no terminal (the parent passes --yes)
		if (lan && !child) await agreeToLan(ctx);
		if (ctx.values.detach && !child) return startDetached(ctx, port, lan);
		return runDashboard(ctx, port, lan, child);
	}
};

// ── Foreground (= the actual run) ────────────────────────────────────

async function runDashboard(
	ctx: CommandContext,
	port: number,
	lan: boolean,
	child: boolean
): Promise<ExitCode> {
	const { out, values } = ctx;
	const config = ctx.loadConfig();
	const root = config.projectRoot;

	const lock = acquireDashboardLock(
		ctx.dirs.data,
		{ detached: child, lan, outFile: child ? outFilePath(ctx) : null },
		ctx.now()
	);
	try {
		ctx.claimInterrupt();
		const logger = lan ? accessLogger(ctx, config.values) : null;
		const dashboard = await startDashboard({
			port,
			version: ctx.version,
			dataDir: ctx.dirs.data,
			logsDir: ctx.dirs.logs,
			projectRoot: root,
			workersDir: root ? workersPath(root, config) : null,
			now: ctx.now,
			lan,
			// The screen gets a short message — the cause (stack, if a bug) is logged here
			onError: (err, url) =>
				out.warn(
					`${url}: ${err instanceof CliError ? err.message : ((err as Error)?.stack ?? String(err))}`
				),
			...(logger ? { onAccess: (e: AccessEvent) => logAccess(logger, e) } : {})
		});
		const shutdown = new AbortController();
		const onAbort = () => shutdown.abort();
		ctx.signal.addEventListener('abort', onAbort, { once: true });
		const stopWatch = setInterval(() => {
			lock.heartbeat();
			if (lock.stopRequested()) shutdown.abort();
		}, STOP_CHECK_INTERVAL_MS);
		try {
			lock.listening({
				url: dashboard.url,
				lanUrls: dashboard.lanUrls,
				port: dashboard.port,
				origins: [dashboard.origin, ...dashboard.lanOrigins]
			});
			logger?.info('dashboard started', { lan: true, port: dashboard.port, pid: process.pid });
			if (child) {
				// Detached output goes to a log file (dashboard.out) — never the token link. The parent reads it from the link file
				out.info(
					`dashboard started · pid ${process.pid} · ${lock.info.origins.join(' · ')}` +
						(lan ? ' · LAN (plain HTTP)' : '')
				);
			} else {
				out.result(
					linksJson(lock.info, dashboard),
					linksText(ctx, dashboard, lan) +
						'\n' +
						out.out.dim('Read-only. The links work for this run only. Press Ctrl+C to stop.')
				);
			}
			if (!root) {
				out.warn(
					`this host has no project — saved results and workers are not shown. ${initHint(ctx.home)}`
				);
			}
			if (!child && values.open !== false && !(await openBrowser(dashboard.url, ctx.platform))) {
				out.info('Could not open a browser — open the link above yourself.');
			}
			if (!shutdown.signal.aborted) {
				await new Promise<void>((resolve) =>
					shutdown.signal.addEventListener('abort', () => resolve(), { once: true })
				);
			}
			logger?.info('dashboard stopped', { pid: process.pid });
		} finally {
			clearInterval(stopWatch);
			ctx.signal.removeEventListener('abort', onAbort);
			await dashboard.close();
		}
	} finally {
		lock.release();
	}
	return ExitCode.Ok;
}

// ── --lan consent ─────────────────────────────────────────────

async function agreeToLan(ctx: CommandContext): Promise<void> {
	const { out } = ctx;
	out.warn(LAN_WARNING);
	if (ctx.values.yes) return;
	if (out.json || !ctx.stdin.isTTY) {
		throw new UsageError(
			`--lan serves the dashboard to your network over plain HTTP and needs agreement. Nothing was opened. Once the user has agreed, run it again with --yes.`
		);
	}
	if (!(await confirm(ctx.stdin, out, 'Open the dashboard to this network over plain HTTP?'))) {
		throw new CliError('cancelled — the dashboard was not opened.');
	}
}

// ── Access log (LAN mode only) ──────────────────────────────────────

/** Writes to the app log (`<logs>/app/`). Not via openSession, which opens the control DB for writing (the dashboard is read-only) */
function accessLogger(
	ctx: CommandContext,
	values: { logRetentionDays: number; logMaxBytes: number }
): Logger {
	return new Logger({
		dir: ctx.dirs.logs,
		now: ctx.now,
		onMaintenance(now) {
			pruneLogs({
				dir: ctx.dirs.logs,
				now,
				retentionDays: values.logRetentionDays,
				maxBytes: values.logMaxBytes
			});
		},
		onError: (message) => ctx.out.warn(message)
	});
}

/** Token exchanges and rejections only — auto-refresh is not logged. Logged paths carry no query (token) */
function logAccess(logger: Logger, e: AccessEvent): void {
	const attrs = { remote: e.remote ?? null, host: e.host ?? null, path: e.path, status: e.status };
	if (e.kind === 'granted') logger.info('dashboard access granted', attrs);
	else logger.warn('dashboard access denied', attrs);
}

// ── --detach ─────────────────────────────────────────────

async function startDetached(ctx: CommandContext, port: number, lan: boolean): Promise<ExitCode> {
	const { out, values } = ctx;
	const current = readDashboard(ctx.dirs.data);
	if (current.state === 'running') {
		throw new CliError(
			`the dashboard is already running (pid ${current.info.pid}). Only one can run per host.\n` +
				`Open it with '${BIN} dashboard url', or stop it with '${BIN} dashboard stop' first.`
		);
	}
	const args = ['dashboard', '--no-open'];
	if (port !== 0) args.push('--port', String(port));
	// The parent already obtained consent
	if (lan) args.push('--lan', '--yes');
	if (typeof values['api-url'] === 'string') args.push('--api-url', values['api-url']);
	if (typeof values.config === 'string')
		args.push('--config', path.resolve(ctx.cwd, values.config));

	const outFile = outFilePath(ctx);
	const startedAt = Date.now();
	const child = spawnDetached({ args, cwd: ctx.cwd, env: ctx.env, outFile });
	let exited: number | null = null;
	child.once('exit', (code) => (exited = code ?? 1));
	let ready: { info: DashboardInfo; links: DashboardLinks } | null = null;
	while (Date.now() - startedAt < DETACH_READY_MS && exited === null) {
		const state = readDashboard(ctx.dirs.data);
		if (state.state === 'running' && state.info.pid === child.pid && state.info.port !== null) {
			const links = readDashboardLinks(ctx.dirs.data, state.info);
			if (links) {
				ready = { info: state.info, links };
				break;
			}
		}
		await sleep(100);
	}
	child.unref();

	if (!ready) {
		if (exited === null) {
			try {
				child.kill();
			} catch {
				// already exited
			}
		}
		throw new CliError(
			`the background dashboard did not start${exited !== null ? ` (exit code ${exited})` : ''}.\n` +
				outputTail(outFile)
		);
	}

	const { info, links } = ready;
	out.result(
		{ ...linksJson(info, links), outFile },
		[
			`${out.out.green('dashboard started in the background')}  pid ${info.pid}`,
			linksText(ctx, links, info.lan),
			`output: ${outFile}`,
			`link again with '${BIN} dashboard url' · stop with '${BIN} dashboard stop'`
		].join('\n')
	);
	if (values.open !== false && !(await openBrowser(links.url, ctx.platform))) {
		out.info('Could not open a browser — open the link above yourself.');
	}
	return ExitCode.Ok;
}

// ── dashboard stop · dashboard url ─────────────────────────────

function stopDashboard(ctx: CommandContext): Promise<ExitCode> {
	return stopLocked(ctx, {
		read: () => readDashboard(ctx.dirs.data),
		readSettled: () => readDashboardSettled(ctx.dirs.data),
		requestStop: (info) => requestDashboardStop(ctx.dirs.data, info),
		lockFile: dashboardLockPath(ctx.dirs.data)
	});
}

async function printUrl(ctx: CommandContext): Promise<ExitCode> {
	const { out } = ctx;
	const current = await readDashboardSettled(ctx.dirs.data);
	const links =
		current.state === 'running' ? readDashboardLinks(ctx.dirs.data, current.info) : null;
	if (current.state !== 'running' || !links) {
		out.result({ running: false }, `Not running. Start it with '${BIN} dashboard'.`);
		return ExitCode.Failure;
	}
	out.result(linksJson(current.info, links), linksText(ctx, links, current.info.lan));
	return ExitCode.Ok;
}

// ── Output ──────────────────────────────────────────────────

function linksJson(info: DashboardInfo, links: DashboardLinks & { port?: number }) {
	return {
		url: links.url,
		port: links.port ?? info.port,
		lan: info.lan,
		lanUrls: links.lanUrls,
		pid: info.pid,
		detached: info.detached
	};
}

function linksText(ctx: CommandContext, links: DashboardLinks, lan: boolean): string {
	const lines = [`Dashboard: ${links.url}`];
	if (lan) {
		if (links.lanUrls.length === 0) {
			lines.push(
				ctx.out.out.yellow('No network address found on this PC — only this PC can open it.')
			);
		} else {
			lines.push('From other devices on this network (plain HTTP):');
			for (const url of links.lanUrls) lines.push(`  ${url}`);
		}
	}
	return lines.join('\n');
}

function outFilePath(ctx: CommandContext): string {
	return path.join(ctx.dirs.logs, APP_LOG_DIR, DASHBOARD_OUT_FILE);
}

function parsePort(raw: unknown): number {
	if (raw === undefined) return 0;
	const n = Number(raw);
	if (typeof raw !== 'string' || !Number.isInteger(n) || n < 1 || n > 65535) {
		throw new UsageError('--port must be a number from 1 to 65535');
	}
	return n;
}
