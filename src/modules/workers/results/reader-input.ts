/**
 * Built-in reader worker input — shape validation and normalization (docs/design/15_cli.md §8-6).
 *
 * Validated in the parent (executor); only the normalized request goes to the child process (results-child.ts).
 * **Scope values are format-checked here** because the child inlines them as literals in view definitions, which
 * cannot take bound parameters.
 */
import { BUILTIN_TASK_IDS_MAX, READ_LIMIT_MAX } from '../../../core/domain/index.ts';
import type { FailureReason } from '../runtime/protocol.ts';

/** Scope of query and describe (worker) — at least one field */
export interface Scope {
	worker?: string;
	task_ids?: string[];
	/** ISO UTC */
	since?: string;
}

export type ReaderRequest =
	| { op: 'describe'; task_id: string; run_no?: number }
	| { op: 'describe'; worker: string; since?: string }
	| { op: 'query'; sql: string; scope: Scope; expect_shape?: string }
	| {
			op: 'read';
			task_id: string;
			run_no?: number;
			path: string;
			offset: number;
			limit: number | null;
	  };

export type ReaderOutcome =
	| { ok: true; result: unknown }
	| { ok: false; reason: FailureReason; message: string };

/**
 * Guide appended to invalid_input messages, enough for an AI to retry from it alone. Phrased as the MCP result tools'
 * arguments — the server builds this input from them, and a task created for the reader directly is rejected (#1537)
 */
export const READER_USAGE =
	'Use task_result_describe with task_id (and run_no) or worker (and since); task_result_query with sql and at least ' +
	'one of worker, task_id, task_ids, since (and expect_shape); or task_result_read with task_id (and run_no, path, ' +
	'offset, limit). run_no picks a run of a repeating task; the latest run when left out';

/** task_id — the server issues UUIDv7; only the character set is constrained (it is inlined as a literal) */
const TASK_ID = /^[0-9A-Za-z-]{1,64}$/;
/** shape_hash — first 16 hex chars of sha256 */
const SHAPE_HASH = /^[0-9a-f]{16}$/;
/**
 * Public worker names are free-form (docs/design/14_cli_host.md §8), so only length is checked — literals double
 * their quotes
 */
const WORKER_MAX_CHARS = 50;
const SQL_MAX_CHARS = 20_000;
const PATH_MAX_CHARS = 1_000;

export function parseReaderInput(
	input: unknown
): { ok: true; req: ReaderRequest } | { ok: false; message: string } {
	try {
		return { ok: true, req: parse(input) };
	} catch (err) {
		return { ok: false, message: `${(err as Error).message}. ${READER_USAGE}` };
	}
}

function parse(input: unknown): ReaderRequest {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) {
		throw new Error('input must be a JSON object');
	}
	const o = input as Record<string, unknown>;
	switch (o.op) {
		case 'describe':
			if (o.task_id !== undefined) {
				only(o, ['op', 'task_id', 'run_no']);
				return {
					op: 'describe',
					task_id: taskId(o.task_id, 'task_id'),
					...(o.run_no !== undefined ? { run_no: runNo(o.run_no) } : {})
				};
			}
			if (o.worker !== undefined) {
				only(o, ['op', 'worker', 'since']);
				return {
					op: 'describe',
					worker: worker(o.worker),
					...(o.since !== undefined ? { since: since(o.since) } : {})
				};
			}
			throw new Error('describe needs task_id or worker');
		case 'query': {
			only(o, ['op', 'sql', 'worker', 'task_id', 'task_ids', 'since', 'expect_shape']);
			if (typeof o.sql !== 'string' || o.sql.trim() === '') throw new Error('sql must be a string');
			if (o.sql.length > SQL_MAX_CHARS)
				throw new Error(`sql is longer than ${SQL_MAX_CHARS} characters`);
			const ids: string[] = [];
			if (o.task_id !== undefined) ids.push(taskId(o.task_id, 'task_id'));
			if (o.task_ids !== undefined) {
				if (!Array.isArray(o.task_ids) || o.task_ids.length === 0) {
					throw new Error('task_ids must be a non-empty array');
				}
				for (const id of o.task_ids) ids.push(taskId(id, 'task_ids[]'));
			}
			if (ids.length > BUILTIN_TASK_IDS_MAX) {
				throw new Error(`at most ${BUILTIN_TASK_IDS_MAX} task ids — use worker and since instead`);
			}
			const scope: Scope = {
				...(o.worker !== undefined ? { worker: worker(o.worker) } : {}),
				...(ids.length > 0 ? { task_ids: [...new Set(ids)] } : {}),
				...(o.since !== undefined ? { since: since(o.since) } : {})
			};
			if (Object.keys(scope).length === 0) {
				throw new Error('query needs a scope: worker, task_id, task_ids or since');
			}
			if (o.expect_shape !== undefined) {
				if (typeof o.expect_shape !== 'string' || !SHAPE_HASH.test(o.expect_shape)) {
					throw new Error('expect_shape must be a shape_hash (16 hex characters)');
				}
			}
			return {
				op: 'query',
				sql: o.sql,
				scope,
				...(o.expect_shape !== undefined ? { expect_shape: o.expect_shape as string } : {})
			};
		}
		case 'read': {
			only(o, ['op', 'task_id', 'run_no', 'path', 'offset', 'limit']);
			const path = o.path === undefined ? '$' : o.path;
			if (typeof path !== 'string' || !path.startsWith('$') || path.length > PATH_MAX_CHARS) {
				throw new Error('path must be a JSON path starting with $ (for example $.items)');
			}
			return {
				op: 'read',
				task_id: taskId(o.task_id, 'task_id'),
				...(o.run_no !== undefined ? { run_no: runNo(o.run_no) } : {}),
				path,
				offset: o.offset === undefined ? 0 : count(o.offset, 'offset', 0, Number.MAX_SAFE_INTEGER),
				limit: o.limit === undefined ? null : count(o.limit, 'limit', 1, READ_LIMIT_MAX)
			};
		}
		default:
			throw new Error('op must be "describe", "query" or "read"');
	}
}

/** Run number of a repeating task — starts at 1 */
function runNo(v: unknown): number {
	return count(v, 'run_no', 1, Number.MAX_SAFE_INTEGER);
}

function only(o: Record<string, unknown>, keys: string[]): void {
	const extra = Object.keys(o).filter((k) => !keys.includes(k));
	if (extra.length > 0) throw new Error(`unknown field ${extra.map((k) => `"${k}"`).join(', ')}`);
}

function taskId(v: unknown, field: string): string {
	if (typeof v !== 'string' || !TASK_ID.test(v)) throw new Error(`${field} must be a task id`);
	return v;
}

function worker(v: unknown): string {
	if (
		typeof v !== 'string' ||
		v.length === 0 ||
		Array.from(v).length > WORKER_MAX_CHARS ||
		v.includes('\0')
	) {
		throw new Error('worker must be a worker name');
	}
	return v;
}

function since(v: unknown): string {
	const t = typeof v === 'string' ? Date.parse(v) : Number.NaN;
	if (Number.isNaN(t))
		throw new Error('since must be an ISO date or time (for example 2026-10-01)');
	return new Date(t).toISOString();
}

function count(v: unknown, field: string, min: number, max: number): number {
	if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
		throw new Error(`${field} must be an integer from ${min} to ${max}`);
	}
	return v;
}
