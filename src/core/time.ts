/**
 * Time rules — docs/design/15_cli.md §7-5.
 *
 *   storage (control DB)  epoch ms (UTC)
 *   logs, --json          ISO 8601 UTC (`…Z`)
 *   human output          local time zone, fixed format `2026-10-01 13:21:07 +09:00`
 *
 * Locale formats (toLocaleString) are not used — they would mix with the English CLI text and make user reports hard to compare.
 * Node 24 has no Temporal, and Intl's longOffset yields only `GMT` at UTC, so the string is assembled by hand.
 * The time zone follows the OS setting (including `TZ`) as Node reads it.
 */
import { setTimeout as delay } from 'node:timers/promises';

const DAY_MS = 86_400_000;

export function toIsoUtc(ms: number): string {
	return new Date(ms).toISOString();
}

/** UTC date `YYYY-MM-DD` — log file names */
export function utcDate(ms: number): string {
	return toIsoUtc(ms).slice(0, 10);
}

/** Local time zone `YYYY-MM-DD HH:mm:ss +09:00` */
export function formatLocal(ms: number): string {
	const d = new Date(ms);
	const offset = -d.getTimezoneOffset();
	const sign = offset < 0 ? '-' : '+';
	const abs = Math.abs(offset);
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
		`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ` +
		`${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
	);
}

/** `in 3 days` / `5 minutes ago` — appended to values where the remaining time matters */
export function relative(ms: number, now: number): string {
	const diff = ms - now;
	const abs = Math.abs(diff);
	const units: [number, string][] = [
		[DAY_MS, 'day'],
		[3_600_000, 'hour'],
		[60_000, 'minute']
	];
	let text = 'less than a minute';
	for (const [size, name] of units) {
		const n = Math.floor(abs / size);
		if (n >= 1) {
			text = `${n} ${name}${n === 1 ? '' : 's'}`;
			break;
		}
	}
	return diff >= 0 ? `in ${text}` : `${text} ago`;
}

/** A server ISO timestamp (resets etc.) for humans. The raw string if unparseable */
export function describeAt(iso: string, now: number, opts: { local?: boolean } = {}): string {
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) return iso;
	return opts.local ? `${formatLocal(ms)} (${relative(ms, now)})` : relative(ms, now);
}

export function daysToMs(days: number): number {
	return days * DAY_MS;
}

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

/** Waits ms. Wakes immediately when signal aborts (does not reject) */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	try {
		await delay(ms, undefined, { signal });
	} catch (err) {
		if ((err as Error).name !== 'AbortError') throw err;
	}
}

/** Interval display — `60s` if a whole number of seconds, otherwise `1500 ms` */
export function formatInterval(ms: number): string {
	return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms} ms`;
}

/**
 * Upper bound on polling throughput — pull fetches only as many tasks as there are free slots, so at most `concurrency` per poll. Tasks that
 * take longer than the interval lower it. Below 1 per minute, shown per hour
 */
export function maxTasksPerMinute(concurrency: number, intervalMs: number): number {
	return (concurrency * 60_000) / intervalMs;
}

export function formatThroughput(concurrency: number, intervalMs: number): string {
	const perMin = maxTasksPerMinute(concurrency, intervalMs);
	const rate =
		perMin >= 1
			? `${Math.round(perMin).toLocaleString('en-US')} tasks/min`
			: `${Math.round(perMin * 60).toLocaleString('en-US')} tasks/hour`;
	return `up to ${concurrency} at a time (≈ ${rate} at most)`;
}

/**
 * Date argument (`--since`, `--before`) — `YYYY-MM-DD` is **local midnight**; anything else is ISO 8601 with a time (`2026-10-01T09:00`, `…Z`,
 * `…+09:00`). null if unparseable
 */
export function parseDateArg(value: string): number | null {
	const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (day) {
		const [, y, m, d] = day.map(Number);
		const ms = new Date(y, m - 1, d).getTime();
		const back = new Date(ms);
		// Date rolls dates like 2026-02-31 into the next month — reject them
		return back.getFullYear() === y && back.getMonth() === m - 1 && back.getDate() === d
			? ms
			: null;
	}
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? null : ms;
}
