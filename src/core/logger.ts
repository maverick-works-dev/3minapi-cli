/**
 * Logs — JSON Lines, one file per channel (app / per worker) × UTC date. docs/design/15_cli.md §7-3.
 *
 *   <logs>/app/2026-10-01.jsonl
 *   <logs>/workers/<name>/2026-10-01.jsonl      (past 10MB: 2026-10-01.1.jsonl, .2 …)
 *
 * One line = OpenTelemetry log model shape: { timestamp, severity_text, body, attributes }
 * Every value is redacted, then truncated (redact.ts). Raw task input/result is not accepted — do not pass it.
 * New files 0600, folders 0700 (POSIX).
 *
 * Retention: delete files dated outside the retention period → if still over the total size, delete oldest first.
 * Cleanup (onMaintenance) runs when the logger opens, on the first write after the UTC date changes, and on file split —
 * so a long-running process that logs heavily within one day still respects the total size cap.
 *
 * Logging is secondary. Cleanup and write failures do not throw; onError reports each once — logging must not
 * make primary work such as login or stop handling fail.
 */
import { appendFileSync, readdirSync, rmdirSync, rmSync, statSync, type Dirent } from 'node:fs';
import path from 'node:path';
import {
	APP_LOG_DIR,
	LOG_FILE_EXTENSION,
	LOG_FILE_MAX_BYTES,
	LOG_STRING_MAX_CHARS,
	SECRET_FILE_MODE,
	WORKER_LOG_DIR,
	type LogLevel
} from './domain/index.ts';
import { redact, redactAndTruncate } from './redact.ts';
import { ensurePrivateDir } from './secure-fs.ts';
import { daysToMs, toIsoUtc, utcDate } from './time.ts';

const LOG_FILE = /^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/;

export interface LogRecord {
	timestamp: string;
	severity_text: LogLevel;
	body: string;
	attributes?: Record<string, unknown>;
}

export interface LogFile {
	file: string;
	/** Channel folder */
	dir: string;
	date: string;
	index: number;
	size: number;
}

export interface LoggerOptions {
	dir: string;
	now(): number;
	/** Retention cleanup — on open, on the first write after the UTC date changes, on file split */
	onMaintenance?(now: number): void;
	/** Cleanup/write failure notice (stderr warning etc.). Called once per kind */
	onError?(message: string): void;
	/** Per-file cap — tests lower it */
	fileMaxBytes?: number;
}

/** null = app log */
export type Channel = string | null;

export function channelDir(logsDir: string, worker: Channel): string {
	return worker === null
		? path.join(logsDir, APP_LOG_DIR)
		: path.join(logsDir, WORKER_LOG_DIR, worker);
}

export class Logger {
	private readonly opts: LoggerOptions;
	private readonly fileMaxBytes: number;
	private readonly current = new Map<string, { date: string; index: number; size: number }>();
	private lastMaintenanceDate: string | null = null;
	private readonly reported = new Set<string>();

	constructor(opts: LoggerOptions) {
		this.opts = opts;
		this.fileMaxBytes = opts.fileMaxBytes ?? LOG_FILE_MAX_BYTES;
		this.maintain(opts.now());
	}

	debug(body: string, attributes?: Record<string, unknown>): void {
		this.write(null, 'debug', body, attributes);
	}
	info(body: string, attributes?: Record<string, unknown>): void {
		this.write(null, 'info', body, attributes);
	}
	warn(body: string, attributes?: Record<string, unknown>): void {
		this.write(null, 'warn', body, attributes);
	}
	error(body: string, attributes?: Record<string, unknown>): void {
		this.write(null, 'error', body, attributes);
	}

	/** Worker log. Put task_id etc. in attributes */
	worker(name: string, level: LogLevel, body: string, attributes?: Record<string, unknown>): void {
		this.write(name, level, body, attributes);
	}

	write(
		channel: Channel,
		level: LogLevel,
		body: string,
		attributes?: Record<string, unknown>
	): void {
		const now = this.opts.now();
		this.maintain(now);
		const record: LogRecord = {
			timestamp: toIsoUtc(now),
			severity_text: level,
			body: redactAndTruncate(body, LOG_STRING_MAX_CHARS)
		};
		if (attributes && Object.keys(attributes).length > 0) {
			record.attributes = truncateStrings(redact(attributes)) as Record<string, unknown>;
		}
		// JSON.stringify escapes CR and LF, so a record is always one line (prevents log injection)
		const line = JSON.stringify(record) + '\n';
		try {
			const { file, rotated } = this.fileFor(channel, utcDate(now), Buffer.byteLength(line));
			appendFileSync(file, line, { mode: SECRET_FILE_MODE });
			if (rotated) this.maintain(now, true);
		} catch (err) {
			this.report('write', `could not write to the log in ${this.opts.dir}: ${message(err)}`);
		}
	}

	private fileFor(
		channel: Channel,
		date: string,
		bytes: number
	): { file: string; rotated: boolean } {
		const dir = channelDir(this.opts.dir, channel);
		const key = channel ?? '';
		let cur = this.current.get(key);
		if (!cur || cur.date !== date) {
			ensurePrivateDir(dir);
			const latest = listChannelFiles(dir)
				.filter((f) => f.date === date)
				.at(-1);
			cur = { date, index: latest?.index ?? 0, size: latest?.size ?? 0 };
			this.current.set(key, cur);
		}
		let rotated = false;
		if (cur.size > 0 && cur.size + bytes > this.fileMaxBytes) {
			cur.index++;
			cur.size = 0;
			rotated = true;
		}
		cur.size += bytes;
		return { file: path.join(dir, fileName(date, cur.index)), rotated };
	}

	private maintain(now: number, force = false): void {
		const date = utcDate(now);
		if (!force && date === this.lastMaintenanceDate) return;
		// On failure, do not retry the same day — avoids a warning on every write
		this.lastMaintenanceDate = date;
		try {
			this.opts.onMaintenance?.(now);
		} catch (err) {
			this.report('maintenance', `log cleanup failed in ${this.opts.dir}: ${message(err)}`);
		}
	}

	private report(kind: string, text: string): void {
		if (this.reported.has(kind)) return;
		this.reported.add(kind);
		this.opts.onError?.(text);
	}
}

export function fileName(date: string, index: number): string {
	return index === 0 ? `${date}${LOG_FILE_EXTENSION}` : `${date}.${index}${LOG_FILE_EXTENSION}`;
}

/** Log files in one channel folder — oldest first */
export function listChannelFiles(dir: string): LogFile[] {
	const files: LogFile[] = [];
	for (const name of readdirOrEmpty(dir)) {
		const m = LOG_FILE.exec(name);
		if (!m) continue;
		const file = path.join(dir, name);
		const st = statSync(file, { throwIfNoEntry: false });
		if (!st?.isFile()) continue;
		files.push({ file, dir, date: m[1], index: m[2] ? Number(m[2]) : 0, size: st.size });
	}
	return files.sort((a, b) => (a.date === b.date ? a.index - b.index : a.date < b.date ? -1 : 1));
}

/** Log files of all channels */
export function listAllLogFiles(logsDir: string): LogFile[] {
	const dirs = [channelDir(logsDir, null)];
	const workersRoot = path.join(logsDir, WORKER_LOG_DIR);
	for (const entry of readdirOrEmpty(workersRoot, true)) {
		if (entry.isDirectory()) dirs.push(path.join(workersRoot, entry.name));
	}
	return dirs.flatMap(listChannelFiles);
}

export interface PruneLogsInput {
	dir: string;
	now: number;
	retentionDays: number;
	maxBytes: number;
}

/**
 * 1) Outside retention — delete files whose last possible record (midnight after their date) is older than retentionDays
 * 2) If the remaining total exceeds maxBytes, delete oldest first. Each channel's current file (today's last file) is kept —
 *    so the cap can be exceeded by one current file per channel (up to LOG_FILE_MAX_BYTES)
 * Returns the deleted files. Safe when other CLI processes clean the same folder concurrently.
 */
export function pruneLogs({ dir, now, retentionDays, maxBytes }: PruneLogsInput): string[] {
	const deleted: string[] = [];
	const cutoffDate = utcDate(now - daysToMs(retentionDays));
	const today = utcDate(now);

	let files = listAllLogFiles(dir);
	for (const f of files) {
		if (f.date < cutoffDate) remove(f, deleted);
	}
	files = files.filter((f) => f.date >= cutoffDate);

	const active = new Set<string>();
	const byChannel = new Map<string, LogFile>();
	for (const f of files) if (f.date === today) byChannel.set(f.dir, f);
	for (const f of byChannel.values()) active.add(f.file);

	let total = files.reduce((sum, f) => sum + f.size, 0);
	const oldestFirst = [...files].sort((a, b) =>
		a.date === b.date ? a.index - b.index : a.date < b.date ? -1 : 1
	);
	for (const f of oldestFirst) {
		if (total <= maxBytes) break;
		if (active.has(f.file)) continue;
		remove(f, deleted);
		total -= f.size;
	}

	removeEmptyWorkerDirs(dir);
	return deleted;
}

function remove(f: LogFile, deleted: string[]): void {
	rmSync(f.file, { force: true });
	deleted.push(f.file);
}

function removeEmptyWorkerDirs(logsDir: string): void {
	const root = path.join(logsDir, WORKER_LOG_DIR);
	for (const entry of readdirOrEmpty(root, true)) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(root, entry.name);
		if (readdirOrEmpty(dir).length > 0) continue;
		try {
			rmdirSync(dir);
		} catch (err) {
			// Another process wrote a log in the meantime (ENOTEMPTY) or deleted it first (ENOENT)
			if (!['ENOTEMPTY', 'ENOENT', 'EEXIST'].includes(errno(err))) throw err;
		}
	}
}

/** Empty list if the folder is missing or vanished in the meantime */
function readdirOrEmpty(dir: string): string[];
function readdirOrEmpty(dir: string, withFileTypes: true): Dirent[];
function readdirOrEmpty(dir: string, withFileTypes?: true): string[] | Dirent[] {
	try {
		return withFileTypes ? readdirSync(dir, { withFileTypes: true }) : readdirSync(dir);
	} catch (err) {
		if (errno(err) === 'ENOENT' || errno(err) === 'ENOTDIR') return [];
		throw err;
	}
}

function errno(err: unknown): string {
	return (err as NodeJS.ErrnoException)?.code ?? '';
}

function message(err: unknown): string {
	return (err as Error)?.message ?? String(err);
}

function truncateStrings(value: unknown): unknown {
	if (typeof value === 'string') {
		return value.length > LOG_STRING_MAX_CHARS
			? value.slice(0, LOG_STRING_MAX_CHARS - 1) + '…'
			: value;
	}
	if (Array.isArray(value)) return value.map(truncateStrings);
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateStrings(v)]));
	}
	return value;
}
