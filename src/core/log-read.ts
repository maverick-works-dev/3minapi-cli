/**
 * Log reading — shared by `logs`, `worker logs` and the local dashboard. Writing and retention are in logger.ts.
 */
import { readFileSync } from 'node:fs';
import { listChannelFiles, type LogRecord } from './logger.ts';

/** The last count lines, walking back from the newest file */
export function tailLines(dir: string, count: number): string[] {
	const collected: string[] = [];
	for (const f of listChannelFiles(dir).reverse()) {
		const text = readIfExists(f.file);
		if (text === null) continue; // removed in the meantime
		const lines = text.split('\n').filter((l) => l !== '');
		collected.unshift(...lines);
		if (collected.length >= count) break;
	}
	return collected.slice(-count);
}

/**
 * The most recent record matching the filter — walks back one file at a time from the newest. Stops after reading more than maxBytes
 * (counted in bytes, not files, so a missing match does not read the whole retention; files split at 10MB, so busy hosts have several per day).
 * With contains, only lines containing that string are parsed as JSON (most lines are never parsed)
 */
export function findLastRecord(
	dir: string,
	match: (record: LogRecord) => boolean,
	opts: { maxBytes: number; contains?: string }
): LogRecord | null {
	let scanned = 0;
	for (const f of listChannelFiles(dir).reverse()) {
		if (scanned >= opts.maxBytes) return null;
		const text = readIfExists(f.file);
		if (text === null) continue;
		scanned += f.size;
		const lines = text.split('\n');
		for (let i = lines.length - 1; i >= 0; i--) {
			if (opts.contains !== undefined && !lines[i].includes(opts.contains)) continue;
			const record = parseRecord(lines[i]);
			if (record && match(record)) return record;
		}
	}
	return null;
}

/** One line → a record. Empty, broken or timestamp-less lines are null (shown as raw lines) — the view sorts and shows by timestamp */
export function parseRecord(line: string): LogRecord | null {
	if (line === '') return null;
	try {
		const record = JSON.parse(line) as LogRecord;
		return record !== null && typeof record === 'object' && typeof record.timestamp === 'string'
			? record
			: null;
	} catch {
		return null;
	}
}

export function readIfExists(file: string): string | null {
	try {
		return readFileSync(file, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw err;
	}
}

export { stripControl } from './text.ts';
