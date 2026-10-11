/**
 * Local dashboard data (docs/design/15_cli.md §9) — **reads only** the control DB, the project's data.db and the JSONL logs.
 *
 * - Opens and closes per request — no long read transactions (so a running start's WAL checkpoint isn't blocked)
 * - The two DBs are joined on task_id. Rows present on only one side are shown too:
 *     control DB only = runs without a saved result (cancelled, failed before running, built-in read worker) or results deleted from data.db
 *     data.db only    = runs not in this PC's history — usually history removed by `tasks prune` (or a control DB from another PC/folder). The raw result remains
 * - Worker files are never imported (top-level code would run) — metadata comes from the last sync found in recent app logs (up to 64MB)
 * - Read failures (permissions, corruption) are not hidden as "none" — missing (no file/folder) and unreadable are kept apart
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import {
	WORKER_LOG_DIR,
	builtinResultsName,
	type LocalTaskState
} from '../../core/domain/index.ts';
import {
	ControlDb,
	type EndRecord,
	type QuotaRecord,
	type StopRecord,
	type TaskRow
} from '../../core/control-db.ts';
import { readRunner, type RunnerState } from '../../core/host/runner-lock.ts';
import { hostUsage } from '../../core/host/usage.ts';
import { findLastRecord, parseRecord, readIfExists, tailLines } from '../../core/log-read.ts';
import {
	channelDir,
	listAllLogFiles,
	listChannelFiles,
	type LogRecord
} from '../../core/logger.ts';
import { utcDate } from '../../core/time.ts';
import { HOST_META } from '../workers/builtin/host-identity.ts';
import {
	ResultStore,
	resultsDbBytes,
	resultsDbPath,
	type ResultRow,
	type StoredResult
} from '../workers/results/store.ts';
import { parseSettings } from '../workers/repeat-scheduler.ts';
import { workerFiles } from '../workers/workers.ts';

export interface Sources {
	dataDir: string;
	logsDir: string;
	/** This host's project folder — without it the data.db and workers views are empty */
	projectRoot: string | null;
	workersDir: string | null;
	now(): number;
}

/** Overview periods — summary and trend look at recent activity */
export const RANGES = ['today', '7d', '30d'] as const;
export type Range = (typeof RANGES)[number];

/** Runs periods — default 7 days as in Overview. The control DB and data.db are never auto-pruned, so `all` is offered too */
export const RUN_RANGES = [...RANGES, 'all'] as const;
export type RunRange = (typeof RUN_RANGES)[number];

/** Displayed state — received and running both show as "running" */
export const RUN_STATES = ['completed', 'failed', 'cancelled', 'running', 'superseded'] as const;
export type RunState = (typeof RUN_STATES)[number];

/** Period start (epoch ms) — today is local midnight, 7d/30d are 7/30 days including today. null for all */
export function rangeStart(range: RunRange, now: number): number | null {
	if (range === 'all') return null;
	const d = new Date(now);
	const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	if (range === 'today') return midnight;
	const days = range === '7d' ? 6 : 29;
	const start = new Date(midnight);
	start.setDate(start.getDate() - days);
	return start.getTime();
}

function runState(state: LocalTaskState | 'completed' | 'failed'): RunState {
	return state === 'received' ? 'running' : state;
}

// ── Open ────────────────────────────────────────────────────

function withControl<T>(src: Sources, fn: (db: ControlDb) => T, fallback: T): T {
	const db = ControlDb.openReadOnly(src.dataDir);
	if (!db) return fallback;
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

function withResults<T>(src: Sources, fn: (store: ResultStore) => T, fallback: T): T {
	if (!src.projectRoot) return fallback;
	const store = ResultStore.openReadOnly(src.projectRoot);
	if (!store) return fallback;
	try {
		return fn(store);
	} finally {
		store.close();
	}
}

// ── Runs ────────────────────────────────────────────────────

export interface Run {
	task_id: string;
	worker: string;
	state: RunState;
	/** Sort and display time — received time, or the result save time without history */
	at: number;
	started_at: number | null;
	finished_at: number | null;
	duration_ms: number | null;
	delivery_attempt: number | null;
	run_count: number | null;
	last_error: string | null;
	bytes: number | null;
	reply: ResultRow['reply'] | null;
	source: ResultRow['source'] | null;
	/** Which DB it is in */
	in: 'both' | 'control' | 'results';
	/** Recurring task settings — only when in history. null without history (result only) */
	repeat: { interval_seconds: number; max_runs: number | null } | null;
	/** Recurrence progress from history (runs finished, failures, last run time, next due) */
	runs: number | null;
	failed: number | null;
	last_run_at: number | null;
	next_at: number | null;
	/** Runs saved in data.db — the result-side evidence of recurrence (survives history deletion). null if unknown */
	saved_runs: number | null;
}

export interface RunFilter {
	range: RunRange;
	worker?: string;
	state?: RunState;
}

/** Next page start — the sort key (at, task_id) of the previous page's last row */
export interface RunCursor {
	at: number;
	taskId: string;
}

export function encodeCursor(c: RunCursor): string {
	return `${c.at}.${c.taskId}`;
}

export function decodeCursor(raw: string | null): RunCursor | null {
	if (!raw) return null;
	const m = /^(\d{1,16})\.(.+)$/.exec(raw);
	return m ? { at: Number(m[1]), taskId: m[2] } : null;
}

function toRun(
	task: TaskRow | undefined,
	result: ResultRow | undefined,
	savedRuns: number | null = null
): Run {
	const t = task ?? null;
	const r = result ?? null;
	const repeat = parseSettings(t?.repeat);
	return {
		task_id: (t?.task_id ?? r?.task_id)!,
		worker: (t?.worker ?? r?.worker)!,
		state: runState(t?.state ?? r!.status),
		at: t?.received_at ?? Date.parse(r!.created_at),
		started_at: t?.started_at ?? null,
		finished_at: t?.finished_at ?? null,
		duration_ms:
			t?.started_at != null && t.finished_at != null ? t.finished_at - t.started_at : null,
		delivery_attempt: t?.delivery_attempt ?? null,
		run_count: t?.run_count ?? null,
		last_error: t?.last_error ?? null,
		bytes: r?.bytes ?? null,
		reply: r?.reply ?? null,
		source: r?.source ?? null,
		in: t && r ? 'both' : t ? 'control' : 'results',
		repeat: repeat
			? { interval_seconds: repeat.interval_seconds, max_runs: repeat.max_runs ?? null }
			: null,
		runs: t?.runs ?? null,
		failed: t?.failed ?? null,
		last_run_at: t?.last_run_at ?? null,
		next_at: t?.next_at ?? null,
		saved_runs: savedRuns
	};
}

/** Looks like a recurring task — from history settings, or from data.db run rows when history is gone */
export function isRepeat(run: Run): boolean {
	return run.repeat !== null || (run.saved_runs ?? 0) > 1;
}

/** Batch size for reading data.db while looking for result-only rows */
const RESULT_ONLY_BATCH = 500;

/**
 * Newest `limit` rows + next-page cursor (null if none). Sort key is (at DESC, task_id) — keyset paging (OFFSET slows with depth
 * and shifts when auto refresh brings new rows).
 *
 * The two DBs key differently — history rows by received time, result-only rows by save time — so each side is picked separately:
 * 1. limit+1 history rows (control DB) in key order. Boundary K = received time of the last one (no boundary if not filled)
 * 2. Result-only rows (in data.db, not in history) by save time down to K, at most limit+1 — read in batches, skipping results
 *    paired with history. Cutting the result side at "top N by save time" lets long runs (received early, saved late) take the
 *    slots, so result-only rows in between miss this page and the cursor passes them for good
 * 3. Result info (size, reply) for history rows is attached by task_id
 * Each candidate set holds every row that can land on this page, so merging and cutting is correct
 */
export function listRuns(
	src: Sources,
	filter: RunFilter,
	limit: number,
	after: RunCursor | null = null
): { runs: Run[]; next: RunCursor | null } {
	const since = rangeStart(filter.range, src.now());
	const states: LocalTaskState[] | undefined =
		filter.state === undefined
			? undefined
			: filter.state === 'running'
				? ['received', 'running']
				: [filter.state];
	const fetch = limit + 1;

	// 1. History side
	const tasks = withControl(
		src,
		(db) =>
			db.listTasks(
				{
					...(since !== null ? { since } : {}),
					...(filter.worker !== undefined ? { worker: filter.worker } : {}),
					...(states ? { states } : {}),
					...(after ? { after } : {})
				},
				fetch
			),
		[] as TaskRow[]
	);
	const boundary = tasks.length === fetch ? tasks[tasks.length - 1].received_at : null;

	// 2. Result-only rows — data.db holds only completed and failed; other states have none
	const fromResults =
		filter.state === undefined || filter.state === 'completed' || filter.state === 'failed';
	const resultOnly = fromResults ? findResultOnly(src, filter, since, after, boundary, fetch) : [];

	// 3. Results for history rows — with the run count (recurring)
	const { paired, counts } = withResults(
		src,
		(store) => ({
			paired: store.rowsByIds(tasks.map((t) => t.task_id)),
			counts: store.runCounts([...tasks.map((t) => t.task_id), ...resultOnly.map((r) => r.task_id)])
		}),
		{ paired: [] as ResultRow[], counts: new Map<string, { runs: number; lastRunNo: number }>() }
	);
	const resultById = new Map(paired.map((r) => [r.task_id, r]));
	const saved = (id: string) => counts.get(id)?.runs ?? null;
	const merged = [
		...tasks.map((t) => toRun(t, resultById.get(t.task_id), saved(t.task_id))),
		...resultOnly.map((r) => toRun(undefined, r, saved(r.task_id)))
	]
		.filter((run) => filter.state === undefined || run.state === filter.state)
		// Safeguard — rows before the cursor (previous page) must not reappear
		.filter((run) => !after || before(run, after))
		.sort((a, b) => b.at - a.at || a.task_id.localeCompare(b.task_id));
	const runs = merged.slice(0, limit);
	const last = runs.at(-1);
	return {
		runs,
		next: merged.length > limit && last ? { at: last.at, taskId: last.task_id } : null
	};
}

/** Result-only rows (not in history) — by save time, from after the cursor down to boundary (inclusive), at most max */
function findResultOnly(
	src: Sources,
	filter: RunFilter,
	since: number | null,
	after: RunCursor | null,
	boundary: number | null,
	max: number
): ResultRow[] {
	const store = src.projectRoot ? ResultStore.openReadOnly(src.projectRoot) : null;
	if (!store) return [];
	const db = ControlDb.openReadOnly(src.dataDir);
	try {
		const out: ResultRow[] = [];
		let cursor = after
			? { createdAt: new Date(after.at).toISOString(), taskId: after.taskId }
			: undefined;
		for (;;) {
			const batch = store.list(
				{
					...(since !== null ? { since: new Date(since).toISOString() } : {}),
					...(filter.worker !== undefined ? { worker: filter.worker } : {}),
					...(filter.state === 'completed' || filter.state === 'failed'
						? { status: filter.state }
						: {}),
					...(cursor ? { after: cursor } : {}),
					// A recurring task has one row per run — take only the last run (no overlap across pages)
					latestRunOnly: true
				},
				RESULT_ONLY_BATCH
			);
			const known = new Set(
				db ? db.tasksByIds(batch.map((r) => r.task_id)).map((t) => t.task_id) : []
			);
			for (const r of batch) {
				// Rows older than the boundary can't be on this page (they sort after history row limit+1)
				if (boundary !== null && Date.parse(r.created_at) < boundary) return out;
				if (known.has(r.task_id)) continue;
				out.push(r);
				if (out.length >= max) return out;
			}
			if (batch.length < RESULT_ONLY_BATCH) return out;
			const last = batch[batch.length - 1];
			cursor = { createdAt: last.created_at, taskId: last.task_id };
		}
	} finally {
		db?.close();
		store.close();
	}
}

/** Whether run sorts after the cursor */
function before(run: Run, c: RunCursor): boolean {
	return run.at < c.at || (run.at === c.at && run.task_id > c.taskId);
}

export interface RunDetail {
	run: Run;
	/** Saved result (with payload) — one-off only. null for recurring (repeatRuns/runOfTask read runs, so large results aren't read on every auto refresh) */
	result: StoredResult | null;
}

/** Run detail — renders one-off tasks. For recurring ones (isRepeat), runs come from repeatRuns/runOfTask */
export function runDetail(src: Sources, taskId: string): RunDetail | null {
	const task = withControl(src, (db) => db.getTask(taskId), null);
	const found = withResults(
		src,
		(store) =>
			store.snapshot(() => {
				// Row info first — payload is read only for one-off tasks
				const latest = store.rowsByIds([taskId])[0] ?? null;
				const saved = store.runCounts([taskId]).get(taskId)?.runs ?? 0;
				if (!task && !latest) return null;
				const run = toRun(task ?? undefined, latest ?? undefined, saved || null);
				return { run, result: latest && !isRepeat(run) ? store.get(taskId) : null };
			}),
		undefined
	);
	if (found === null) return null;
	// No data.db (no project folder, etc.) — history only
	if (found === undefined) return task ? { run: toRun(task, undefined, null), result: null } : null;
	return found;
}

/** One page of the run list in recurring-task detail */
export const RUNS_DETAIL_PAGE = 50;
/** Previews only for runs up to this size — payloads are read per page, so large results are skipped */
export const PREVIEW_MAX_BYTES = 64 * 1024;
/** Characters in a one-line preview */
export const PREVIEW_CHARS = 120;

export interface RunPreview extends ResultRow {
	/** Start of the result JSON (completed) or first line of the error message (failed). null when large */
	preview: string | null;
	large: boolean;
}

export interface RepeatRuns {
	/** Newest run first */
	runs: RunPreview[];
	/** Key for the next (older) page — runs before this run_no. null if none */
	runsNext: number | null;
	/** Number of saved runs */
	total: number;
}

/** Run list of a recurring task — run_no keyset, with previews */
export function repeatRuns(src: Sources, taskId: string, runsBefore?: number): RepeatRuns {
	const found = withResults(
		src,
		(store) =>
			store.snapshot(() => ({
				page: store.runPreviews(taskId, RUNS_DETAIL_PAGE + 1, runsBefore, PREVIEW_MAX_BYTES),
				total: store.runCounts([taskId]).get(taskId)?.runs ?? 0
			})),
		{ page: [] as (ResultRow & { payload: string | null })[], total: 0 }
	);
	const runs = found.page.slice(0, RUNS_DETAIL_PAGE).map(({ payload, ...row }) => ({
		...row,
		preview: payload === null ? null : previewOf(row.status, payload),
		large: payload === null
	}));
	return {
		runs,
		runsNext: found.page.length > RUNS_DETAIL_PAGE ? (runs.at(-1)?.run_no ?? null) : null,
		total: found.total
	};
}

/**
 * One list line — newlines and runs of spaces collapse to one. completed is the start of the stored text (the executor's compact
 * JSON.stringify), not parsed. failed is the first line of the error JSON's `message` (unparsable → start of the raw text, not hidden, as in the result viewer)
 */
export function previewOf(status: 'completed' | 'failed', payload: string): string {
	let text = payload;
	if (status === 'failed') {
		try {
			const v = JSON.parse(payload) as unknown;
			const message =
				v !== null && typeof v === 'object' ? (v as { message?: unknown }).message : undefined;
			if (typeof message === 'string') text = message.split('\n')[0];
		} catch {
			// fall back to the start of the raw text
		}
	}
	// Cut generously before collapsing whitespace — avoids running the regex over the full 64 KiB
	const cut = text.length > PREVIEW_CHARS * 4;
	text = (cut ? text.slice(0, PREVIEW_CHARS * 4) : text).replace(/\s+/g, ' ').trim();
	if (text.length <= PREVIEW_CHARS) return cut ? `${text}…` : text;
	// Don't split a surrogate pair (emoji etc.)
	const end = /[\uD800-\uDBFF]/.test(text[PREVIEW_CHARS - 1]) ? PREVIEW_CHARS - 1 : PREVIEW_CHARS;
	return `${text.slice(0, end)}…`;
}

export interface RunOfTask {
	/** That run — null if not saved */
	result: StoredResult | null;
	/** Adjacent saved runs (previous, next) */
	prev: number | null;
	next: number | null;
	/** Start (exclusive) of this run's log window — e.g. the previous saved run's save time. Used by runLog */
	from: number;
}

/** One run of a recurring task */
export function runOfTask(src: Sources, run: Run, runNo: number): RunOfTask {
	const found = withResults(
		src,
		(store) =>
			store.snapshot(() => ({
				result: store.get(run.task_id, runNo),
				prevRow: store.runs(run.task_id, 1, runNo)[0] ?? null,
				next: store.nextRunNo(run.task_id, runNo)
			})),
		{
			result: null as StoredResult | null,
			prevRow: null as ResultRow | null,
			next: null as number | null
		}
	);
	const savedAt = found.result ? Date.parse(found.result.created_at) : src.now();
	return {
		result: found.result,
		prev: found.prevRow?.run_no ?? null,
		next: found.next,
		from: runLogStart(run, runNo, savedAt, found.prevRow)
	};
}

/**
 * Start of a run's log window — a recurring task runs one run at a time (docs/design/15_cli.md §8-7), so this run starts after the
 * previous one was saved. Without a previous saved run: run 1 starts at received time (slightly before). Otherwise (previous run
 * pruned by `worker results prune` or never saved) one interval before save — received time would pull in days of lines. Unknown
 * interval (no history) → 10 minutes before save. Never reads more than a day, even when unsaved runs widen the window
 */
function runLogStart(run: Run, runNo: number, savedAt: number, prev: ResultRow | null): number {
	let start: number;
	if (prev) start = Date.parse(prev.created_at);
	else if (runNo === 1 && run.in !== 'results') start = run.at - RUN_LOG_MARGIN_MS;
	else if (run.repeat) start = savedAt - run.repeat.interval_seconds * 1000;
	else start = savedAt - TASK_LOG_MARGIN_MS;
	return Math.max(start, savedAt - TASK_LOG_MAX_SPAN_MS);
}

/** Cache of worker names in history — it scans the whole history (about 170 ms at 3M rows), so not on every auto refresh */
const HISTORY_WORKERS_TTL_MS = 60_000;
const historyWorkers = new Map<string, { at: number; names: string[] }>();

/** Worker names for the list filter — every name in history or files */
export function knownWorkers(src: Sources): string[] {
	const names = new Set<string>();
	const now = src.now();
	let cached = historyWorkers.get(src.dataDir);
	if (!cached || now - cached.at >= HISTORY_WORKERS_TTL_MS) {
		cached = { at: now, names: withControl(src, (db) => db.distinctWorkers(), []) };
		// Don't cache an empty result (no history) — so the list isn't empty for a minute after the first start
		if (cached.names.length > 0) historyWorkers.set(src.dataDir, cached);
	}
	for (const name of cached.names) names.add(name);
	for (const name of workerFilesIfAny(src.workersDir)?.keys() ?? []) names.add(name);
	return [...names].sort();
}

/** Host name cache — avoids opening the control DB on every view (including auto refresh) */
const HOST_NAME_TTL_MS = 60_000;
const hostNames = new Map<string, { at: number; name: string }>();

/**
 * Host name the UI uses instead of "this PC" — the name registered on the server (Overview's Host row, the name remote AIs see).
 * Before start/login, this PC's hostname. On read failure (corruption, permissions) also the hostname, without breaking the view —
 * the relevant view shows the cause. Only the server name is cached, so it updates right after login
 */
export function hostName(src: Sources): string {
	const now = src.now();
	const cached = hostNames.get(src.dataDir);
	if (cached && now - cached.at < HOST_NAME_TTL_MS) return cached.name;
	let name: string | null = null;
	try {
		name = withControl(src, (db) => db.getMeta(HOST_META.name), null);
	} catch {
		// fall through to the hostname below
	}
	if (name) {
		hostNames.set(src.dataDir, { at: now, name });
		return name;
	}
	return hostname();
}

// ── Overview ────────────────────────────────────────────────

export interface Counts {
	total: number;
	completed: number;
	failed: number;
	cancelled: number;
	running: number;
	superseded: number;
}

export interface Overview {
	range: Range;
	since: number;
	totals: Counts;
	byWorker: ({ worker: string } & Counts)[];
	/** Per bucket — hourly for today, daily otherwise. Empty buckets are filled with 0 */
	trend: { unit: 'day' | 'hour'; buckets: ({ bucket: string } & Counts)[] };
	recentFailures: TaskRow[];
	runner: RunnerState;
	lastResponse: QuotaRecord | null;
	stop: StopRecord | null;
	end: EndRecord | null;
	host: { id: string | null; name: string | null };
	disk: {
		controlDb: { file: string; bytes: number; tasks: number } | null;
		dataDb: { file: string; bytes: number; results: number } | null;
		logs: { dir: string; bytes: number; files: number };
	};
	hasControlDb: boolean;
}

function emptyCounts(): Counts {
	return { total: 0, completed: 0, failed: 0, cancelled: 0, running: 0, superseded: 0 };
}

function add(c: Counts, state: LocalTaskState, n: number): void {
	c.total += n;
	c[runState(state)] += n;
}

export function overview(src: Sources, range: Range): Overview {
	const now = src.now();
	const since = rangeStart(range, now)!;
	const unit = range === 'today' ? 'hour' : 'day';
	const totals = emptyCounts();
	const workers = new Map<string, Counts>();
	const buckets = new Map<string, Counts>(
		bucketKeys(since, now, unit).map((k) => [k, emptyCounts()])
	);

	const fromDb = withControl(
		src,
		(db) => {
			for (const r of db.countGrouped(since, unit)) {
				add(totals, r.state, r.n);
				if (!workers.has(r.worker)) workers.set(r.worker, emptyCounts());
				add(workers.get(r.worker)!, r.state, r.n);
				if (!buckets.has(r.bucket)) buckets.set(r.bucket, emptyCounts());
				add(buckets.get(r.bucket)!, r.state, r.n);
			}
			const usage = hostUsage(db, src.logsDir);
			return {
				recentFailures: db.listTasks({ since, states: ['failed'] }, 8),
				lastResponse: db.getQuota(),
				stop: db.getStop(),
				end: db.getEnd(),
				host: { id: db.getMeta(HOST_META.id), name: db.getMeta(HOST_META.name) },
				usage
			};
		},
		null
	);

	const logs = logUsage(src.logsDir);
	const dataBytes = src.projectRoot ? resultsDbBytes(src.projectRoot) : null;
	const results = withResults(src, (store) => store.usage().count, 0);

	return {
		range,
		since,
		totals,
		byWorker: [...workers]
			.map(([worker, c]) => ({ worker, ...c }))
			.sort((a, b) => b.total - a.total || a.worker.localeCompare(b.worker)),
		trend: {
			unit,
			buckets: [...buckets]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([bucket, c]) => ({ bucket, ...c }))
		},
		recentFailures: fromDb?.recentFailures ?? [],
		runner: readRunner(src.dataDir),
		lastResponse: fromDb?.lastResponse ?? null,
		stop: fromDb?.stop ?? null,
		end: fromDb?.end ?? null,
		host: fromDb?.host ?? { id: null, name: null },
		disk: {
			controlDb: fromDb?.usage.controlDb
				? {
						file: fromDb.usage.controlDb.file,
						bytes: fromDb.usage.controlDb.bytes,
						tasks: fromDb.usage.controlDb.tasks
					}
				: null,
			dataDb:
				src.projectRoot && dataBytes !== null
					? { file: resultsDbPath(src.projectRoot), bytes: dataBytes, results }
					: null,
			logs
		},
		hasControlDb: fromDb !== null
	};
}

/** Bucket labels from since to now — same format as SQLite strftime(localtime) */
function bucketKeys(since: number, now: number, unit: 'day' | 'hour'): string[] {
	const keys: string[] = [];
	const d = new Date(since);
	const pad = (n: number) => String(n).padStart(2, '0');
	while (d.getTime() <= now) {
		const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
		keys.push(unit === 'day' ? day : `${day} ${pad(d.getHours())}`);
		if (unit === 'day') d.setDate(d.getDate() + 1);
		else d.setHours(d.getHours() + 1);
	}
	return keys;
}

/** 0 when the folder is missing (handled by listAllLogFiles). Read failures (permissions etc.) throw instead of returning 0 */
function logUsage(logsDir: string): { dir: string; bytes: number; files: number } {
	const files = listAllLogFiles(logsDir);
	return { dir: logsDir, bytes: files.reduce((n, f) => n + f.size, 0), files: files.length };
}

// ── Workers ─────────────────────────────────────────────────

export interface SyncedWorker {
	name: string;
	description: string | null;
	timeout_ms: number | null;
	input_schema: boolean;
	problem: string | null;
	message: string | null;
}

export interface LastSync {
	at: number;
	event: string;
	/** Server verdict — registered, etc. */
	results: Map<string, string>;
	rejected: Map<string, string>;
	/** Export values read at this sync — absent from logs written by CLI versions before 0.9 */
	local: Map<string, SyncedWorker> | null;
}

export interface WorkerFile {
	name: string;
	files: { file: string; bytes: number; modifiedAt: number }[];
}

export interface WorkersView {
	dir: string | null;
	dirMissing: boolean;
	/** The folder couldn't be read (permissions etc.) — distinct from missing */
	error: string | null;
	files: WorkerFile[];
	lastSync: LastSync | null;
	/** This host's built-in read worker name — null while the host id is unknown (before start/status) */
	builtin: string | null;
}

export function workersView(src: Sources): WorkersView {
	const lastSync = readLastSync(src.logsDir);
	const hostId = withControl(src, (db) => db.getMeta(HOST_META.id), null);
	const builtin = hostId ? builtinResultsName(hostId) : null;
	if (!src.workersDir)
		return { dir: null, dirMissing: true, error: null, files: [], lastSync, builtin };
	let map: Map<string, string[]> | null;
	try {
		map = workerFilesIfAny(src.workersDir);
	} catch (err) {
		// The folder exists but is unreadable (permissions etc.) — show the cause instead of a wrong "missing → init" hint
		return {
			dir: src.workersDir,
			dirMissing: false,
			error: (err as Error).message,
			files: [],
			lastSync,
			builtin
		};
	}
	if (!map)
		return { dir: src.workersDir, dirMissing: true, error: null, files: [], lastSync, builtin };
	const files = [...map].map(([name, list]) => ({
		name,
		files: list.map((file) => {
			const st = statSync(file, { throwIfNoEntry: false });
			return { file, bytes: st?.size ?? 0, modifiedAt: st?.mtimeMs ?? 0 };
		})
	}));
	return { dir: src.workersDir, dirMissing: false, error: null, files, lastSync, builtin };
}

/**
 * Cap on reading backwards for the last sync — counted in bytes, not files (a busy host splits logs at 10MB into several files a day).
 * Past it, the sync counts as not found and the view says "not in recent logs"
 */
export const SYNC_SCAN_MAX_BYTES = 64 * 1024 * 1024;

function readLastSync(logsDir: string): LastSync | null {
	// Read failures (permissions etc.) throw instead of passing as "no sync"
	const record = findLastRecord(
		channelDir(logsDir, null),
		(r) => r.body === 'workers synced' || r.body === 'workers resynced',
		{ maxBytes: SYNC_SCAN_MAX_BYTES, contains: 'workers ' }
	);
	if (!record) return null;
	const a = record.attributes ?? {};
	const pairs = (value: unknown, key: string): Map<string, string> =>
		new Map(
			(Array.isArray(value) ? value : [])
				.filter((v): v is Record<string, unknown> => v !== null && typeof v === 'object')
				.map((v) => [String(v.name), String(v[key])])
		);
	return {
		at: Date.parse(record.timestamp),
		event: record.body,
		results: pairs(a.workers, 'result'),
		rejected: pairs(a.rejected, 'code'),
		local: Array.isArray(a.local)
			? new Map(
					(a.local as SyncedWorker[])
						.filter((w) => w !== null && typeof w === 'object')
						.map((w) => [String(w.name), w])
				)
			: null
	};
}

/** Files in the workers folder — null if the folder is missing. If unreadable (permissions etc.), rethrows workerFiles' CliError */
function workerFilesIfAny(dir: string | null): Map<string, string[]> | null {
	if (!dir || !existsSync(dir)) return null;
	return workerFiles(dir);
}

/** Source of one worker file — read as text only (never imported). Only names present in the folder are accepted (path traversal) */
export const CODE_MAX_BYTES = 512 * 1024;

export function workerSource(
	src: Sources,
	name: string
): { file: string; text: string; truncated: boolean; bytes: number }[] | null {
	// A folder read failure throws instead of hiding as 404 (the cause goes into the 500)
	const files = workerFilesIfAny(src.workersDir)?.get(name);
	if (!files) return null;
	return files.map((file) => {
		const buf = readFileHead(file, CODE_MAX_BYTES + 1);
		const truncated = buf.length > CODE_MAX_BYTES;
		return {
			file,
			text: buf.subarray(0, CODE_MAX_BYTES).toString('utf8'),
			truncated,
			bytes: statSync(file, { throwIfNoEntry: false })?.size ?? buf.length
		};
	});
}

function readFileHead(file: string, max: number): Buffer {
	// Only the head via openSync/readSync — never the whole of a large file
	const fd = openSync(file, 'r');
	try {
		const buf = Buffer.alloc(max);
		const n = readSync(fd, buf, 0, max, 0);
		return buf.subarray(0, n);
	} finally {
		closeSync(fd);
	}
}

// ── Logs ────────────────────────────────────────────────────

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LevelFilter = (typeof LOG_LEVELS)[number];

export interface LogLine {
	record: LogRecord | null;
	/** A line that couldn't be parsed as a record */
	raw: string | null;
	channel: string | null;
}

/** Worker channels with logs + workers that currently have a file */
export function logChannels(src: Sources): string[] {
	const names = new Set<string>();
	const workerLogs = path.join(src.logsDir, WORKER_LOG_DIR);
	// No worker logs yet means no folder — other read failures throw
	if (existsSync(workerLogs)) {
		for (const e of readdirSync(workerLogs, { withFileTypes: true })) {
			if (e.isDirectory()) names.add(e.name);
		}
	}
	for (const name of workerFilesIfAny(src.workersDir)?.keys() ?? []) names.add(name);
	return [...names].sort();
}

/** Backward-read cap when filtering by level — so a rare level (error) doesn't read all retained logs (logMaxBytes, default 300MB) on every auto refresh */
export const LOG_SCAN_MAX_BYTES = 32 * 1024 * 1024;

export interface LogRead {
	lines: LogLine[];
	/** Hit the cap (LOG_SCAN_MAX_BYTES); older files were not read */
	truncated: boolean;
}

/**
 * Recent lines of a channel — reads backwards from the newest file until `lines` **matching** lines are collected ("last 100 error
 * lines", not "errors among the last 100 lines"). Unfiltered: the last `lines` lines. Returned oldest first
 */
export function readLog(
	src: Sources,
	channel: string | null,
	opts: { lines: number; minLevel?: LevelFilter }
): LogRead {
	const dir = channelDir(src.logsDir, channel);
	const min = opts.minLevel ? LOG_LEVELS.indexOf(opts.minLevel) : 0;
	if (min <= 0) {
		return { lines: tailLines(dir, opts.lines).map((l) => toLine(l, channel)), truncated: false };
	}
	const out: LogLine[] = [];
	let scanned = 0;
	for (const f of listChannelFiles(dir).reverse()) {
		if (scanned >= LOG_SCAN_MAX_BYTES) return { lines: out.reverse(), truncated: true };
		const text = readIfExists(f.file);
		if (text === null) continue; // pruned in the meantime
		scanned += f.size;
		const lines = text.split('\n');
		for (let i = lines.length - 1; i >= 0 && out.length < opts.lines; i--) {
			const record = parseRecord(lines[i]);
			if (record && levelOf(record) >= min) out.push({ record, raw: null, channel });
		}
		if (out.length >= opts.lines) break;
	}
	return { lines: out.reverse(), truncated: false };
}

function levelOf(record: LogRecord): number {
	const level = LOG_LEVELS.indexOf(record.severity_text);
	return level === -1 ? LOG_LEVELS.length : level; // unknown levels are never filtered out
}

function toLine(line: string, channel: string | null): LogLine {
	const record = parseRecord(line);
	return record ? { record, raw: null, channel } : { record: null, raw: line, channel };
}

/** Time margin when looking for task logs — reply records after the end, clock differences */
const TASK_LOG_MARGIN_MS = 10 * 60_000;
/** Max span taskLog reads — so a recurring task's detail doesn't read all retained logs */
const TASK_LOG_MAX_SPAN_MS = 24 * 60 * 60 * 1000;

export interface TaskLog {
	lines: LogLine[];
	/** No log file exists for the run's dates — usually pruned by retention period or size */
	deleted: boolean;
	/** Logs couldn't be read (permissions etc.) — the view shows only this section as failed */
	error?: string;
}

/**
 * Lines of one task — app log (received, start, end, reply) and that worker's log, in time order. Log files are per UTC date, so only
 * the date files covering the run (received time, or save time for result-only, to end time, ±10 min) are read whole — searching the
 * last N lines would miss older runs of chatty workers. Span is at most a day back from the end — long recurring tasks show recent runs only
 */
export function taskLog(src: Sources, run: Run): TaskLog {
	const to =
		(run.finished_at ?? (run.state === 'running' ? src.now() : run.at)) + TASK_LOG_MARGIN_MS;
	// Recurring tasks stay running for days or weeks — reading from the received date would read all retained logs (up to 300MB). Last day only
	const from = Math.max(run.at - TASK_LOG_MARGIN_MS, to - TASK_LOG_MAX_SPAN_MS);
	return scanTaskLines(src, run, from, to, () => true);
}

/** End margin of a run's log window — app logs right after save (run end, progress). Shorter than the next run's start (one interval later) */
export const RUN_LOG_MARGIN_MS = 5_000;

/**
 * Lines of one run of a recurring task — lines with a `run_no` attribute are matched exactly. Others (worker logs from older CLIs,
 * run-independent app logs) by time window (from, save time + margin] — one run at a time per task (docs/design/15_cli.md §8-7)
 */
export function runLog(
	src: Sources,
	run: Run,
	runNo: number,
	from: number,
	savedAt: number
): TaskLog {
	const to = savedAt + RUN_LOG_MARGIN_MS;
	return scanTaskLines(src, run, from, to, (record) => {
		const n = record.attributes?.run_no;
		if (typeof n === 'number') return n === runNo;
		const at = Date.parse(record.timestamp);
		return at > from && at <= to;
	});
}

/**
 * Lines of the task — app log and that worker's log, in time order. Log files are per UTC date, so the date files for from–to are
 * read whole and lines are further filtered by keep
 */
function scanTaskLines(
	src: Sources,
	run: Run,
	from: number,
	to: number,
	keep: (record: LogRecord) => boolean
): TaskLog {
	const first = utcDate(from);
	const last = utcDate(to);
	const lines: LogLine[] = [];
	let files = 0;
	for (const channel of [null, run.worker]) {
		for (const f of listChannelFiles(channelDir(src.logsDir, channel))) {
			if (f.date < first || f.date > last) continue;
			const text = readIfExists(f.file);
			if (text === null) continue;
			files++;
			// String-filter before parsing JSON per line — most lines lack the task_id
			for (const line of text.split('\n')) {
				if (!line.includes(run.task_id)) continue;
				const record = parseRecord(line);
				if (record?.attributes?.task_id === run.task_id && keep(record))
					lines.push({ record, raw: null, channel });
			}
		}
	}
	lines.sort((a, b) => (a.record?.timestamp ?? '').localeCompare(b.record?.timestamp ?? ''));
	return { lines, deleted: files === 0 };
}
