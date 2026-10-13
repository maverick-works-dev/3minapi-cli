/**
 * Built-in reader worker execution — describe, query, read (docs/design/15_cli.md §8-6). The remote path
 * (`runReader`) runs **only in the child process** (results-child.ts), so `JSON.parse` of large payloads and
 * synchronous queries never block the poller's event loop, and timeout/cancel is a single process kill. Exception:
 * `readPayloadSlice` is called in-process by the local dashboard (no poller to block).
 *
 * Remote-path rules, unlike CLI `worker results` (local, unrestricted):
 * - **Replied results only** — `source IN ('pull','public')`. Local `--serve` results are never replied anywhere
 *   (docs/design/15_cli.md §8-4)
 * - **Results run by this host only** — `host_id = current host`, so after re-login with another host's token the
 *   previous host's results (possibly another account's) are not exposed. Rows of unknown owner (NULL) never match
 *   (#1403)
 * - **query reads only the scoped view `results`** — the authorizer denies user, source and schema tables. The
 *   scoped view sits on internal views with random names, because source-table reads are allowed by innermost-view
 *   name and user SQL must not be able to impersonate that name (observed on Node 24.12)
 * - Every response fits the reply budget (DESCRIBE_MAX_BYTES) — otherwise it would itself become a substitute
 */
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DESCRIBE_MAX_GROUPS, READ_MAX_BYTES, RESULTS_TABLE } from '../../../core/domain/index.ts';
import { DESCRIBE_MAX_BYTES, describeTask, describeWorker, jsonBytes } from './query.ts';

export { replacer } from './query.ts';
import type { ReaderOutcome, ReaderRequest, Scope } from './reader-input.ts';
import { MISSING_PATHS_MAX, missingPaths, missingPathsWarning } from './missing-paths.ts';
import { childPath, type Shape } from './shape.ts';
import { ResultStore, type ResultSource } from './store.ts';

/** Results visible remotely — those replied (or meant to be replied) */
export const REMOTE_SOURCES: readonly ResultSource[] = ['pull', 'public'];

/** sqlite constants — passed in from the child's dynamic import */
export interface SqliteConstants {
	SQLITE_OK: number;
	SQLITE_DENY: number;
	SQLITE_SELECT: number;
	SQLITE_READ: number;
	SQLITE_FUNCTION: number;
	SQLITE_RECURSIVE: number;
}

class Failure extends Error {
	readonly reason: Extract<ReaderOutcome, { ok: false }>['reason'];
	constructor(reason: Extract<ReaderOutcome, { ok: false }>['reason'], message: string) {
		super(message);
		this.reason = reason;
	}
}

/** root = project folder, db = data.db opened readOnly, hostId = current host (only its results are read) */
export function runReader(
	root: string,
	db: DatabaseSync,
	c: SqliteConstants,
	req: ReaderRequest,
	hostId: string
): ReaderOutcome {
	try {
		switch (req.op) {
			case 'describe':
				return {
					ok: true,
					result:
						'task_id' in req
							? describeOne(db, req.task_id, hostId, req.run_no)
							: describeMany(root, req, hostId)
				};
			case 'query':
				return { ok: true, result: query(db, c, req, hostId) };
			case 'read':
				return { ok: true, result: read(db, req, hostId) };
		}
	} catch (err) {
		if (err instanceof Failure) return { ok: false, reason: err.reason, message: err.message };
		throw err;
	}
}

// ── describe ────────────────────────────────────────────────

interface Row {
	task_id: string;
	worker: string;
	created_at: string;
	status: 'completed' | 'failed';
	bytes: number;
	shape_hash: string | null;
	shape: string | null;
	run_no: number;
}

/**
 * One result row — a repeating task has several run rows. Without runNo, the latest run (two reads in one request
 * see the same row)
 */
function findRow(
	db: DatabaseSync,
	taskId: string,
	hostId: string,
	withPayload = false,
	runNo?: number
): Row & { payload?: string } {
	const row = db
		.prepare(
			`SELECT task_id, worker, created_at, status, bytes, shape_hash, shape, run_no${withPayload ? ', payload' : ''}
			 FROM ${RESULTS_TABLE} WHERE task_id = ? AND host_id = ? AND source IN (${REMOTE_SOURCES.map(() => '?').join(', ')})
			 ${runNo === undefined ? 'ORDER BY run_no DESC LIMIT 1' : 'AND run_no = ?'}`
		)
		.get(taskId, hostId, ...REMOTE_SOURCES, ...(runNo === undefined ? [] : [runNo])) as
		| (Row & { payload?: string })
		| undefined;
	if (!row) {
		const runs = runNo === undefined ? null : runInfo(db, taskId, hostId);
		throw new Failure(
			'result_not_found',
			runs
				? `no saved run ${runNo} for task ${taskId} — ${runs.count} run(s) are saved, the latest is run ${runs.last_run_no}`
				: `no saved result for task ${taskId} on this host — it ran on another host, was pruned, or its worker has not finished`
		);
	}
	return row;
}

/** Saved runs of this task within the remote scope; null if none */
function runInfo(
	db: DatabaseSync,
	taskId: string,
	hostId: string
): { count: number; last_run_no: number } | null {
	const r = db
		.prepare(
			`SELECT count(*) AS n, max(run_no) AS last FROM ${RESULTS_TABLE}
			 WHERE task_id = ? AND host_id = ? AND source IN (${REMOTE_SOURCES.map(() => '?').join(', ')})`
		)
		.get(taskId, hostId, ...REMOTE_SOURCES) as { n: number; last: number | null };
	return Number(r.n) > 0 ? { count: Number(r.n), last_run_no: Number(r.last) } : null;
}

/**
 * Run info for repeating tasks — the row's `run_no` and saved runs (`runs`), so the AI learns other runs exist
 * without a query. Omitted for one-shot tasks (run 1 only), leaving the response unchanged
 */
function runFields(
	db: DatabaseSync,
	row: Row,
	hostId: string
): { run_no?: number; runs?: { count: number; last_run_no: number } } {
	const runs = runInfo(db, row.task_id, hostId);
	if (!runs || (runs.last_run_no <= 1 && row.run_no <= 1)) return {};
	return { run_no: row.run_no, runs };
}

function describeOne(db: DatabaseSync, taskId: string, hostId: string, runNo?: number): unknown {
	const row = findRow(db, taskId, hostId, false, runNo);
	const run = runFields(db, row, hostId);
	if (row.status === 'failed' || row.shape === null) {
		// failed has no shape — show the saved error as is (within budget). A completed payload is not read (may be large)
		const error = JSON.parse(findRow(db, taskId, hostId, true, row.run_no).payload!) as unknown;
		const out = {
			task_id: row.task_id,
			...run,
			worker: row.worker,
			created_at: row.created_at,
			status: row.status,
			error
		};
		return jsonBytes(out) <= DESCRIBE_MAX_BYTES
			? out
			: {
					...out,
					error: { message: 'the saved error is too large to show; read it with task_result_read' }
				};
	}
	return {
		...run,
		status: row.status,
		bytes: row.bytes,
		...describeTask({
			task_id: row.task_id,
			host_id: hostId,
			worker: row.worker,
			created_at: row.created_at,
			shape_hash: row.shape_hash,
			shape: JSON.parse(row.shape) as Shape,
			source: 'pull',
			status: row.status,
			reply: 'result',
			bytes: row.bytes,
			payload: ''
		})
	};
}

function describeMany(
	root: string,
	req: { worker: string; since?: string },
	hostId: string
): unknown {
	const store = ResultStore.openReadOnly(root);
	if (!store) throw new Failure('result_not_found', 'no results are saved on this host');
	try {
		const out = describeWorker(store, {
			worker: req.worker,
			...(req.since !== undefined ? { since: req.since } : {}),
			sources: REMOTE_SOURCES,
			hostId
		});
		if (out.total === 0) {
			throw new Failure(
				'result_not_found',
				`no completed results of worker "${req.worker}"${req.since ? ` since ${req.since}` : ''} are saved on this host`
			);
		}
		return out;
	} finally {
		store.close();
	}
}

// ── query ───────────────────────────────────────────────────

/** Columns of view `results` — payload is the result JSON when completed, the error JSON when failed */
export const RESULTS_VIEW_COLUMNS = [
	'task_id',
	'run_no',
	'worker',
	'created_at',
	'status',
	'bytes',
	'shape_hash',
	'payload'
];

function query(
	db: DatabaseSync,
	c: SqliteConstants,
	req: Extract<ReaderRequest, { op: 'query' }>,
	hostId: string
): unknown {
	const inner = `_scope_${randomBytes(8).toString('hex')}`;
	db.exec(
		`CREATE TEMP VIEW ${inner} AS SELECT ${RESULTS_VIEW_COLUMNS.join(', ')} FROM main.${RESULTS_TABLE} WHERE ${scopeSql(req.scope, hostId)};
		 CREATE TEMP VIEW results AS SELECT * FROM ${inner};`
	);

	// Shapes in scope — checked before running (not run if expect_shape differs)
	const groups = db
		.prepare(
			`SELECT status, shape_hash, count(*) AS n FROM ${inner} GROUP BY status, shape_hash ORDER BY n DESC`
		)
		.all() as { status: string; shape_hash: string | null; n: number }[];
	if (groups.length === 0) {
		throw new Failure(
			'result_not_found',
			'no saved results match this scope on this host (worker, task_id(s) and since are combined with AND)'
		);
	}
	const shapes = groups
		.filter((g) => g.status === 'completed' && g.shape_hash !== null)
		.map((g) => ({ shape_hash: g.shape_hash!, tasks: g.n }));
	const failed = groups.filter((g) => g.status === 'failed').reduce((n, g) => n + g.n, 0);
	// The shape list in the response is capped at DESCRIBE_MAX_GROUPS by count, so workers with hundreds of shapes
	// (optional fields varying per result) cannot exceed the reply budget with the list alone. Checks (warning,
	// expect_shape) use the full list
	const shown = shapes.slice(0, DESCRIBE_MAX_GROUPS);
	const rest = shapes.slice(DESCRIBE_MAX_GROUPS);
	const shapesMore =
		rest.length > 0 ? { groups: rest.length, tasks: rest.reduce((n, s) => n + s.tasks, 0) } : null;
	if (req.expect_shape !== undefined) {
		const other = shapes.filter((s) => s.shape_hash !== req.expect_shape);
		if (other.length > 0 || shapes.length === 0) {
			const listed =
				shown.map((s) => `${s.shape_hash}: ${s.tasks}`).join(', ') +
				(shapesMore ? `, and ${shapesMore.groups} more` : '');
			throw new Failure(
				'shape_mismatch',
				`the scope has results of other shapes (${listed || 'none completed'}) ` +
					`than expect_shape ${req.expect_shape} — the query did not run. Narrow the scope (task_ids or since), or describe the worker to see when the shape changed`
			);
		}
	}

	// Paths the query references that no result in scope has. Omitted when undecidable (completed result without shape, truncated shape)
	const missing = scopeMissingPaths(db, req, hostId);

	db.setAuthorizer((action, p1, _p2, dbName, view) => {
		if (
			action === c.SQLITE_SELECT ||
			action === c.SQLITE_FUNCTION ||
			action === c.SQLITE_RECURSIVE
		) {
			return c.SQLITE_OK;
		}
		if (action === c.SQLITE_READ) {
			if (dbName === 'main' && p1 === RESULTS_TABLE && view === inner) return c.SQLITE_OK;
			if (dbName === 'temp' && (p1 === 'results' || p1 === inner)) return c.SQLITE_OK;
			// Column reads of the json_each / json_tree table functions
			if (p1 === 'json_each' || p1 === 'json_tree') return c.SQLITE_OK;
			// Self-reference of a recursive CTE — no DB name (real tables carry main/temp; observed on Node 24.12)
			if (dbName === null) return c.SQLITE_OK;
		}
		return c.SQLITE_DENY;
	});

	let stmt;
	try {
		stmt = db.prepare(req.sql);
	} catch (err) {
		throw sqlFailure(err);
	}
	const columns = stmt.columns().map((col) => col.name);
	stmt.setReturnArrays(true);
	const tasks = groups.reduce((n, g) => n + g.n, 0);
	const warnings = [
		...(shapes.length > 1
			? [
					`the scope mixes ${shapes.length} result shapes — a path that exists in one shape is NULL in another, ` +
						'so sums and counts can be silently wrong. Check with describe, then pass expect_shape or narrow the scope'
				]
			: []),
		...(missing.length > 0 ? [missingPathsWarning(missing)] : [])
	];
	const build = (rows: unknown[][], truncated: boolean) => ({
		columns,
		rows,
		row_count: rows.length,
		...(truncated
			? {
					truncated: true,
					note: `stopped at ${rows.length} rows to stay within the reply limit — aggregate in SQL (count, sum, GROUP BY) or add LIMIT/OFFSET`
				}
			: {}),
		scope: { tasks, ...(failed > 0 ? { failed } : {}) },
		shapes: shown,
		...(shapesMore ? { shapes_more: shapesMore } : {}),
		...(missing.length > 0 ? { missing_paths: missing.slice(0, MISSING_PATHS_MAX) } : {}),
		...(warnings.length > 0 ? { warning: warnings.join('. ') } : {})
	});
	// Row budget = reply budget − actual envelope (column names, shape list, notes; the row count measured at its longest)
	const budget = DESCRIBE_MAX_BYTES - jsonBytes(build([], true)) - 16;
	const rows: unknown[][] = [];
	let used = 0;
	let truncated = false;
	try {
		for (const row of stmt.iterate() as Iterable<unknown[]>) {
			const size = jsonBytes(row) + 1;
			if (used + size > budget) {
				truncated = true;
				break;
			}
			used += size;
			rows.push(row);
		}
	} catch (err) {
		throw sqlFailure(err);
	}

	return build(rows, truncated);
}

/**
 * Checks the SQL against shape paths of completed results in scope. Skipped if any result lacks a shape or is
 * `truncated` — real paths may be missing from it. Reads one shape per hash. (#1446)
 */
function scopeMissingPaths(
	db: DatabaseSync,
	req: Extract<ReaderRequest, { op: 'query' }>,
	hostId: string
): string[] {
	const rows = db
		.prepare(
			`SELECT shape FROM main.${RESULTS_TABLE} WHERE ${scopeSql(req.scope, hostId)} AND status = 'completed' GROUP BY shape_hash`
		)
		.all() as { shape: string | null }[];
	const known = new Set<string>();
	for (const row of rows) {
		if (row.shape === null) return [];
		let shape: Shape;
		try {
			shape = JSON.parse(row.shape) as Shape;
		} catch {
			// A corrupt shape must not block the query — skip only the check (it is supplementary)
			return [];
		}
		if (shape.truncated) return [];
		for (const path of Object.keys(shape.paths)) known.add(path);
	}
	if (known.size === 0) return [];
	return missingPaths(req.sql, known);
}

/** Scope → WHERE. reader-input.ts already validated the value formats; here quotes are only doubled */
function scopeSql(scope: Scope, hostId: string): string {
	const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
	const conds = [`source IN (${REMOTE_SOURCES.map(lit).join(', ')})`, `host_id = ${lit(hostId)}`];
	if (scope.worker !== undefined) conds.push(`worker = ${lit(scope.worker)}`);
	if (scope.task_ids !== undefined)
		conds.push(`task_id IN (${scope.task_ids.map(lit).join(', ')})`);
	if (scope.since !== undefined) conds.push(`created_at >= ${lit(scope.since)}`);
	return conds.join(' AND ');
}

function sqlFailure(err: unknown): Failure {
	const e = err as { errcode?: number; message?: string };
	const message = e.message ?? String(err);
	if (e.errcode === 23) {
		return new Failure(
			'query_denied',
			`${message} — queries may only read the view "results" (columns: ${RESULTS_VIEW_COLUMNS.join(', ')}) and use functions such as json_extract and json_each`
		);
	}
	return new Failure('query_error', message);
}

// ── read ────────────────────────────────────────────────────

function read(
	db: DatabaseSync,
	req: Extract<ReaderRequest, { op: 'read' }>,
	hostId: string
): unknown {
	const row = findRow(db, req.task_id, hostId, true, req.run_no);
	return readNode(
		JSON.parse(row.payload!),
		{ task_id: req.task_id, ...runFields(db, row, hostId), status: row.status, path: req.path },
		req
	);
}

/**
 * One slice of a saved payload — the local dashboard reads with the same slicing rules, without the remote scope
 * limits. Failures are returned as text, not thrown. Called in the dashboard's own process (no poller to block; the
 * child-process rule in the header applies to the remote path)
 */
export function readPayloadSlice(
	payload: string,
	at: {
		path: string;
		offset: number;
		limit?: number | null;
		/** Shrinks each element before budgeting — the UI shows only the size of large nested values, so the list renders even if one exceeds the budget */
		summarize?: (value: unknown) => unknown;
	}
): { ok: true; result: Record<string, unknown> } | { ok: false; message: string } {
	try {
		const result = readNode(JSON.parse(payload), { path: at.path }, at) as Record<string, unknown>;
		return { ok: true, result };
	} catch (err) {
		if (err instanceof Failure || err instanceof SyntaxError) {
			return { ok: false, message: err.message };
		}
		throw err;
	}
}

function readNode(
	root: unknown,
	base: Record<string, unknown>,
	req: {
		path: string;
		offset: number;
		limit?: number | null;
		summarize?: (value: unknown) => unknown;
	}
): unknown {
	const view = req.summarize ?? ((v: unknown) => v);
	let node: unknown = root;
	for (const step of parsePath(req.path)) {
		if (typeof step === 'number') {
			if (!Array.isArray(node) || step >= node.length) throw missing(req.path);
			node = node[step];
		} else {
			if (
				node === null ||
				typeof node !== 'object' ||
				Array.isArray(node) ||
				!Object.hasOwn(node, step)
			) {
				throw missing(req.path);
			}
			node = (node as Record<string, unknown>)[step];
		}
	}
	const limit = req.limit ?? Number.MAX_SAFE_INTEGER;

	if (Array.isArray(node)) {
		return slice(
			base,
			'array',
			node.length,
			req.offset,
			limit,
			(i) => view(node[i]),
			(items) => ({ items }),
			req.path
		);
	}
	if (node !== null && typeof node === 'object') {
		const keys = Object.keys(node);
		const obj = node as Record<string, unknown>;
		return slice(
			base,
			'object',
			keys.length,
			req.offset,
			limit,
			(i) => [keys[i], view(obj[keys[i]])] as const,
			(entries) => ({
				items: Object.fromEntries(entries as (readonly [string, unknown])[])
			}),
			req.path
		);
	}
	if (typeof node === 'string') return readText(base, node, req.offset, limit);
	if (req.offset > 0)
		throw new Failure('read_out_of_range', `${req.path} is a single value — read it with offset 0`);
	return { ...base, kind: 'value', total: 1, offset: 0, count: 1, next: null, value: node };
}

/** Fill the budget element by element (or key) — cutting by bytes would break the JSON */
function slice(
	base: Record<string, unknown>,
	kind: 'array' | 'object',
	total: number,
	offset: number,
	limit: number,
	at: (i: number) => unknown,
	wrap: (items: unknown[]) => Record<string, unknown>,
	path: string
): unknown {
	if (offset > total || (offset === total && total > 0)) {
		throw new Failure(
			'read_out_of_range',
			`offset ${offset} is past the end of ${path} (${total} ${kind === 'array' ? 'elements' : 'keys'})`
		);
	}
	const items: unknown[] = [];
	let used = 0;
	for (let i = offset; i < total && items.length < limit; i++) {
		const v = at(i);
		const size = jsonBytes(v) + 1;
		if (used + size > READ_MAX_BYTES) {
			if (items.length === 0) {
				const sub = kind === 'array' ? `${path}[${i}]` : childPath(path, (v as [string])[0]);
				throw new Failure(
					'read_out_of_range',
					`${sub} alone is ${size} bytes, more than one read (${READ_MAX_BYTES} bytes) — read a path inside it (for example ${sub}.<field>) or query it with SQL`
				);
			}
			break;
		}
		used += size;
		items.push(v);
	}
	const end = offset + items.length;
	return {
		...base,
		kind,
		total,
		offset,
		count: items.length,
		next: end < total ? end : null,
		...wrap(items)
	};
}

/** Characters = code points (surrogate pairs are never split) */
function readText(
	base: Record<string, unknown>,
	text: string,
	offset: number,
	limit: number
): unknown {
	const chars = Array.from(text);
	const total = chars.length;
	if (offset > total || (offset === total && total > 0)) {
		throw new Failure(
			'read_out_of_range',
			`offset ${offset} is past the end of the text (${total} characters)`
		);
	}
	let used = 2;
	let end = offset;
	while (end < total && end - offset < limit) {
		const size = jsonBytes(chars[end]) - 2;
		if (used + size > READ_MAX_BYTES) break;
		used += size;
		end++;
	}
	return {
		...base,
		kind: 'text',
		total,
		offset,
		count: end - offset,
		next: end < total ? end : null,
		text: chars.slice(offset, end).join('')
	};
}

function missing(path: string): Failure {
	return new Failure(
		'read_out_of_range',
		`${path} does not exist in this result — check the paths with task_result_describe`
	);
}

/**
 * A subset of shape path notation — `$`, `.key`, `."any key"` (JSON string), `[n]`. `[*]` is not accepted (one
 * slice is read)
 */
export function parsePath(path: string): (string | number)[] {
	const steps: (string | number)[] = [];
	let i = 1;
	const bad = () =>
		new Failure(
			'read_out_of_range',
			`cannot parse path ${path} — use $.key, $."a key" or $.list[3]`
		);
	if (path[0] !== '$') throw bad();
	while (i < path.length) {
		if (path[i] === '.') {
			i++;
			if (path[i] === '"') {
				let j = i + 1;
				while (j < path.length && path[j] !== '"') j += path[j] === '\\' ? 2 : 1;
				if (j >= path.length) throw bad();
				try {
					steps.push(JSON.parse(path.slice(i, j + 1)) as string);
				} catch {
					throw bad();
				}
				i = j + 1;
			} else {
				const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(path.slice(i));
				if (!m) throw bad();
				steps.push(m[0]);
				i += m[0].length;
			}
		} else if (path[i] === '[') {
			const m = /^\[(\d+)\]/.exec(path.slice(i));
			if (!m) throw bad();
			steps.push(Number(m[1]));
			i += m[0].length;
		} else {
			throw bad();
		}
	}
	return steps;
}
