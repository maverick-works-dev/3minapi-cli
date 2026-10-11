/**
 * Control DB — the CLI's own state store (`node:sqlite`). docs/design/15_cli.md §7-2.
 *
 * Holds: local state of received tasks (duplicate-run guard, run history) and meta (stop reason, last quota, etc.).
 * **No automatic deletion** — only `tasks prune` deletes. Unfinished tasks and tasks finished less than 1 day ago are never deleted
 * Does not hold: tokens, task input/result. `last_error` is redacted, then truncated.
 * `callback_url` and `acked_at` are kept to finish previous runs after a restart (columns outside the schema version — ensureColumns).
 * Repeating tasks (docs/design/15_cli.md §8-7) keep settings, progress and **input** — resuming after a restart needs the input (the server does
 * not resend after ack) — and it is deleted when the repeat ends. A repeat stays `running` until it ends.
 *
 * - All times are epoch ms (UTC)
 * - Schema version = `PRAGMA user_version`. A DB newer than the code (made by a newer CLI) is not opened
 * - WAL + synchronous=NORMAL. Busy timeout is set only via the constructor `timeout` (do not duplicate it with a PRAGMA)
 * - The file is created 0600 before opening — SQLite copies the main file's mode to -wal and -shm
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import {
	CONTROL_DB_FILE,
	ConfigError,
	DB_BUSY_TIMEOUT_MS,
	NewerSchemaError,
	LAST_ERROR_MAX_CHARS,
	TASKS_PRUNE_BATCH,
	TASKS_PRUNE_MIN_AGE_MS,
	type LiveState,
	type LocalTaskState,
	type Quota,
	type RepeatSettings,
	type StopReason
} from './domain/index.ts';
import { redactAndTruncate } from './redact.ts';
import { touchSecretFile } from './secure-fs.ts';

/** Applied in order. Once shipped, an entry is never edited — append new ones */
export const MIGRATIONS: readonly string[] = [
	// v1 (#1361)
	`CREATE TABLE tasks (
		task_id          TEXT PRIMARY KEY,
		worker           TEXT NOT NULL,
		state            TEXT NOT NULL CHECK (state IN ('received','running','completed','failed','cancelled','superseded')),
		lease_id         TEXT,
		delivery_attempt INTEGER NOT NULL DEFAULT 1,
		run_count        INTEGER NOT NULL DEFAULT 0,
		received_at      INTEGER NOT NULL,
		started_at       INTEGER,
		finished_at      INTEGER,
		last_error       TEXT
	) STRICT;
	CREATE INDEX tasks_finished ON tasks (state, finished_at);
	CREATE TABLE meta (
		key        TEXT PRIMARY KEY,
		value      TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	) STRICT;`
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export const TERMINAL_STATES = ['completed', 'failed', 'cancelled', 'superseded'] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

/** meta keys — stop (server stop code, exit 4/5) and termination (zero active workers, exit 1) are kept separate */
export const META = {
	stopReason: 'stop_reason',
	stoppedAt: 'stopped_at',
	quotaResetAt: 'quota_reset_at'
} as const;

export const END_META = {
	reason: 'end_reason',
	endedAt: 'ended_at',
	workers: 'end_workers'
} as const;

/** Last received quota — from poll, sync and status responses. Kept so it can be shown without a server call */
export const QUOTA_META = { quota: 'quota' } as const;

/**
 * live receive (docs/design/15_cli.md §7-2) — `state` is this run's connection state (`LiveState` JSON, written only on change, cleared when
 * start begins); `url` is the address from the last sync or `GET /host` (used by doctor — kept after the run ends)
 */
export const LIVE_META = { state: 'live_state', url: 'live_url' } as const;

export interface QuotaRecord {
	quota: Quota;
	/** Received time (epoch ms) */
	at: number;
}

/** Target of `tasks prune` — finished tasks whose finished_at is before `before` (epoch ms) */
export interface TaskPruneFilter {
	before: number;
	worker?: string;
}

/** Dashboard list filter — since is epoch ms (received time) */
export interface TaskListFilter {
	since?: number;
	/** Next page — after this row (keyset pagination) */
	after?: { at: number; taskId: string };
	worker?: string;
	states?: readonly LocalTaskState[];
}

/** start exited on its own for a reason other than a server stop (docs/design/14_cli_host.md §10) */
export type EndReason = 'no_active_workers';

export interface EndRecord {
	reason: EndReason;
	endedAt: number;
	/** Workers deactivated because they were deleted on the server — empty array when the sync rejected all of them */
	deletedWorkers: string[];
}

export interface ReceivedTask {
	task_id: string;
	worker: string;
	lease_id: string;
	delivery_attempt: number;
	/** Reply address — null for direct local calls */
	callback_url?: string | null;
	/** Repeating tasks only — the server envelope's `data.repeat` and input. On redelivery the progress columns are left unchanged */
	repeat?: RepeatSettings | null;
	input?: unknown;
}

export interface TaskRow {
	task_id: string;
	worker: string;
	state: LocalTaskState;
	lease_id: string | null;
	delivery_attempt: number;
	run_count: number;
	received_at: number;
	started_at: number | null;
	finished_at: number | null;
	last_error: string | null;
	/** When the ack (working report) reached the server. undefined when a DB without this column is opened read-only */
	acked_at?: number | null;
	callback_url?: string | null;
	/** Repeating tasks — the fields below are undefined when a DB without these columns is opened read-only. `repeat` is the settings JSON */
	repeat?: string | null;
	input_json?: string | null;
	/** Last run started */
	run_no?: number | null;
	/** Next run's scheduled time */
	next_at?: number | null;
	fail_streak?: number | null;
	runs?: number | null;
	failed?: number | null;
	last_run_at?: number | null;
}

/** Progress after one repeat run ends */
export interface RepeatProgressRow {
	runs: number;
	failed: number;
	failStreak: number;
	lastRunAt: number;
}

export interface StopRecord {
	reason: StopReason;
	stoppedAt: number;
	/** Reset time for quota_exhausted (ISO 8601 UTC) — the last successful response's quota.reset_at. null if unknown */
	quotaResetAt: string | null;
}

export class ControlDb {
	readonly file: string;
	private readonly db: DatabaseSync;

	private constructor(file: string, db: DatabaseSync) {
		this.file = file;
		this.db = db;
	}

	/** Open failures become a ConfigError with the path and fix — raw fs/SQLite errors look like CLI bugs */
	static open(dataDir: string): ControlDb {
		const file = path.join(dataDir, CONTROL_DB_FILE);
		let db: DatabaseSync | undefined;
		try {
			touchSecretFile(file);
			db = new DatabaseSync(file, { timeout: DB_BUSY_TIMEOUT_MS });
			db.exec('PRAGMA journal_mode = WAL');
			db.exec('PRAGMA synchronous = NORMAL');
			migrate(db, file);
			ensureColumns(db);
			ensureIndexes(db);
			return new ControlDb(file, db);
		} catch (err) {
			if (db?.isOpen) db.close();
			if (err instanceof ConfigError) throw err;
			throw new ConfigError(openFailure(file, err));
		}
	}

	/**
	 * Read-only — for the local dashboard. Never creates the file or changes mode or schema (WAL lets it coexist with a running
	 * start). null if the file or tables do not exist yet. A schema newer than the code is rejected, as in open
	 */
	static openReadOnly(dataDir: string): ControlDb | null {
		const file = path.join(dataDir, CONTROL_DB_FILE);
		if (!existsSync(file)) return null;
		let db: DatabaseSync | undefined;
		try {
			db = new DatabaseSync(file, { readOnly: true, timeout: DB_BUSY_TIMEOUT_MS });
			const version = userVersion(db);
			if (version === 0) {
				db.close();
				return null;
			}
			if (version > SCHEMA_VERSION) throw new NewerSchemaError(file, version, SCHEMA_VERSION);
			return new ControlDb(file, db);
		} catch (err) {
			if (db?.isOpen) db.close();
			if (err instanceof ConfigError) throw err;
			throw new ConfigError(openFailure(file, err));
		}
	}

	/** Safe to call twice */
	close(): void {
		if (this.db.isOpen) this.db.close();
	}

	schemaVersion(): number {
		return userVersion(this.db);
	}

	/**
	 * Records a received task and decides whether to run it. Keyed by task_id (docs/design/14_cli_host.md §4).
	 * - New task / redelivery of an unfinished task → 'run' (the lease is replaced with the new one)
	 * - Already finished task → 'duplicate-done' — not run again
	 * - Except `superseded` (a run abandoned for another delivery), which is not finished — it runs when it comes back with a new lease.
	 *   A redelivery means the server did not get our ack; dropping it would make the server redeliver up to the limit and close it as failed
	 *
	 * An unfinished task means the previous run died midway (redelivery only comes before ack). For tasks running in this
	 * process, the runtime checks duplicates in memory first.
	 */
	receive(task: ReceivedTask, now: number): 'run' | 'duplicate-done' {
		return this.tx(() => {
			const row = this.getTask(task.task_id);
			if (
				row &&
				row.state !== 'superseded' &&
				(TERMINAL_STATES as readonly string[]).includes(row.state)
			)
				return 'duplicate-done';
			if (row) {
				this.db
					.prepare(
						`UPDATE tasks SET state = 'received', lease_id = ?, delivery_attempt = ?, worker = ?,
						        callback_url = ?, acked_at = NULL, repeat = ?, input_json = ?
						 WHERE task_id = ?`
					)
					.run(
						task.lease_id,
						task.delivery_attempt,
						task.worker,
						task.callback_url ?? null,
						...repeatColumns(task),
						task.task_id
					);
			} else {
				this.db
					.prepare(
						`INSERT INTO tasks (task_id, worker, state, lease_id, delivery_attempt, received_at, callback_url,
						                    repeat, input_json)
						 VALUES (?, ?, 'received', ?, ?, ?, ?, ?, ?)`
					)
					.run(
						task.task_id,
						task.worker,
						task.lease_id,
						task.delivery_attempt,
						now,
						task.callback_url ?? null,
						...repeatColumns(task)
					);
			}
			return 'run';
		});
	}

	/** The ack reached the server — from now on, finishing is the CLI's job (no redelivery, docs/design/14_cli_host.md §4) */
	markAcked(taskId: string, now: number): void {
		this.db.prepare('UPDATE tasks SET acked_at = ? WHERE task_id = ?').run(now, taskId);
	}

	/**
	 * Unfinished tasks — in received order. Called after `start` takes the runner lock and before the first pull/serve, all of them are
	 * leftovers of a previous run (one `start` per host; `worker run` does not write to this DB)
	 */
	unfinishedTasks(): TaskRow[] {
		// Repeats whose ack arrived are resumed, not finished (docs/design/15_cli.md §8-7) — see repeatTasks(). Otherwise the server resends, so close like a one-shot
		return this.db
			.prepare(
				`SELECT * FROM tasks WHERE state IN ('received', 'running')
				   AND NOT (repeat IS NOT NULL AND acked_at IS NOT NULL)
				 ORDER BY received_at, task_id`
			)
			.all() as unknown as TaskRow[];
	}

	/** Repeats to resume — ack arrived and not finished. In received order */
	repeatTasks(): TaskRow[] {
		return this.db
			.prepare(
				`SELECT * FROM tasks WHERE state IN ('received', 'running')
				   AND repeat IS NOT NULL AND acked_at IS NOT NULL
				 ORDER BY received_at, task_id`
			)
			.all() as unknown as TaskRow[];
	}

	/** Starts a repeat run — the first start time (`started_at`) is set only by run 1. It is first_run_at in the end summary */
	startRun(taskId: string, runNo: number, now: number): void {
		this.db
			.prepare(
				`UPDATE tasks SET state = 'running', run_no = ?, started_at = coalesce(started_at, ?),
				        run_count = run_count + 1
				 WHERE task_id = ?`
			)
			.run(runNo, now, taskId);
	}

	/** A repeat run ended */
	recordRun(taskId: string, p: RepeatProgressRow): void {
		this.db
			.prepare(
				'UPDATE tasks SET runs = ?, failed = ?, fail_streak = ?, last_run_at = ? WHERE task_id = ?'
			)
			.run(p.runs, p.failed, p.failStreak, p.lastRunAt, taskId);
	}

	setNextAt(taskId: string, nextAt: number): void {
		this.db.prepare('UPDATE tasks SET next_at = ? WHERE task_id = ?').run(nextAt, taskId);
	}

	markRunning(taskId: string, now: number): void {
		this.db
			.prepare(
				`UPDATE tasks SET state = 'running', started_at = ?, run_count = run_count + 1
				 WHERE task_id = ?`
			)
			.run(now, taskId);
	}

	/** For a repeat, also clears input — nothing left to resume (docs/design/15_cli.md §7-4) */
	markFinished(taskId: string, state: TerminalState, now: number, error?: string): void {
		this.db
			.prepare(
				`UPDATE tasks SET state = ?, finished_at = ?, last_error = ?, input_json = NULL WHERE task_id = ?`
			)
			.run(
				state,
				now,
				error === undefined ? null : redactAndTruncate(error, LAST_ERROR_MAX_CHARS),
				taskId
			);
	}

	getTask(taskId: string): TaskRow | null {
		const row = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
		return (row as TaskRow | undefined) ?? null;
	}

	/** Newest received first — local dashboard */
	listTasks(filter: TaskListFilter, limit: number): TaskRow[] {
		const conds: string[] = [];
		const params: (string | number)[] = [];
		if (filter.since !== undefined) {
			conds.push('received_at >= ?');
			params.push(filter.since);
		}
		if (filter.worker !== undefined) {
			conds.push('worker = ?');
			params.push(filter.worker);
		}
		if (filter.after !== undefined) {
			// After this row in sort order (received_at DESC, task_id) — ties broken by task_id
			// Keep `<=` outside so the received_at index range scan applies — OR alone becomes a MULTI-INDEX OR taking hundreds of ms (observed with 3M rows)
			conds.push('received_at <= ? AND (received_at < ? OR task_id > ?)');
			params.push(filter.after.at, filter.after.at, filter.after.taskId);
		}
		if (filter.states !== undefined) {
			conds.push(`state IN (${filter.states.map(() => '?').join(', ') || 'NULL'})`);
			params.push(...filter.states);
		}
		const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
		return this.db
			.prepare(`SELECT * FROM tasks ${where} ORDER BY received_at DESC, task_id LIMIT ?`)
			.all(...params, limit) as unknown as TaskRow[];
	}

	/** Several task_ids — for merging with result rows */
	tasksByIds(ids: readonly string[]): TaskRow[] {
		if (ids.length === 0) return [];
		return this.db
			.prepare(`SELECT * FROM tasks WHERE task_id IN (${ids.map(() => '?').join(', ')})`)
			.all(...ids) as unknown as TaskRow[];
	}

	/**
	 * Counts per (bucket, worker, status) within a range — the local dashboard Overview reads once and splits by worker and bucket (no second scan).
	 * A bucket is a date (`2026-10-05`) or hour (`2026-10-05 13`) in this process's time zone (SQLite localtime)
	 */
	countGrouped(
		since: number,
		unit: 'day' | 'hour'
	): { bucket: string; worker: string; state: LocalTaskState; n: number }[] {
		const format = unit === 'day' ? '%Y-%m-%d' : '%Y-%m-%d %H';
		return (
			this.db
				.prepare(
					`SELECT strftime('${format}', received_at / 1000, 'unixepoch', 'localtime') AS bucket, worker, state, count(*) AS n
					 FROM tasks WHERE received_at >= ? GROUP BY bucket, worker, state`
				)
				.all(since) as { bucket: string; worker: string; state: LocalTaskState; n: number }[]
		).map((r) => ({ ...r, n: Number(r.n) }));
	}

	/** Worker names in the history — full scan (about 170ms with 3M rows). The caller caches it */
	distinctWorkers(): string[] {
		return (this.db.prepare('SELECT DISTINCT worker FROM tasks').all() as { worker: string }[]).map(
			(r) => r.worker
		);
	}

	/** Counts per status — status. Repeats stay running until they end, so they are excluded from unfinished and counted separately */
	taskCounts(): { total: number; unfinished: number; repeating: number } {
		const row = this.db
			.prepare(
				`SELECT count(*) AS total,
				        coalesce(sum(state IN ('received','running') AND repeat IS NULL), 0) AS unfinished,
				        coalesce(sum(state IN ('received','running') AND repeat IS NOT NULL), 0) AS repeating
				 FROM tasks`
			)
			.get() as { total: number; unfinished: number; repeating: number };
		return {
			total: Number(row.total),
			unfinished: Number(row.unfinished),
			repeating: Number(row.repeating)
		};
	}

	/** Main file + `-wal` size — status */
	fileBytes(): number {
		const wal = `${this.file}-wal`;
		return statSync(this.file).size + (existsSync(wal) ? statSync(wal).size : 0);
	}

	/**
	 * What `tasks prune` would delete — count and approximate size (sum of value lengths). Unfinished tasks and tasks finished less than 1 day ago
	 * are excluded (pruneCutoff). recent = in range but kept because finished less than 1 day ago
	 */
	pruneUsage(
		filter: TaskPruneFilter,
		now: number
	): { count: number; bytes: number; recent: number } {
		const cutoff = pruneCutoff(filter.before, now);
		const { where, params } = pruneWhere(filter.worker, cutoff);
		const row = this.db
			.prepare(
				`SELECT count(*) AS count, coalesce(sum(${ROW_BYTES}), 0) AS bytes FROM tasks WHERE ${where}`
			)
			.get(...params) as { count: number; bytes: number };
		let recent = 0;
		if (cutoff < filter.before) {
			const r = pruneWhere(filter.worker, filter.before);
			recent =
				Number(
					(
						this.db
							.prepare(`SELECT count(*) AS n FROM tasks WHERE ${r.where} AND finished_at >= ?`)
							.get(...r.params, cutoff) as { n: number }
					).n
				) || 0;
		}
		return { count: Number(row.count), bytes: Number(row.bytes), recent };
	}

	/**
	 * Deletes finished tasks — same targets as pruneUsage. Commits TASKS_PRUNE_BATCH rows at a time so a running start gets the lock
	 * within its busy timeout. The file does not shrink (free pages are reused — VACUUM is skipped because its exclusive lock
	 * would collide with a running start)
	 */
	prune(filter: TaskPruneFilter, now: number): number {
		const { where, params } = pruneWhere(filter.worker, pruneCutoff(filter.before, now));
		const stmt = this.db.prepare(
			`DELETE FROM tasks WHERE rowid IN (SELECT rowid FROM tasks WHERE ${where} LIMIT ${TASKS_PRUNE_BATCH})`
		);
		let deleted = 0;
		for (;;) {
			const n = this.tx(() => Number(stmt.run(...params).changes));
			deleted += n;
			if (n < TASKS_PRUNE_BATCH) return deleted;
		}
	}

	recordQuota(quota: Quota, now: number): void {
		this.setMeta(QUOTA_META.quota, JSON.stringify(quota), now);
	}

	/** Last received quota. null if missing or broken */
	getQuota(): QuotaRecord | null {
		const row = this.db
			.prepare('SELECT value, updated_at FROM meta WHERE key = ?')
			.get(QUOTA_META.quota) as { value: string; updated_at: number } | undefined;
		if (!row) return null;
		try {
			const quota = JSON.parse(row.value) as Quota;
			if (typeof quota?.used !== 'number' || typeof quota.limit !== 'number') return null;
			return { quota, at: Number(row.updated_at) };
		} catch {
			return null;
		}
	}

	getMeta(key: string): string | null {
		const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
			| { value: string }
			| undefined;
		return row?.value ?? null;
	}

	setMeta(key: string, value: string, now: number): void {
		this.db
			.prepare(
				`INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
			)
			.run(key, value, now);
	}

	/** Several keys in one transaction */
	setMetas(entries: Record<string, string>, now: number): void {
		this.tx(() => {
			for (const [key, value] of Object.entries(entries)) this.setMeta(key, value, now);
		});
	}

	deleteMeta(key: string): void {
		this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
	}

	/** live connection state — null if missing or malformed */
	getLiveState(): LiveState | null {
		const raw = this.getMeta(LIVE_META.state);
		if (raw === null) return null;
		try {
			const v = JSON.parse(raw) as LiveState;
			return typeof v === 'object' && v !== null && typeof v.connected === 'boolean' ? v : null;
		} catch {
			return null;
		}
	}

	setLiveState(state: LiveState, now: number): void {
		this.setMeta(LIVE_META.state, JSON.stringify(state), now);
	}

	recordStop(reason: StopReason, now: number, quotaResetAt?: string): void {
		this.tx(() => {
			this.setMeta(META.stopReason, reason, now);
			this.setMeta(META.stoppedAt, String(now), now);
			if (quotaResetAt) this.setMeta(META.quotaResetAt, quotaResetAt, now);
			else this.deleteMeta(META.quotaResetAt);
		});
	}

	getStop(): StopRecord | null {
		const reason = this.getMeta(META.stopReason);
		if (reason === null) return null;
		return {
			reason: reason as StopReason,
			stoppedAt: Number(this.getMeta(META.stoppedAt) ?? 0),
			quotaResetAt: this.getMeta(META.quotaResetAt)
		};
	}

	clearStop(): void {
		this.tx(() => {
			for (const key of Object.values(META)) this.deleteMeta(key);
		});
	}

	recordEnd(reason: EndReason, now: number, deletedWorkers: string[]): void {
		this.tx(() => {
			this.setMeta(END_META.reason, reason, now);
			this.setMeta(END_META.endedAt, String(now), now);
			this.setMeta(END_META.workers, JSON.stringify(deletedWorkers), now);
		});
	}

	getEnd(): EndRecord | null {
		const reason = this.getMeta(END_META.reason);
		if (reason === null) return null;
		let deletedWorkers: string[] = [];
		try {
			const parsed: unknown = JSON.parse(this.getMeta(END_META.workers) ?? '[]');
			if (Array.isArray(parsed)) deletedWorkers = parsed.filter((n) => typeof n === 'string');
		} catch {
			// A broken value only loses the name
		}
		return {
			reason: reason as EndReason,
			endedAt: Number(this.getMeta(END_META.endedAt) ?? 0),
			deletedWorkers
		};
	}

	clearEnd(): void {
		this.tx(() => {
			for (const key of Object.values(END_META)) this.deleteMeta(key);
		});
	}

	/** node:sqlite has no transaction helper. IMMEDIATE takes the lock up front */
	private tx<T>(fn: () => T): T {
		return transaction(this.db, fn);
	}
}

/** Approximate row size — sum of value lengths + 8 bytes per integer (5 INTEGER columns and rowid) */
const ROW_BYTES =
	'length(task_id) + length(worker) + length(state) + coalesce(length(lease_id), 0) + coalesce(length(last_error), 0) + 48';

/**
 * Latest deletable time — tasks finished less than 1 day ago are kept. A finished task_id is the record that it must not run again
 * (docs/design/15_cli.md §7-2), and redelivery only comes within minutes before ack, so 1 day covers that window
 */
function pruneCutoff(before: number, now: number): number {
	return Math.min(before, now - TASKS_PRUNE_MIN_AGE_MS);
}

/** Finished states only — received and running are excluded in SQL */
function pruneWhere(
	worker: string | undefined,
	cutoff: number
): { where: string; params: (string | number)[] } {
	const conds = [
		`state IN (${TERMINAL_STATES.map(() => '?').join(',')})`,
		'finished_at IS NOT NULL',
		'finished_at < ?'
	];
	const params: (string | number)[] = [...TERMINAL_STATES, cutoff];
	if (worker !== undefined) {
		conds.push('worker = ?');
		params.push(worker);
	}
	return { where: conds.join(' AND '), params };
}

function transaction<T>(db: DatabaseSync, fn: () => T): T {
	db.exec('BEGIN IMMEDIATE');
	try {
		const result = fn();
		db.exec('COMMIT');
		return result;
	} catch (err) {
		if (db.isTransaction) db.exec('ROLLBACK');
		throw err;
	}
}

function userVersion(db: DatabaseSync): number {
	const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
	return Number(row.user_version);
}

function migrate(db: DatabaseSync, file: string): void {
	// Fast path — most runs end here
	if (userVersion(db) === SCHEMA_VERSION) return;
	// Re-read the version **after** taking the lock. If two processes open it for the first time together, both read 0,
	// and the later one reruns the same CREATE and fails with "table already exists"
	transaction(db, () => {
		const current = userVersion(db);
		if (current > SCHEMA_VERSION) throw new NewerSchemaError(file, current, SCHEMA_VERSION);
		for (let v = current; v < SCHEMA_VERSION; v++) db.exec(MIGRATIONS[v]);
		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	});
}

/**
 * Columns outside the schema version — used to finish runs after a restart (`acked_at`: whether ack arrived, `callback_url`: reply address).
 * The version is not bumped, so older CLIs still open this DB — their INSERTs name columns explicitly, so new columns are left
 * NULL. Unlike indexes, these are needed for writes, so failures are not swallowed. Rechecked inside the lock so two processes
 * opening it for the first time do not add the same column twice
 */
const EXTRA_COLUMNS: readonly [name: string, type: string][] = [
	['acked_at', 'INTEGER'],
	['callback_url', 'TEXT'],
	// Repeating tasks (docs/design/15_cli.md §8-7) — settings, input, progress. All nullable with no CHECK (coexists with old rows and old CLIs' INSERTs)
	['repeat', 'TEXT'],
	['input_json', 'TEXT'],
	['run_no', 'INTEGER'],
	['next_at', 'INTEGER'],
	['fail_streak', 'INTEGER'],
	['runs', 'INTEGER'],
	['failed', 'INTEGER'],
	['last_run_at', 'INTEGER']
];

/** repeat and input_json values for receive() — both NULL for one-shot tasks */
function repeatColumns(task: ReceivedTask): [string | null, string | null] {
	if (!task.repeat) return [null, null];
	return [JSON.stringify(task.repeat), JSON.stringify(task.input ?? null)];
}

function ensureColumns(db: DatabaseSync): void {
	const missing = () => {
		const have = new Set(
			(db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name)
		);
		return EXTRA_COLUMNS.filter(([name]) => !have.has(name));
	};
	if (missing().length === 0) return;
	transaction(db, () => {
		for (const [name, type] of missing()) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
	});
}

/**
 * Auxiliary indexes outside the schema version — for read performance only; behavior is the same without them. The version is not bumped, so older CLIs
 * still open this DB (SQLite updates the indexes too). No-op if present; the first time builds from existing rows (about 0.5s with 3M rows).
 * Failures (locks etc.) are swallowed — the next open retries. The dashboard is read-only and does not build them
 *
 *   tasks_received  received time — dashboard Runs list and paging. Without it one list page scans everything (about 150ms with 3M rows)
 */
function ensureIndexes(db: DatabaseSync): void {
	try {
		db.exec('CREATE INDEX IF NOT EXISTS tasks_received ON tasks (received_at)');
	} catch {
		// The next open retries
	}
}

function openFailure(file: string, err: unknown): string {
	const e = err as NodeJS.ErrnoException & { errcode?: number };
	const reason = e?.message ?? String(err);
	if (e?.code === 'EACCES' || e?.code === 'EPERM') {
		return `cannot open ${file}: permission denied. Check the owner and permissions of that folder.`;
	}
	// SQLITE_NOTADB(26) · SQLITE_CORRUPT(11) — a state file that is safe to delete (only stop reasons and duplicate-guard records are lost)
	if (e?.errcode === 26 || e?.errcode === 11) {
		return `${file} is corrupted (${reason}). Move it aside and run the command again — it only holds local state.`;
	}
	return `cannot open ${file}: ${reason}`;
}
