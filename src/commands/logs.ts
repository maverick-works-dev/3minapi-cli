import { closeSync, openSync, readSync, statSync } from 'node:fs';
import {
	BIN,
	DEFAULT_LOG_LINES,
	ExitCode,
	LOG_FOLLOW_INTERVAL_MS,
	UsageError,
	type Command,
	type CommandContext,
	type OutputPort
} from '../core/domain/index.ts';
import { stripControl as clean, tailLines as tail } from '../core/log-read.ts';
import { channelDir, listChannelFiles, pruneLogs, type LogRecord } from '../core/logger.ts';
import { assertWorkerName } from '../core/names.ts';
import { formatLocal, sleep } from '../core/time.ts';

const LOG_OPTIONS: Command['options'] = {
	follow: { type: 'boolean', short: 'f', description: 'Keep printing new log lines' },
	lines: {
		type: 'string',
		short: 'n',
		valueName: 'lines',
		description: `Number of recent lines to show (default ${DEFAULT_LOG_LINES})`
	}
};

const RETENTION_NOTE =
	'Times are shown in your local time zone; --json prints the raw JSON Lines (UTC).\n' +
	'Logs are kept for 30 days by default (logRetentionDays) and limited to 300 MB in total\n' +
	'(logMaxBytes): the oldest files are deleted first.';

export const logs: Command = {
	name: 'logs',
	summary: 'Show the CLI log (fetches, live connection, stops, errors)',
	usage: '[-f] [-n <lines>]',
	description: `For one worker's log use '${BIN} worker logs <name>'.\n${RETENTION_NOTE}`,
	options: LOG_OPTIONS,
	args: { min: 0, max: 0 },
	run: (ctx) => show(ctx, null)
};

export const workerLogs: Command = {
	name: 'worker logs',
	summary: "Show one worker's log (ctx.log, console output, errors with stack traces)",
	usage: '<name> [-f] [-n <lines>]',
	description: RETENTION_NOTE,
	options: LOG_OPTIONS,
	args: { min: 1, max: 1 },
	run(ctx) {
		const worker = ctx.positionals[0];
		assertWorkerName(worker);
		return show(ctx, worker);
	}
};

async function show(ctx: CommandContext, worker: string | null): Promise<ExitCode> {
	const { values, out } = ctx;
	const count = parseLines(values.lines);

	// Prune before showing so retention limits hold even for read-only use.
	// Logs are shown even if pruning fails (e.g. another process holds a file) — this command is for diagnosing failures
	const { logRetentionDays, logMaxBytes } = ctx.loadConfig().values;
	try {
		pruneLogs({
			dir: ctx.dirs.logs,
			now: ctx.now(),
			retentionDays: logRetentionDays,
			maxBytes: logMaxBytes
		});
	} catch (err) {
		out.warn(`log cleanup failed: ${(err as Error).message}`);
	}

	const dir = channelDir(ctx.dirs.logs, worker);
	const lines = tail(dir, count);
	if (lines.length === 0 && !values.follow) {
		out.info(worker === null ? 'No logs yet.' : `No logs for worker "${worker}" yet.`);
		return ExitCode.Ok;
	}
	for (const line of lines) print(out, line);

	if (values.follow) await follow(dir, out, ctx.signal);
	return ExitCode.Ok;
}

function parseLines(raw: unknown): number {
	if (raw === undefined) return DEFAULT_LOG_LINES;
	const n = Number(raw);
	if (typeof raw !== 'string' || !Number.isInteger(n) || n < 1) {
		throw new UsageError('--lines must be a positive integer');
	}
	return n;
}

/**
 * Polls, since fs.watch reliability varies by platform (Node fs docs, caveats). Reads past the offset only,
 * restarts from 0 when the size shrinks, and on a new file (date or split) finishes the current file then moves on.
 *
 * Order matters: list **first**, then read the current file. The reverse would miss lines appended to the
 * old file between the read and the listing before moving to the new file.
 */
async function follow(dir: string, out: OutputPort, signal: AbortSignal): Promise<void> {
	let current = listChannelFiles(dir).at(-1)?.file ?? null;
	let offset = current ? (statSync(current, { throwIfNoEntry: false })?.size ?? 0) : 0;
	let partial = '';

	const drain = (file: string) => {
		const size = statSync(file, { throwIfNoEntry: false })?.size;
		if (size === undefined) return; // pruned away — the next listing moves to the new file
		if (size < offset) {
			offset = 0;
			partial = '';
		}
		if (size === offset) return;
		let fd: number;
		try {
			fd = openSync(file, 'r');
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
			throw err;
		}
		try {
			const buf = Buffer.alloc(size - offset);
			readSync(fd, buf, 0, buf.length, offset);
			offset = size;
			const text = partial + buf.toString('utf8');
			const parts = text.split('\n');
			partial = parts.pop() ?? '';
			for (const line of parts) if (line !== '') print(out, line);
		} finally {
			closeSync(fd);
		}
	};

	while (!signal.aborted) {
		const latest = listChannelFiles(dir).at(-1)?.file ?? null;
		if (current) drain(current);
		if (latest && latest !== current) {
			current = latest;
			offset = 0;
			partial = '';
			drain(current);
		}
		await sleep(LOG_FOLLOW_INTERVAL_MS, signal);
	}
}

function print(out: OutputPort, line: string): void {
	if (out.json) {
		out.print(line);
		return;
	}
	let record: LogRecord;
	try {
		record = JSON.parse(line);
	} catch {
		out.print(clean(line));
		return;
	}
	const ts = Date.parse(record.timestamp);
	const level = String(record.severity_text ?? '').padEnd(5);
	const paint =
		record.severity_text === 'error'
			? out.out.red
			: record.severity_text === 'warn'
				? out.out.yellow
				: out.out.dim;
	const attrs = Object.entries(record.attributes ?? {})
		.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
		.join(' ');
	const time = Number.isNaN(ts) ? clean(String(record.timestamp)) : formatLocal(ts);
	out.print(
		`${out.out.dim(time)}  ${paint(clean(level))}  ${clean(String(record.body))}` +
			(attrs ? `  ${out.out.dim(clean(attrs))}` : '')
	);
}
