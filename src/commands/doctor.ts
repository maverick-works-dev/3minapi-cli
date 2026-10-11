import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
	BIN,
	ConfigError,
	NewerSchemaError,
	DOCTOR_API_TIMEOUT_MS,
	ENV,
	ExitCode,
	MIN_NODE_VERSION,
	PROXY_ENV_VARS,
	isTrustedLiveUrl,
	type Command,
	type CommandContext,
	type ResolvedConfig
} from '../core/domain/index.ts';
import { ControlDb, LIVE_META } from '../core/control-db.ts';
import { resolveHostToken } from '../core/credentials.ts';
import { looseMode } from '../core/secure-fs.ts';
import { satisfiesMinNode } from '../core/version.ts';
import { initHint } from '../core/project.ts';
import { recordedLatest, updateCommand, updateInfo } from '../core/update-notice.ts';
import { readRunner } from '../core/host/runner-lock.ts';

type Status = 'ok' | 'warn' | 'fail' | 'info';

interface Check {
	name: string;
	status: Status;
	detail: string;
	/** How to fix — only for warn and fail */
	fix?: string;
}

export const doctor: Command = {
	name: 'doctor',
	summary: 'Check Node.js, config, network and OS settings',
	usage: '',
	description:
		'Does not send your token anywhere and does not count against your quota. The live check\n' +
		'opens a WebSocket to the address the last start recorded, without the token.\n' +
		'Exits with code 3 if any check fails.',
	options: {},
	args: { min: 0, max: 0 },
	async run(ctx) {
		const checks: Check[] = [checkVersion(ctx), checkNode(), await checkSqlite()];

		let config: ResolvedConfig | undefined;
		try {
			config = ctx.loadConfig();
			checks.push(...checkConfig(config, ctx.home));
		} catch (err) {
			if (!(err instanceof ConfigError)) throw err;
			checks.push({ name: 'config', status: 'fail', detail: err.message });
		}

		checks.push(checkDirs(ctx), checkToken(ctx), checkProxy(ctx.env));
		if (config) checks.push(await checkApi(config), await checkLive(ctx, config));
		if (ctx.platform === 'win32') checks.push(checkExecutionPolicy());

		const failed = checks.some((c) => c.status === 'fail');
		ctx.out.result({ ok: !failed, checks }, render(checks, ctx));
		return failed ? ExitCode.Environment : ExitCode.Ok;
	}
};

/**
 * Is this CLI current — no server call; compares with the recommended version from the last `GET /host`, pull or sync.
 * An old version is a warning (not counted toward exit 3). Forced updates come from the server's `cli_outdated`. Not rate-limited (#1425)
 */
function checkVersion(ctx: CommandContext): Check {
	const name = 'version';
	let latest: string | null = null;
	try {
		const db = ControlDb.openReadOnly(ctx.dirs.data);
		try {
			latest = db ? recordedLatest(db) : null;
		} finally {
			db?.close();
		}
	} catch (err) {
		// No record differs from an unreadable one (as in checkLive). A DB made by a newer CLI is the clearest sign this CLI
		// is old, so suggest updating. Locks, permissions and corruption aren't fixed by updating — show the cause only
		if (err instanceof NewerSchemaError) {
			return { name, status: 'warn', detail: err.message, fix: `Run: ${updateCommand()}` };
		}
		return {
			name,
			status: 'warn',
			detail: `${BIN} ${ctx.version} — could not read the recorded latest version: ${(err as Error).message}`
		};
	}
	// Unreadable means unknown (null) — the hint is phrased conditionally ("if it is running, stop it first")
	let running: boolean | null;
	try {
		running = readRunner(ctx.dirs.data).state === 'running';
	} catch {
		running = null;
	}
	const info = updateInfo(ctx.version, latest, running);
	if (info.available) {
		return {
			name,
			status: 'warn',
			detail: `${BIN} ${info.current} (latest ${info.latest})`,
			fix: `Run: ${info.command}${info.note ? ` — ${info.note}` : ''}`
		};
	}
	return latest === null
		? {
				name,
				status: 'info',
				detail: `${BIN} ${info.current} (latest unknown until the next server call)`
			}
		: { name: 'version', status: 'ok', detail: `${BIN} ${info.current} (latest)` };
}

function checkNode(): Check {
	const current = process.versions.node;
	return satisfiesMinNode(current)
		? { name: 'node', status: 'ok', detail: `v${current}` }
		: {
				name: 'node',
				status: 'fail',
				detail: `v${current} (needs ${MIN_NODE_VERSION}+)`,
				fix: 'Install the current Node.js 24 LTS from https://nodejs.org'
			};
}

async function checkSqlite(): Promise<Check> {
	try {
		const { DatabaseSync } = await import('node:sqlite');
		new DatabaseSync(':memory:').close();
		return { name: 'sqlite', status: 'ok', detail: 'node:sqlite available' };
	} catch (err) {
		return {
			name: 'sqlite',
			status: 'fail',
			detail: `node:sqlite unavailable: ${(err as Error).message}`,
			fix: `Use the official Node.js ${MIN_NODE_VERSION}+ build`
		};
	}
}

function checkConfig(config: ResolvedConfig, home: string): Check[] {
	const checks: Check[] = [
		{
			name: 'config',
			status: 'ok',
			detail: config.projectFile
				? `project ${config.projectFile}`
				: `this host has no project. ${initHint(home)}`
		},
		{
			name: 'api url',
			status: 'info',
			detail: `${config.values.apiUrl} (from ${config.sources.apiUrl})`
		}
	];
	for (const warning of config.warnings)
		checks.push({ name: 'config', status: 'warn', detail: warning });
	return checks;
}

function checkDirs({ dirs, env }: CommandContext): Check {
	const home = env[ENV.home];
	// The state folder was moved — not this PC's default host (for development and tests, #1403)
	const moved =
		home && path.isAbsolute(home)
			? ` (${ENV.home} is set — not this PC's default host folder; for development and tests)`
			: '';
	return {
		name: 'folders',
		status: 'info',
		detail: `config ${dirs.config} · data ${dirs.data} · logs ${dirs.logs}${moved}`
	};
}

/** Never reads the token value — only its source and file permissions. Not sent to the server, so no quota use */
function checkToken({ dirs, env }: CommandContext): Check {
	let token;
	try {
		token = resolveHostToken(dirs.config, env);
	} catch (err) {
		// A diagnostic tool reports a failed item instead of crashing
		return { name: 'token', status: 'fail', detail: (err as Error).message };
	}
	if (!token) {
		return { name: 'token', status: 'info', detail: "not logged in (run '3minapi login')" };
	}
	if (token.source === 'env')
		return {
			name: 'token',
			status: 'ok',
			detail: `from ${token.location} — not the token saved by '3minapi login' (for development, CI and tests)`
		};
	const mode = looseMode(token.location);
	return mode === null
		? { name: 'token', status: 'ok', detail: `saved in ${token.location}` }
		: {
				name: 'token',
				status: 'warn',
				detail: `${token.location} is readable by other users (mode ${mode.toString(8)})`,
				fix: `Run: chmod 600 "${token.location}"`
			};
}

/**
 * Node's fetch **does not read HTTPS_PROXY and friends by default.** On 24.x it follows them only with NODE_USE_ENV_PROXY=1
 * (or --use-env-proxy) (observed on Node 24.12). The first cause of "cannot connect" behind a corporate proxy.
 */
function checkProxy(env: NodeJS.ProcessEnv): Check {
	const name = PROXY_ENV_VARS.find((v) => env[v]);
	if (!name) return { name: 'proxy', status: 'ok', detail: 'no proxy configured' };
	const shown = `${name}=${redactUrl(env[name]!)}`;
	const enabled = env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy');
	return enabled
		? { name: 'proxy', status: 'ok', detail: `${shown} (NODE_USE_ENV_PROXY=1)` }
		: {
				name: 'proxy',
				status: 'warn',
				detail: `${shown} is set, but Node.js ignores it`,
				fix: 'Set NODE_USE_ENV_PROXY=1 so connections go through the proxy'
			};
}

/** Never prints the user or password in the proxy URL */
function redactUrl(value: string): string {
	try {
		const u = new URL(value);
		if (u.username || u.password) {
			u.username = '***';
			u.password = '';
		}
		return u.toString();
	} catch {
		return '(unparseable)';
	}
}

/** Any response passes — the status code is ignored. Sends no token, so no quota use */
async function checkApi(config: ResolvedConfig): Promise<Check> {
	const url = config.values.apiUrl;
	try {
		const res = await fetch(url, {
			redirect: 'manual',
			signal: AbortSignal.timeout(DOCTOR_API_TIMEOUT_MS)
		});
		await res.body?.cancel();
		return { name: 'api', status: 'ok', detail: `${url} reachable (HTTP ${res.status})` };
	} catch (err) {
		const e = err as Error & { cause?: { code?: string; message?: string } };
		const reason =
			e.name === 'TimeoutError'
				? `no response within ${DOCTOR_API_TIMEOUT_MS / 1000}s`
				: (e.cause?.code ?? e.cause?.message ?? e.message);
		return {
			name: 'api',
			status: 'fail',
			detail: `${url} unreachable: ${reason}`,
			fix: 'Check your network, firewall or proxy settings'
		};
	}
}

/**
 * Does the live-receive WebSocket open — handshakes **without a token** to the `live_url` from the last sync. The server accepts
 * the upgrade then closes with 4001, so no quota use. Open (101) = reachable; the 4001 close is not awaited (it can arrive ~10s
 * later). If it doesn't open the cause is unknown (WebSocket exposes no status code), so it suggests `--mode poll` without
 * guessing. Failure is a warning (not counted toward exit 3) — poll still works. See docs/design/15_cli.md §4
 */
async function checkLive(ctx: CommandContext, config: ResolvedConfig): Promise<Check> {
	const name = 'live';
	let url: string | null = null;
	try {
		const db = ControlDb.openReadOnly(ctx.dirs.data);
		try {
			url = db?.getMeta(LIVE_META.url) ?? null;
		} finally {
			db?.close();
		}
	} catch (err) {
		// No record differs from an unreadable one — a "run start" hint would hide the cause (permissions, lock)
		return {
			name,
			status: 'warn',
			detail: `could not read the recorded live address: ${(err as Error).message}`,
			fix: "Run '3minapi doctor' again after 'start' stops, or check the permissions of the data folder ('3minapi paths')"
		};
	}
	if (url === null) {
		return {
			name,
			status: 'info',
			detail: `not checked yet — '3minapi start' records the address`
		};
	}
	// The API address changed — don't handshake with the old one
	if (!isTrustedLiveUrl(url, config.values.apiUrl)) {
		return {
			name,
			status: 'info',
			detail: `not checked — the recorded address is for another API URL`
		};
	}
	const opened = await new Promise<boolean>((resolve) => {
		let ws: WebSocket;
		try {
			ws = new WebSocket(url);
		} catch {
			resolve(false);
			return;
		}
		const timer = setTimeout(() => {
			done(false);
		}, DOCTOR_API_TIMEOUT_MS);
		const done = (ok: boolean) => {
			clearTimeout(timer);
			try {
				ws.close();
			} catch {
				// already closed
			}
			resolve(ok);
		};
		ws.addEventListener('open', () => done(true), { once: true });
		ws.addEventListener('close', () => done(false), { once: true });
	});
	if (opened) return { name, status: 'ok', detail: `${url} reachable (WebSocket)` };
	const proxy = PROXY_ENV_VARS.find((v) => ctx.env[v]);
	return {
		name,
		status: 'warn',
		detail:
			`could not open a WebSocket to ${url} — a proxy, firewall or the network may block it` +
			(proxy ? ` (proxy ${proxy} is set)` : ''),
		fix: "Run '3minapi start --mode poll' to fetch tasks at an interval instead"
	};
}

/**
 * On Windows npm creates both .ps1 and .cmd shims, and PowerShell prefers .ps1. With a Restricted
 * execution policy 3minapi doesn't start in PowerShell at all, so this check warns ahead of time when
 * run from another shell such as cmd. The user guide covers the fix.
 */
function checkExecutionPolicy(): Check {
	// Launched from pwsh 7, PSModulePath inherits PowerShell 7 module paths and Windows PowerShell 5.1 can't load
	// the module with Get-ExecutionPolicy (observed in CI, Windows). Drop it so 5.1 uses its default path.
	const { PSModulePath: _inherited, ...env } = process.env;
	const r = spawnSync(
		'powershell.exe',
		['-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy'],
		{ encoding: 'utf8', timeout: 10_000, windowsHide: true, env }
	);
	const policy = r.stdout?.trim();
	if (r.status !== 0 || !policy) {
		const reason = (r.error?.message ?? r.stderr?.trim().split(/\r?\n/)[0]) || `exit ${r.status}`;
		return {
			name: 'powershell',
			status: 'info',
			detail: `could not read the execution policy (${reason})`
		};
	}
	if (policy === 'Restricted' || policy === 'AllSigned') {
		return {
			name: 'powershell',
			status: 'warn',
			detail: `execution policy is ${policy}: '3minapi' will not start from PowerShell`,
			fix: "Run 'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned', or use '3minapi.cmd'"
		};
	}
	return { name: 'powershell', status: 'ok', detail: `execution policy ${policy}` };
}

function render(checks: Check[], { out }: CommandContext): string {
	// Letters instead of symbols (✓ ✗) — fixed width and independent of the receiving code page (cp949 etc.)
	const label: Record<Status, string> = {
		ok: out.out.green('ok  '),
		warn: out.out.yellow('warn'),
		fail: out.out.red('FAIL'),
		info: out.out.dim('info')
	};
	const width = Math.max(...checks.map((c) => c.name.length)) + 2;
	const lines = checks.flatMap((c) => {
		const line = `${label[c.status]}  ${c.name.padEnd(width)}${c.detail}`;
		return c.fix ? [line, `      ${' '.repeat(width)}${out.out.dim('-> ' + c.fix)}`] : [line];
	});
	return lines.join('\n');
}
