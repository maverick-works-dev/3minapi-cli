/**
 * Messages between the executor (executor.ts) and the worker thread (thread.ts), and failure reasons.
 */

/** error.data.reason of a `failed` reply — each kind calls for a different next step */
export type FailureReason =
	/** The handler threw */
	| 'handler_error'
	/** Exceeded timeoutMs */
	| 'timeout'
	/** Input does not match the worker's input schema — not run */
	| 'invalid_input'
	/** No workers/<name> file */
	| 'worker_not_found'
	/** The file exists but is not a usable worker — no handler, duplicate name, or import failure */
	| 'invalid_worker'
	/** TypeScript syntax that cannot run without a build (enum, namespace, etc.) */
	| 'unsupported_syntax'
	/**
	 * The reply exceeds the limit (100 KiB) and no substitute can be sent — public worker serving, or saving to
	 * data.db failed. Also used for the server's 413/415 rejections (docs/design/15_cli.md §8-5)
	 */
	| 'result_too_large'
	/** The result has the reserved top-level key `_3minapi`, indistinguishable from a substitute. Saved to data.db */
	| 'reserved_result_key'
	/** The CLI on this PC stopped (Ctrl+C, stop) */
	| 'host_stopped'
	/**
	 * The CLI on this PC stopped without finishing (killed, power loss) — the next `start` closes the previous run's
	 * acked tasks with this. Whether they ran is unknown (#1417)
	 */
	| 'host_restarted'
	/** Consecutive runs of a repeating task failed, closing the whole repeat — `data` has runs and failed */
	| 'repeat_failed'
	// ── Built-in reader worker (docs/design/15_cli.md §8-6) — no answer produced ──
	/** No saved result in scope (wrong task_id or worker, deleted, or a local `--serve` result) */
	| 'result_not_found'
	/** The SQL does something other than read, or reads outside `results` */
	| 'query_denied'
	/** SQL syntax or execution error */
	| 'query_error'
	/** A result in scope has a shape different from `expect_shape` — not run */
	| 'shape_mismatch'
	/** The read path does not exist or the offset is out of range */
	| 'read_out_of_range';

export interface ThreadInput {
	file: string;
	input: unknown;
	/** true = report the module's exports without calling the handler (`worker list`) */
	inspect?: boolean;
	/** Happy Eyeballs attempt timeout set by the parent — net defaults are per thread (core/network.ts) */
	connectAttemptTimeoutMs?: number;
}

/** Worker file exports shown by `worker list` */
export interface WorkerMeta {
	description: string | null;
	timeoutMs: number | null;
	hasInputSchema: boolean;
}

export type ToThread = { type: 'cancel' } | { type: 'report-ack'; id: number };

export type FromThread =
	/** Module loaded — the timer is reset to the file's timeoutMs */
	| { type: 'loaded'; timeoutMs: number | null }
	| { type: 'meta'; meta: WorkerMeta }
	| { type: 'log'; message: string }
	| { type: 'report'; id: number; message: string }
	/** The thread serializes the result to JSON — catching unserializable values (functions, BigInt, cycles) there */
	| { type: 'done'; json: string }
	/** The stack goes to the local worker log only — never to the server */
	| { type: 'fail'; reason: FailureReason; message: string; stack?: string };
