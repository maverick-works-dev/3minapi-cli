/**
 * Worker result store — `_3minapi_results` in the project's `data.db` (docs/design/15_cli.md §7-7, §8-5).
 *
 * - The file belongs to the user: `PRAGMA user_version` is theirs, so the schema version lives in `_3minapi_meta`.
 *   Mode 0600 is applied **only on creation**
 * - WAL is checked on open and enabled if needed; if a user process holds a lock, only a warning (still usable)
 * - Busy timeout only via the constructor `timeout` (5s) — same as the control DB (control-db.ts)
 * - `payload` is the last column — large values go to overflow pages and reading any later column walks the chain.
 *   Listings and usage never read payload
 * - Redelivery (same task_id) uses `ON CONFLICT DO UPDATE` — `INSERT OR REPLACE` deletes and reinserts, breaking user
 *   triggers and rowids
 * - No VACUUM — it changes rowids of user tables without INTEGER PRIMARY KEY (sqlite.org/lang_vacuum.html)
 * - Repeating tasks store one row per run — key `(task_id, run_no)`, one-shot tasks use `run_no = 1`. Single-row
 *   reads (`get`, `find`) return the **latest run**. The results schema stays version 1; a table created without
 *   `run_no` is rebuilt when opened for writing (migrate — SQLite's table rebuild procedure) (#1434)
 * - `host_id` — which host ran the result. The built-in reader only reads the current host's rows, so after re-login
 *   with another host's token the previous host's results are not exposed to the new host's remote AI. Runs whose
 *   host lookup failed keep NULL and stay invisible remotely (never backfilled — ownership is uncertain). Placed
 *   before `payload` (above) (#1403)
 *
 * Writes happen only in the parent thread (worker threads never import sqlite — runtime/thread.ts).
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
	BIN,
	CliError,
	ConfigError,
	DB_BUSY_TIMEOUT_MS,
	RESULTS_META_TABLE,
	RESULTS_SCHEMA_VERSION,
	RESULTS_TABLE,
	USER_DB_FILE
} from '../../../core/domain/index.ts';
import { touchSecretFile } from '../../../core/secure-fs.ts';
import type { Shape } from './shape.ts';

/** How the task arrived — pull = local worker, public = public worker serving, serve = local `--serve` */
export type ResultSource = 'pull' | 'public' | 'serve';
/** What was replied. pending = not sent yet (or stopped mid-send), rejected = the server refused it (409, stop) */
export type ReplyState = 'pending' | 'result' | 'substitute' | 'failed' | 'rejected' | 'none';

export interface ResultRecord {
	taskId: string;
	worker: string;
	createdAt: number;
	source: ResultSource;
	/** What the worker produced */
	status: 'completed' | 'failed';
	reply: ReplyState;
	/** completed: raw result JSON / failed: error JSON */
	payload: string;
	shape: Shape | null;
	shapeHash: string | null;
	/** Run number of a repeating task; 1 for one-shot tasks */
	runNo?: number;
}

/** One listing row — no payload */
export interface ResultRow {
	task_id: string;
	/** Host that ran it — null when the host lookup failed for that run */
	host_id: string | null;
	worker: string;
	created_at: string;
	source: ResultSource;
	status: 'completed' | 'failed';
	reply: ReplyState;
	bytes: number;
	shape_hash: string | null;
	/** Run number of a repeating task; 1 for one-shot tasks — absent on derived rows (substitute computation etc.) */
	run_no?: number;
}

export interface ResultFilter {
	worker?: string;
	/** ISO UTC — at or after this time */
	since?: string;
	/** ISO UTC — before this time */
	before?: string;
	/** Arrival path — the built-in reader uses it to exclude never-replied local `--serve` results */
	sources?: readonly ResultSource[];
	/** Host that ran it — the built-in reader passes the current host. NULL rows never match (#1403) */
	hostId?: string;
	/** Status the worker produced — local dashboard */
	status?: 'completed' | 'failed';
	/** Next page — rows after this one in list order (created_at DESC, task_id). Local dashboard */
	after?: { createdAt: string; taskId: string };
	/**
	 * Only the latest run row per task_id, so a repeating task is not listed once per run. It appears once across
	 * pages (positioned by its latest run's save time). Other filters (status etc.) apply to the latest run
	 */
	latestRunOnly?: boolean;
}

export interface StoredResult extends ResultRow {
	shape: Shape | null;
	payload: string;
}

/** Result table columns — `payload` last (see header), `run_no` just before it */
const RESULTS_COLUMNS = `	task_id TEXT NOT NULL,
	worker TEXT NOT NULL,
	created_at TEXT NOT NULL,
	source TEXT NOT NULL,
	status TEXT NOT NULL,
	reply TEXT NOT NULL,
	bytes INTEGER NOT NULL,
	shape_hash TEXT,
	shape TEXT,
	host_id TEXT,
	run_no INTEGER NOT NULL DEFAULT 1,
	payload TEXT NOT NULL,
	PRIMARY KEY (task_id, run_no)`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ${RESULTS_TABLE} (
${RESULTS_COLUMNS}
) STRICT;
CREATE INDEX IF NOT EXISTS ${RESULTS_TABLE}_worker ON ${RESULTS_TABLE}(worker, created_at);
CREATE INDEX IF NOT EXISTS ${RESULTS_TABLE}_host ON ${RESULTS_TABLE}(host_id, worker, created_at);
CREATE INDEX IF NOT EXISTS ${RESULTS_TABLE}_created ON ${RESULTS_TABLE}(created_at);
CREATE TABLE IF NOT EXISTS ${RESULTS_META_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
`;

const ROW_COLUMNS =
	'task_id, worker, created_at, source, status, reply, bytes, shape_hash, host_id, run_no';

/** Latest run of one task_id — one-shot tasks have only one */
const LATEST = `SELECT ${ROW_COLUMNS}, shape, payload FROM ${RESULTS_TABLE} WHERE task_id = ? ORDER BY run_no DESC LIMIT 1`;

export function resultsDbPath(root: string): string {
	return path.join(root, USER_DB_FILE);
}

/** Disk usage — main file + `-wal` (status) */
export function resultsDbBytes(root: string): number | null {
	const file = resultsDbPath(root);
	if (!existsSync(file)) return null;
	const wal = `${file}-wal`;
	return statSync(file).size + (existsSync(wal) ? statSync(wal).size : 0);
}

export class ResultStore {
	private readonly db: DatabaseSync;
	/** host_id for newly saved rows — set by start once the host is known (setHost) */
	private hostId: string | null = null;

	private constructor(db: DatabaseSync) {
		this.db = db;
	}

	/**
	 * Opens for writing (creating with 0600 if absent) and ensures the result table. Warnings (WAL switch failure) are
	 * returned. Failures are thrown — the caller decides whether to run without saving
	 */
	static open(root: string): { store: ResultStore; warnings: string[] } {
		const file = resultsDbPath(root);
		if (!existsSync(file)) touchSecretFile(file);
		const db = new DatabaseSync(file, { timeout: DB_BUSY_TIMEOUT_MS });
		try {
			const warnings = ensureWal(db);
			migrate(db);
			return { store: new ResultStore(db), warnings };
		} catch (err) {
			if (db.isOpen) db.close();
			throw err;
		}
	}

	/**
	 * Read-only — null when the file or result table is missing (nothing is created). Like the write open (migrate),
	 * rejects a result schema newer than this code, since old code reading a newer table gives obscure SQL errors or
	 * wrong values. Open failures report the path
	 */
	static openReadOnly(root: string): ResultStore | null {
		const file = resultsDbPath(root);
		if (!existsSync(file)) return null;
		let db: DatabaseSync | undefined;
		try {
			db = new DatabaseSync(file, { readOnly: true, timeout: DB_BUSY_TIMEOUT_MS });
			if (!hasTable(db, RESULTS_TABLE)) {
				db.close();
				return null;
			}
			// A table from before run_no — only the write open rebuilds it (read-only never changes the file). Read
			// queries use run_no, so report what to do instead of an obscure SQL error
			if (!hasColumn(db, RESULTS_TABLE, 'run_no')) {
				throw new ConfigError(
					`the result table in ${file} was made by an older 3minapi — run '${BIN} start' or '${BIN} worker results' once to upgrade it`
				);
			}
			const schema = hasTable(db, RESULTS_META_TABLE)
				? (
						db.prepare(`SELECT value FROM ${RESULTS_META_TABLE} WHERE key = 'schema'`).get() as
							| { value: string }
							| undefined
					)?.value
				: undefined;
			if (schema !== undefined && Number(schema) > RESULTS_SCHEMA_VERSION) {
				throw new ConfigError(
					`the result tables in ${file} were made by a newer 3minapi (schema ${schema}) — update the CLI`
				);
			}
			return new ResultStore(db);
		} catch (err) {
			if (db?.isOpen) db.close();
			if (err instanceof CliError) throw err;
			throw new CliError(`cannot open ${file}: ${(err as Error)?.message ?? String(err)}`);
		}
	}

	/** This run's host — recorded on rows saved from now on. null = unknown */
	setHost(hostId: string | null): void {
		this.hostId = hostId;
	}

	save(rec: ResultRecord): void {
		this.db
			.prepare(
				`INSERT INTO ${RESULTS_TABLE} (task_id, worker, created_at, source, status, reply, bytes, shape_hash, shape, payload, host_id, run_no)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(task_id, run_no) DO UPDATE SET
				   worker = excluded.worker, created_at = excluded.created_at, source = excluded.source,
				   status = excluded.status, reply = excluded.reply, bytes = excluded.bytes,
				   shape_hash = excluded.shape_hash, shape = excluded.shape, payload = excluded.payload,
				   host_id = excluded.host_id`
			)
			.run(
				rec.taskId,
				rec.worker,
				new Date(rec.createdAt).toISOString(),
				rec.source,
				rec.status,
				rec.reply,
				Buffer.byteLength(rec.payload),
				rec.shapeHash,
				rec.shape === null ? null : JSON.stringify(rec.shape),
				rec.payload,
				this.hostId,
				rec.runNo ?? 1
			);
	}

	/** Mark as replied — only one-shot rows (run_no 1) are replied; repeat run rows are not ('none') */
	setReply(taskId: string, reply: ReplyState, runNo = 1): void {
		this.db
			.prepare(`UPDATE ${RESULTS_TABLE} SET reply = ? WHERE task_id = ? AND run_no = ?`)
			.run(reply, taskId, runNo);
	}

	/** Newest first */
	list(filter: ResultFilter, limit: number): ResultRow[] {
		const { where, params } = whereClause(filter);
		return this.db
			.prepare(
				`SELECT ${ROW_COLUMNS} FROM ${RESULTS_TABLE} ${where} ORDER BY created_at DESC, task_id LIMIT ?`
			)
			.all(...params, limit) as unknown as ResultRow[];
	}

	/** Several task_ids — for joining with control DB rows (local dashboard). No payload. Latest run per task_id */
	rowsByIds(ids: readonly string[]): ResultRow[] {
		if (ids.length === 0) return [];
		return this.db
			.prepare(
				`SELECT ${ROW_COLUMNS} FROM ${RESULTS_TABLE} r WHERE task_id IN (${ids.map(() => '?').join(', ')})
				   AND run_no = (SELECT max(run_no) FROM ${RESULTS_TABLE} WHERE task_id = r.task_id)`
			)
			.all(...ids) as unknown as ResultRow[];
	}

	/** Exactly that task_id — no prefix match. Latest run when runNo is omitted */
	get(taskId: string, runNo?: number): StoredResult | null {
		const row = (
			runNo === undefined
				? this.db.prepare(LATEST).get(taskId)
				: this.db
						.prepare(
							`SELECT ${ROW_COLUMNS}, shape, payload FROM ${RESULTS_TABLE} WHERE task_id = ? AND run_no = ?`
						)
						.get(taskId, runNo)
		) as RawStored | undefined;
		return row ? stored(row) : null;
	}

	/**
	 * Runs of one task — newest first, `limit` rows after `before` (run_no) (PK keyset). No payload. One-shot tasks
	 * have one row (run_no 1)
	 */
	runs(taskId: string, limit: number, before?: number): ResultRow[] {
		return this.db
			.prepare(
				`SELECT ${ROW_COLUMNS} FROM ${RESULTS_TABLE} WHERE task_id = ?${before === undefined ? '' : ' AND run_no < ?'}
				 ORDER BY run_no DESC LIMIT ?`
			)
			.all(
				...(before === undefined ? [taskId, limit] : [taskId, before, limit])
			) as unknown as ResultRow[];
	}

	/**
	 * The same page as `runs`, with payloads for preview (dashboard run list). Results larger than `maxBytes` get null
	 * payload, so the overflow chain is never walked
	 */
	runPreviews(
		taskId: string,
		limit: number,
		before: number | undefined,
		maxBytes: number
	): (ResultRow & { payload: string | null })[] {
		return this.db
			.prepare(
				`SELECT ${ROW_COLUMNS}, CASE WHEN bytes <= ? THEN payload END AS payload FROM ${RESULTS_TABLE}
				 WHERE task_id = ?${before === undefined ? '' : ' AND run_no < ?'} ORDER BY run_no DESC LIMIT ?`
			)
			.all(
				...(before === undefined ? [maxBytes, taskId, limit] : [maxBytes, taskId, before, limit])
			) as unknown as (ResultRow & { payload: string | null })[];
	}

	/**
	 * The saved run right after runNo, skipping unsaved run numbers; null if none. The one before is
	 * `runs(id, 1, runNo)`
	 */
	nextRunNo(taskId: string, runNo: number): number | null {
		const row = this.db
			.prepare(`SELECT min(run_no) AS n FROM ${RESULTS_TABLE} WHERE task_id = ? AND run_no > ?`)
			.get(taskId, runNo) as { n: number | null } | undefined;
		return row?.n ?? null;
	}

	/** Saved run count and latest run per task_id — for repeat display (status, dashboard). Ids without results are omitted */
	runCounts(ids: readonly string[]): Map<string, { runs: number; lastRunNo: number }> {
		const out = new Map<string, { runs: number; lastRunNo: number }>();
		if (ids.length === 0) return out;
		const rows = this.db
			.prepare(
				`SELECT task_id, count(*) AS runs, max(run_no) AS last FROM ${RESULTS_TABLE}
				 WHERE task_id IN (${ids.map(() => '?').join(', ')}) GROUP BY task_id`
			)
			.all(...ids) as { task_id: string; runs: number; last: number }[];
		for (const r of rows) out.set(r.task_id, { runs: Number(r.runs), lastRunNo: Number(r.last) });
		return out;
	}

	/** By task_id or prefix (latest run) — returns the candidates when more than one matches */
	find(idOrPrefix: string): { found: StoredResult } | { candidates: string[] } {
		const exact = this.db.prepare(LATEST).get(idOrPrefix) as RawStored | undefined;
		if (exact) return { found: stored(exact) };
		// A repeating task has several run rows per task_id — count candidates by task_id
		const ids = this.db
			.prepare(
				`SELECT DISTINCT task_id FROM ${RESULTS_TABLE} WHERE task_id >= ? AND task_id < ? ORDER BY task_id LIMIT 6`
			)
			.all(idOrPrefix, `${idOrPrefix}\uffff`) as { task_id: string }[];
		if (ids.length === 1) {
			const row = this.db.prepare(LATEST).get(ids[0].task_id) as unknown as RawStored;
			return { found: stored(row) };
		}
		return { candidates: ids.map((r) => r.task_id) };
	}

	/**
	 * Runs several SELECTs on one snapshot (WAL read transaction), so concurrent saves or pruning by the executor
	 * cannot skew them. Works on read-only connections too
	 */
	snapshot<T>(read: () => T): T {
		this.db.exec('BEGIN');
		try {
			return read();
		} finally {
			this.db.exec('COMMIT');
		}
	}

	/**
	 * Shape groups — counts and time ranges per group via SQL only; shapes are not read, so tens of thousands of rows
	 * stay cheap. By count descending, ties by first appearance
	 */
	shapeGroups(
		filter: ResultFilter
	): { shape_hash: string; count: number; first: string; last: string }[] {
		const { where, params } = shapeWhere(filter);
		return this.db
			.prepare(
				`SELECT shape_hash, count(*) AS count, min(created_at) AS first, max(created_at) AS last
				 FROM ${RESULTS_TABLE} ${where} GROUP BY shape_hash ORDER BY count DESC, first, shape_hash`
			)
			.all(...params) as unknown as {
			shape_hash: string;
			count: number;
			first: string;
			last: string;
		}[];
	}

	/** Shape of the most recent result in scope — ties broken by task_id (deterministic) */
	latestShapeHash(filter: ResultFilter): string | null {
		const { where, params } = shapeWhere(filter);
		const row = this.db
			.prepare(
				`SELECT shape_hash FROM ${RESULTS_TABLE} ${where} ORDER BY created_at DESC, task_id DESC LIMIT 1`
			)
			.get(...params) as { shape_hash: string } | undefined;
		return row?.shape_hash ?? null;
	}

	/** Recent task_ids with that shape — newest first. A repeating task appears once (at its latest run) */
	recentTaskIds(filter: ResultFilter, shapeHash: string, limit: number): string[] {
		const { where, params } = shapeWhere(filter, shapeHash);
		return (
			this.db
				.prepare(
					`SELECT task_id FROM ${RESULTS_TABLE} ${where}
					 GROUP BY task_id ORDER BY max(created_at) DESC, task_id DESC LIMIT ?`
				)
				.all(...params, limit) as { task_id: string }[]
		).map((r) => r.task_id);
	}

	/** The latest `limit` results with that shape — read one at a time, **oldest first** (never all in memory) */
	recentShapes(
		filter: ResultFilter,
		shapeHash: string,
		limit: number
	): Iterable<{ created_at: string; shape: string }> {
		const { where, params } = shapeWhere(filter, shapeHash);
		return this.db
			.prepare(
				`SELECT created_at, shape FROM (
				   SELECT created_at, task_id, shape FROM ${RESULTS_TABLE} ${where}
				   ORDER BY created_at DESC, task_id DESC LIMIT ?
				 ) ORDER BY created_at, task_id`
			)
			.iterate(...params, limit) as Iterable<{ created_at: string; shape: string }>;
	}

	usage(filter: ResultFilter = {}): { count: number; bytes: number } {
		const { where, params } = whereClause(filter);
		const row = this.db
			.prepare(
				`SELECT count(*) AS count, coalesce(sum(bytes), 0) AS bytes FROM ${RESULTS_TABLE} ${where}`
			)
			.get(...params) as { count: number; bytes: number };
		return { count: row.count, bytes: row.bytes };
	}

	/** Number deleted. The file does not shrink (no VACUUM — see header) */
	prune(filter: ResultFilter): number {
		const { where, params } = whereClause(filter);
		return Number(this.db.prepare(`DELETE FROM ${RESULTS_TABLE} ${where}`).run(...params).changes);
	}

	close(): void {
		if (this.db.isOpen) this.db.close();
	}
}

type RawStored = Omit<StoredResult, 'shape'> & { shape: string | null };

function stored(raw: RawStored): StoredResult {
	return { ...raw, shape: raw.shape === null ? null : (JSON.parse(raw.shape) as Shape) };
}

function whereClause(
	filter: ResultFilter,
	extra: string[] = []
): { where: string; params: string[] } {
	const conds = [...extra];
	const params: string[] = [];
	if (filter.worker !== undefined) {
		conds.push('worker = ?');
		params.push(filter.worker);
	}
	if (filter.since !== undefined) {
		conds.push('created_at >= ?');
		params.push(filter.since);
	}
	if (filter.before !== undefined) {
		conds.push('created_at < ?');
		params.push(filter.before);
	}
	if (filter.hostId !== undefined) {
		conds.push('host_id = ?');
		params.push(filter.hostId);
	}
	if (filter.status !== undefined) {
		conds.push('status = ?');
		params.push(filter.status);
	}
	if (filter.after !== undefined) {
		// `<=` must stay outside for a range scan on the created_at index (same as control-db.ts listTasks)
		conds.push('created_at <= ? AND (created_at < ? OR task_id > ?)');
		params.push(filter.after.createdAt, filter.after.createdAt, filter.after.taskId);
	}
	if (filter.sources !== undefined) {
		conds.push(`source IN (${filter.sources.map(() => '?').join(', ') || 'NULL'})`);
		params.push(...filter.sources);
	}
	if (filter.latestRunOnly) {
		// One PK (task_id, run_no) lookup per row — no second table scan
		conds.push(
			`run_no = (SELECT max(x.run_no) FROM ${RESULTS_TABLE} x WHERE x.task_id = ${RESULTS_TABLE}.task_id)`
		);
	}
	return { where: conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '', params };
}

/** Results with a shape (completed) — only that shape when shapeHash is given */
function shapeWhere(filter: ResultFilter, shapeHash?: string): { where: string; params: string[] } {
	const { where, params } = whereClause(filter, [
		"status = 'completed'",
		shapeHash === undefined ? 'shape_hash IS NOT NULL' : 'shape_hash = ?'
	]);
	// The extra condition comes first — so does the shape_hash = ? value
	return { where, params: shapeHash === undefined ? params : [shapeHash, ...params] };
}

function hasTable(db: DatabaseSync, name: string): boolean {
	return (
		db.prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?`).get(name) !==
		undefined
	);
}

/** Keeps WAL if set. If it cannot switch (a user process holds a lock), only warns — rollback journal still works */
function ensureWal(db: DatabaseSync): string[] {
	const mode = (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
	if (mode === 'wal') return [];
	try {
		const now = (db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode: string })
			.journal_mode;
		return now === 'wal' ? [] : [`data.db stays in ${now} journal mode (could not switch to WAL)`];
	} catch (err) {
		return [`data.db could not switch to WAL: ${(err as Error).message}`];
	}
}

function migrate(db: DatabaseSync): void {
	db.exec('BEGIN IMMEDIATE');
	try {
		if (hasTable(db, RESULTS_TABLE) && !hasColumn(db, RESULTS_TABLE, 'run_no'))
			rebuildWithRunNo(db);
		db.exec(SCHEMA);
		const row = db.prepare(`SELECT value FROM ${RESULTS_META_TABLE} WHERE key = 'schema'`).get() as
			| { value: string }
			| undefined;
		if (row === undefined) {
			db.prepare(`INSERT INTO ${RESULTS_META_TABLE} (key, value) VALUES ('schema', ?)`).run(
				String(RESULTS_SCHEMA_VERSION)
			);
		} else if (Number(row.value) > RESULTS_SCHEMA_VERSION) {
			throw new Error(
				`the result tables in data.db were made by a newer 3minapi (schema ${row.value}) — update the CLI`
			);
		}
		db.exec('COMMIT');
	} catch (err) {
		if (db.isTransaction) db.exec('ROLLBACK');
		throw err;
	}
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
	return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
		(c) => c.name === column
	);
}

/**
 * Rebuilds a pre-`run_no` result table (key `task_id`) with key `(task_id, run_no)`. ALTER TABLE cannot change the
 * key, so this follows SQLite's rebuild procedure (sqlite.org/lang_altertable.html "Making Other Kinds Of Table Schema
 * Changes"): save the SQL of the table's indexes and triggers and of views reading it (user-made included) → copy to a
 * new table → drop → rename → recreate. Runs inside the caller's transaction, so a failure rolls back entirely (the
 * caller continues without saving). There are no foreign keys
 */
function rebuildWithRunNo(db: DatabaseSync): void {
	const tmp = `${RESULTS_TABLE}_rebuild`;
	const objects = db
		.prepare(
			`SELECT type, name, sql FROM sqlite_schema
			 WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
			   AND ((type IN ('index', 'trigger') AND tbl_name = ?) OR (type = 'view' AND instr(sql, ?) > 0))`
		)
		.all(RESULTS_TABLE, RESULTS_TABLE) as { type: string; name: string; sql: string }[];
	// Drop views before the table — a remaining view makes the rename fail while re-parsing it
	for (const v of objects.filter((o) => o.type === 'view'))
		db.exec(`DROP VIEW "${v.name.replaceAll('"', '""')}"`);
	db.exec(`CREATE TABLE ${tmp} (\n${RESULTS_COLUMNS}\n) STRICT`);
	db.exec(
		`INSERT INTO ${tmp} (task_id, worker, created_at, source, status, reply, bytes, shape_hash, shape, host_id, run_no, payload)
		 SELECT task_id, worker, created_at, source, status, reply, bytes, shape_hash, shape, host_id, 1, payload FROM ${RESULTS_TABLE}`
	);
	db.exec(`DROP TABLE ${RESULTS_TABLE}`);
	db.exec(`ALTER TABLE ${tmp} RENAME TO ${RESULTS_TABLE}`);
	for (const type of ['index', 'trigger', 'view']) {
		for (const o of objects.filter((x) => x.type === type)) db.exec(o.sql);
	}
}
