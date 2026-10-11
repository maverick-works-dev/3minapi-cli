/**
 * Reading saved results — structural summary (describe) and read-only SQL (query) (docs/design/15_cli.md §8-5).
 *
 * CLI `worker results describe|query` and the built-in reader worker share **the same code** — the return shapes are
 * both the `--json` output and the remote response. Remote-only scoped views, shape aggregation and the limit to
 * replied results live in reader.ts.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
	DESCRIBE_MAX_DIFF_PATHS,
	DESCRIBE_MAX_GROUPS,
	DESCRIBE_MAX_MERGE,
	REPORT_ENVELOPE_RESERVE,
	REPORT_MAX_BYTES
} from '../../../core/domain/index.ts';
import type { ReaderOutcome, ReaderRequest } from './reader-input.ts';
import { fitShape, ShapeMerger, type Shape } from './shape.ts';
import { resultsDbPath, type ResultFilter, type ResultStore, type StoredResult } from './store.ts';

/** Works from both the build (dist/*.js) and source (src/*.ts) */
const RESULTS_CHILD = fileURLToPath(
	new URL(
		import.meta.url.endsWith('.ts') ? './results-child.ts' : './results-child.js',
		import.meta.url
	)
);

export type QueryOutcome =
	| { ok: true; columns: string[]; rows: unknown[][] }
	/** denied = non-read operation, syntax = syntax error, error = anything else (missing table etc.), timeout, cancelled = aborted via signal */
	| { ok: false; kind: 'denied' | 'syntax' | 'error' | 'timeout' | 'cancelled'; message: string };

/** Runs read-only in a child process — a synchronous query cannot be interrupted in this process (results-child.ts) */
export async function runQuery(
	root: string,
	sql: string,
	timeoutMs: number,
	signal?: AbortSignal
): Promise<QueryOutcome> {
	const r = await runResultsChild({ op: 'sql', file: resultsDbPath(root), sql }, timeoutMs, signal);
	if (r === 'timeout') {
		return {
			ok: false,
			kind: 'timeout',
			message: `the query did not finish within ${timeoutMs / 1000}s`
		};
	}
	if (r === 'cancelled')
		return { ok: false, kind: 'cancelled', message: 'the query was cancelled' };
	return r as QueryOutcome;
}

/**
 * One built-in reader worker call (reader.ts) — timeout and cancel are returned as strings. `hostId` = the current
 * host; only results run by that host are read (#1403)
 */
export async function runReaderChild(
	root: string,
	hostId: string,
	request: ReaderRequest,
	timeoutMs: number,
	signal?: AbortSignal
): Promise<ReaderOutcome | 'timeout' | 'cancelled'> {
	const r = await runResultsChild(
		{ op: 'reader', root, hostId, file: resultsDbPath(root), request },
		timeoutMs,
		signal
	);
	return r as ReaderOutcome | 'timeout' | 'cancelled';
}

/**
 * Spawns a child to handle one message. A child we killed wrote no output, so 'timeout' and 'cancelled' are checked
 * first rather than surfacing as an output parse failure (a bug). Other abnormal exits reject (with the child's stderr)
 */
function runResultsChild(
	message: unknown,
	timeoutMs: number,
	signal?: AbortSignal
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return resolve('cancelled');
		const child = spawn(process.execPath, [RESULTS_CHILD], {
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, timeoutMs);
		let cancelled = false;
		const onAbort = () => {
			cancelled = true;
			child.kill('SIGKILL');
		};
		signal?.addEventListener('abort', onAbort, { once: true });
		child.stdout.on('data', (c: Buffer) => out.push(c));
		child.stderr.on('data', (c: Buffer) => err.push(c));
		child.on('error', (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			if (cancelled) return resolve('cancelled');
			if (timedOut) return resolve('timeout');
			const text = Buffer.concat(out).toString('utf8');
			try {
				resolve(JSON.parse(text));
			} catch {
				const detail = Buffer.concat(err).toString('utf8').trim();
				reject(
					new Error(
						`the query process ended without a result (exit code ${code})${detail ? `: ${detail}` : ''}`
					)
				);
			}
		});
		child.stdin.end(JSON.stringify(message));
	});
}

/** describe output cap — same for CLI and remote. A remote response over the reply limit would itself become a substitute */
export const DESCRIBE_MAX_BYTES = REPORT_MAX_BYTES - REPORT_ENVELOPE_RESERVE;

/** Values JSON lacks (query result rows) — big integers as strings, BLOBs as their size */
export function replacer(_key: string, value: unknown): unknown {
	if (typeof value === 'bigint') return value.toString();
	if (value instanceof Uint8Array) return `<blob ${value.byteLength} bytes>`;
	return value;
}

/** UTF-8 bytes of the JSON actually sent — budgets are measured with this */
export const jsonBytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v, replacer));

export interface TaskShape {
	task_id: string;
	worker: string;
	created_at: string;
	/** Hash of the original (untrimmed) shape */
	shape_hash: string;
	shape: Shape;
}

/** Shape of one result, trimmed from the deepest level when over budget (fitShape). Only completed results have one */
export function describeTask(
	r: StoredResult & { shape: Shape },
	maxBytes = DESCRIBE_MAX_BYTES
): TaskShape {
	const build = (shape: Shape): TaskShape => ({
		task_id: r.task_id,
		worker: r.worker,
		created_at: r.created_at,
		shape_hash: r.shape_hash ?? '',
		shape
	});
	return build(fitShape(r.shape, (s) => jsonBytes(build(s)) <= maxBytes));
}

export interface ShapeGroup {
	shape_hash: string;
	count: number;
	first: string;
	last: string;
	/** Three, most recent first */
	task_ids: string[];
	/** Versus the baseline (latest result's shape) — paths only here / paths missing here. Overflow counts in *_more */
	added: string[];
	removed: string[];
	added_more?: number;
	removed_more?: number;
}

export interface WorkerShapes {
	worker: string;
	total: number;
	/**
	 * Baseline = shape of the most recent result in scope, so the current shape is the baseline even right after a
	 * structure change. First in groups (#1422)
	 */
	baseline: string | null;
	/** Baseline group first, the rest by count descending */
	groups: ShapeGroup[];
	/** Groups left out — the smaller ones */
	others: { groups: number; count: number } | null;
	/** Merged summary of the baseline group's latest `shape_results` results — values and ranges span them all (may be trimmed to budget) */
	shape: Shape | null;
	/** Results merged into shape — below the baseline group's count means only the latest ones (DESCRIBE_MAX_MERGE) */
	shape_results: number;
	/** Time of the oldest result merged into shape — the same `since` on query covers the same range */
	shape_since: string | null;
	/** When the merge covers only part of the baseline group — use query for the whole */
	note?: string;
}

/**
 * Groups a worker's results by shape — baseline (latest result's shape) first, the rest by count. Counts and time
 * ranges come from SQL; shapes are read only for the baseline group's latest maxMerge results and one per shown group
 * (no full scan). **The whole output fits the budget**: up to DESCRIBE_MAX_GROUPS groups and DESCRIBE_MAX_DIFF_PATHS
 * diff paths, the baseline shape trimmed to what remains, then fewer groups if still too large
 */
export function describeWorker(
	store: ResultStore,
	filter: ResultFilter,
	maxBytes = DESCRIBE_MAX_BYTES,
	maxMerge = DESCRIBE_MAX_MERGE
): WorkerShapes {
	// All queries see one snapshot — a running start saving in between cannot skew baseline, counts or merge
	return store.snapshot(() => describeIn(store, filter, maxBytes, maxMerge));
}

function describeIn(
	store: ResultStore,
	filter: ResultFilter,
	maxBytes: number,
	maxMerge: number
): WorkerShapes {
	const counted = store.shapeGroups(filter);
	const total = counted.reduce((n, g) => n + g.count, 0);
	const baseline = store.latestShapeHash(filter);
	const baseGroup = counted.find((g) => g.shape_hash === baseline);
	const ordered = baseGroup ? [baseGroup, ...counted.filter((g) => g !== baseGroup)] : counted;

	let merged: { shape: Shape; paths: Set<string>; results: number; since: string } | null = null;
	if (baseline !== null) {
		const merger = new ShapeMerger();
		let results = 0;
		let since = '';
		for (const r of store.recentShapes(filter, baseline, maxMerge)) {
			if (results === 0) since = r.created_at;
			merger.add(JSON.parse(r.shape) as Shape);
			results++;
		}
		const shape = merger.result();
		merged = { shape, paths: new Set(Object.keys(shape.paths)), results, since };
	}

	const cap = (list: string[]) =>
		list.length > DESCRIBE_MAX_DIFF_PATHS
			? {
					list: list.slice(0, DESCRIBE_MAX_DIFF_PATHS),
					more: list.length - DESCRIBE_MAX_DIFF_PATHS
				}
			: { list, more: 0 };
	/** Same shape means the same path set — read only the latest one */
	const pathsOf = (hash: string): Set<string> => {
		if (hash === baseline && merged) return merged.paths;
		for (const r of store.recentShapes(filter, hash, 1)) {
			return new Set(Object.keys((JSON.parse(r.shape) as Shape).paths));
		}
		return new Set();
	};
	const groups: ShapeGroup[] = ordered.slice(0, DESCRIBE_MAX_GROUPS).map((g) => {
		const paths = pathsOf(g.shape_hash);
		const base = merged?.paths;
		const added = cap(base ? [...paths].filter((p) => !base.has(p)) : []);
		const removed = cap(base ? [...base].filter((p) => !paths.has(p)) : []);
		return {
			shape_hash: g.shape_hash,
			count: g.count,
			first: g.first,
			last: g.last,
			task_ids: store.recentTaskIds(filter, g.shape_hash, 3),
			added: added.list,
			removed: removed.list,
			...(added.more > 0 ? { added_more: added.more } : {}),
			...(removed.more > 0 ? { removed_more: removed.more } : {})
		};
	});
	const partial = merged !== null && baseGroup !== undefined && merged.results < baseGroup.count;
	const build = (kept: number, shape: Shape | null): WorkerShapes => {
		const rest = ordered.slice(kept);
		return {
			worker: filter.worker ?? '',
			total,
			baseline,
			groups: groups.slice(0, kept),
			others:
				rest.length > 0
					? { groups: rest.length, count: rest.reduce((n, g) => n + g.count, 0) }
					: null,
			shape,
			shape_results: merged?.results ?? 0,
			shape_since: merged?.since ?? null,
			...(partial
				? {
						note:
							`values and ranges in shape cover the latest ${merged!.results} of ${baseGroup!.count} results ` +
							`with this shape (since ${merged!.since}). For all of them, query with json_extract — min/max or DISTINCT`
					}
				: {})
		};
	};
	let kept = groups.length;
	for (;;) {
		const fitted = merged
			? fitShape(merged.shape, (s) => jsonBytes(build(kept, s)) <= maxBytes)
			: null;
		const out = build(kept, fitted);
		if (kept === 0 || jsonBytes(out) <= maxBytes) return out;
		kept = Math.floor(kept / 2);
	}
}
