/**
 * CLI update notice (docs/design/14_cli_host.md §6-5, docs/design/15_cli.md §7-8).
 *
 * The recommended version comes from **server responses** (`cli.latest` on `GET /host`, pull and sync) — the npm registry is not queried
 * (extra calls, proxies, zero runtime dependencies). The value is kept in the control DB `meta` so `doctor`, which does not call the server, can use it.
 *
 * The human notice (one stderr line) appears **once per 24 hours**, and again right away when the recommended version changes. The `--json`
 * `update` field is always included — machine-readable facts are not rate-limited. It is not disabled for non-TTY output (unlike update-notifier):
 * AI coding agents run commands without a TTY, so disabling it there would hide the notice from them.
 *
 * Forced updates are not handled here — the server's 426 `cli_outdated` (a stop code, `stopHint`) covers them.
 *
 * ⚠️ The notice must never fail a command. meta read/write failures are all swallowed — and recorded in the given `log` (app log).
 */
import { BIN, ENV, type HostCli } from './domain/index.ts';
import type { ControlDb } from './control-db.ts';
import { parseVersion } from './version.ts';

/** Control DB `meta` keys */
export const UPDATE_META = {
	/** Recommended version last reported by the server. Removed when the server reports none */
	latest: 'cli_latest',
	/** When the human notice was last shown (ms) and the recommended version at that time */
	noticeAt: 'update_notice_at',
	noticeVersion: 'update_notice_version'
} as const;

export const UPDATE_NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * A recommended version the CLI accepts — exactly `x.y.z`, short. The value is printed to the terminal, so a server
 * response can't smuggle control sequences or a huge string through it (docs/design/17_cli_security_review.md S8).
 */
export function isReleaseVersion(value: unknown): value is string {
	return typeof value === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value);
}

/** Where swallowed failures are recorded — usually `session.logger.debug` */
export type UpdateLog = (message: string, attributes?: Record<string, unknown>) => void;

/** `update` in `status --json` (docs/design/15_cli.md §7-8) */
export interface UpdateInfo {
	current: string;
	/** Recommended version reported by the server. null if unknown */
	latest: string | null;
	available: boolean;
	/** When `available`, the update command — a single shell-independent command (completes if run as is) */
	command: string | null;
	/** When `available`, what to do before/after the command (stop a running runner, keep calling via npx). null if none */
	note: string | null;
}

/** Whether `a` is newer than `b`. false if unparseable — never notify based on an unknown value */
export function isNewerVersion(a: string, b: string): boolean {
	const x = parseVersion(a);
	const y = parseVersion(b);
	if (!x || !y) return false;
	for (let i = 0; i < 3; i++) {
		if (x[i] !== y[i]) return x[i] > y[i];
	}
	return false;
}

/** Whether this process runs from the npx cache — then `npx …@latest` is right, not `npm i -g` */
export function runsFromNpx(entry: string | undefined = process.argv[1]): boolean {
	return entry !== undefined && /[\\/]_npx[\\/]/.test(entry);
}

/**
 * The update command — **a single command**. Not chained with `&&` (Windows PowerShell 5.1 rejects `&&` as a syntax error).
 * Does not append `start` — it runs in the foreground and never ends (an AI running it as is would hang), and the original `-d`/`--serve` would be lost.
 * npx has no install — one call with `@latest` fetches the new version (and later calls stay `npx 3minapi@latest <command>`)
 */
export function updateCommand(entry: string | undefined = process.argv[1]): string {
	return runsFromNpx(entry) ? `npx ${BIN}@latest --version` : `npm i -g ${BIN}@latest`;
}

/**
 * What to do before/after the command. With a global install, stop the running runner first — package files change under it otherwise.
 * If `running` is unknown (stop notice), phrased as a condition
 */
export function updateNote(
	running: boolean | null,
	entry: string | undefined = process.argv[1]
): string | null {
	// With npx, a running process also stays on the old version — it must restart to pick up the new one
	const npx = runsFromNpx(entry);
	const restart = npx
		? `stop it with '${BIN} stop' and start it again as 'npx ${BIN}@latest start'`
		: `stop it first with '${BIN} stop' and start it again after the update`;
	const keep = npx ? ` Keep running it as 'npx ${BIN}@latest <command>'.` : '';
	if (running === null) return `If '${BIN} start' is running in the background, ${restart}.${keep}`;
	if (running) return `'${BIN} start' is running — ${restart}.${keep}`;
	return npx ? keep.trim() : null;
}

export function updateInfo(
	current: string,
	latest: string | null,
	running: boolean | null = false
): UpdateInfo {
	const available = latest !== null && isNewerVersion(latest, current);
	return {
		current,
		latest,
		available,
		command: available ? updateCommand() : null,
		note: available ? updateNote(running) : null
	};
}

/**
 * Records the server response's `cli`. If the key is absent or not `x.y.z`, that server reports no recommended version — the old value is removed
 */
export function rememberLatest(
	db: ControlDb,
	cli: HostCli | undefined,
	now: number,
	log?: UpdateLog
): boolean {
	try {
		const latest = cli?.latest;
		if (isReleaseVersion(latest)) db.setMeta(UPDATE_META.latest, latest, now);
		else db.deleteMeta(UPDATE_META.latest);
		return true;
	} catch (err) {
		// The next response records it again (a running start retries via LatestWatch until it succeeds)
		log?.('could not record the latest CLI version', { message: (err as Error).message });
		return false;
	}
}

/** The recorded recommended version, or null — throws on a read failure (doctor reports it; readLatest swallows it) */
export function recordedLatest(db: ControlDb): string | null {
	// A value recorded by an older CLI is checked again
	const latest = db.getMeta(UPDATE_META.latest);
	return isReleaseVersion(latest) ? latest : null;
}

export function readLatest(db: ControlDb, log?: UpdateLog): string | null {
	try {
		return recordedLatest(db);
	} catch (err) {
		log?.('could not read the latest CLI version', { message: (err as Error).message });
		return null;
	}
}

/** Environments that disable the notice — our variable, the industry convention (update-notifier), CI */
export function updateNoticeSuppressed(env: Record<string, string | undefined>): boolean {
	const on = (v: string | undefined) =>
		v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
	return on(env[ENV.noUpdateNotice]) || env.NO_UPDATE_NOTIFIER !== undefined || on(env.CI);
}

export function updateNoticeLine(info: UpdateInfo): string {
	const line = `update available: ${BIN} ${info.current} → ${info.latest} — run: ${info.command}`;
	return info.note ? `${line}\n${info.note}` : line;
}

/**
 * Whether it is time for the human notice — if so, records it too (so the caller prints right away on true).
 * false if already shown for the same recommended version within 24 hours. true right away when the recommended version changes
 */
export function claimUpdateNotice(
	db: ControlDb,
	info: UpdateInfo,
	now: number,
	env: Record<string, string | undefined>,
	log?: UpdateLog
): boolean {
	if (!info.available || info.latest === null || updateNoticeSuppressed(env)) return false;
	try {
		const at = Number(db.getMeta(UPDATE_META.noticeAt) ?? NaN);
		const sameVersion = db.getMeta(UPDATE_META.noticeVersion) === info.latest;
		if (
			sameVersion &&
			Number.isFinite(at) &&
			now - at >= 0 &&
			now - at < UPDATE_NOTICE_INTERVAL_MS
		) {
			return false;
		}
		db.setMetas(
			{ [UPDATE_META.noticeAt]: String(now), [UPDATE_META.noticeVersion]: info.latest },
			now
		);
	} catch (err) {
		// Show the notice even if recording fails — once more beats never. The log explains why the 24-hour limit did not apply
		log?.('could not record the update notice', { message: (err as Error).message });
	}
	return true;
}

export interface LatestWatchOptions {
	db: ControlDb;
	now: () => number;
	announce: () => void;
	log?: UpdateLog;
}

/**
 * Recommended-version watch for a running `start` — pull returns `cli` every time, so the control DB is written **only on change**.
 * A failed write is retried on following responses until it succeeds.
 * Notices only after `arm()` (after the start banner) — `announce` is called when the watched value changes, and once per 24 hours. Only then is
 * the DB read for the notice decision. The first response does not count as a change (the banner covers it — so the same notice is not shown twice).
 * In the foreground `announce` writes to stderr (using the daily turn); in the background it only logs to the app log (not using the turn)
 */
export class LatestWatch {
	private readonly opts: LatestWatchOptions;
	/** For the notice decision — the last received value. `undefined` = nothing received yet */
	private seen: string | null | undefined = undefined;
	/** Value written to the DB. `undefined` = not written yet (or the write failed — retried on the next response) */
	private written: string | null | undefined = undefined;
	private armed = false;
	private announcedAt = 0;

	constructor(opts: LatestWatchOptions) {
		this.opts = opts;
	}

	/** The server response's `cli` (`ApiClient` `onServerCli`) */
	observe(cli: HostCli | undefined): void {
		const latest = isReleaseVersion(cli?.latest) ? cli.latest : null;
		if (latest !== this.written) {
			const ok = rememberLatest(
				this.opts.db,
				latest === null ? undefined : { latest },
				this.opts.now(),
				this.opts.log
			);
			this.written = ok ? latest : undefined;
		}
		const changed = this.seen !== undefined && latest !== this.seen;
		this.seen = latest;
		if (!this.armed) return;
		if (changed || this.opts.now() - this.announcedAt >= UPDATE_NOTICE_INTERVAL_MS) this.fire();
	}

	/** After the start banner — notify once now, then on change and every 24 hours */
	arm(): void {
		this.armed = true;
		this.fire();
	}

	private fire(): void {
		this.announcedAt = this.opts.now();
		try {
			this.opts.announce();
		} catch (err) {
			this.opts.log?.('could not announce the CLI update', { message: (err as Error).message });
		}
	}
}
