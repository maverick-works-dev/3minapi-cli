/**
 * The life of one task — receive → ack → run → reply → local record. Pull (poller) and push (local server) meet here
 * (same envelope — docs/design/14_cli_host.md §3-2, docs/design/13_task.md §4).
 *
 * Result storage (docs/design/15_cli.md §8-5): finished results (completed, failed) are stored in data.db **before**
 * replying, and what was sent (`reply`) is recorded after. A reply over 100 KiB becomes a substitute result pointing
 * to the stored original for local (pull) workers, `failed` otherwise. Built-in read worker results are not stored —
 * they derive from stored originals and always fit the reply budget.
 *
 * Reply error handling (docs/design/14_cli_host.md §6-3):
 *   stop code             → onStop — all calls stop (ApiClient is already closed)
 *   404·409 (TASK_CODES)  → drop only that task (run)
 *   413·415               → reply again with the next fallback (substitute result → `failed`); same for resending queued replies
 *   other (network, 5xx)  → terminal replies are resent on the next polling cycle. No backoff
 *
 * On a stop code, running tasks get no reply (#1362). A user stop (Ctrl+C, stop) doesn't block calls, so it replies
 * `failed` (host_stopped) and the AI doesn't wait 24 hours.
 *
 * An acked task is always concluded — the server never redelivers after ack, so if a previous run died first, the next
 * `start` closes it with `recover()`. Only as many tasks as can run are taken (`free`), so pull tasks barely wait
 * locally; `started` (control.db `running`) is the moment the runner puts one in a slot (#1417).
 *
 * Repeat tasks (docs/design/15_cli.md §8-7): after ack they go to the scheduler (repeat-scheduler.ts) and `runRepeat`
 * runs each run on the same runner. Runs skip the one-shot conclusion (`conclude`, `terminal`, `finish`) — each leaves
 * one data.db row (`reply = 'none'`) and one progress report call, and the row stays `running`. Progress reports are
 * not resent (values are cumulative, so the next run's report supersedes). A repeat closes only on reaching `max_runs`
 * (completed summary), consecutive failures (repeat_failed), server cancellation, worker deletion or 409; a user stop
 * or stop code only cuts the running run (no reply — the next `start` resumes).
 */
import type { ControlDb, TaskRow, TerminalState } from '../../core/control-db.ts';
import { RepeatScheduler, parseSettings } from './repeat-scheduler.ts';
import { ApiError } from '../../core/api.ts';
import {
	ERROR_MESSAGE_MAX_CHARS,
	EVENT_MESSAGE_MAX_CHARS,
	REPORT_ENVELOPE_RESERVE,
	REPEAT_FAIL_STREAK_MAX,
	REPORT_MAX_BYTES,
	RESULT_RESERVED_KEY,
	STATUS_MESSAGE_MAX_CHARS,
	StopError,
	TASK_CODES,
	TASK_ERROR_CODE,
	type RepeatProgress,
	type RepeatSettings,
	type ReportBody
} from '../../core/domain/index.ts';
import type { Logger } from '../../core/logger.ts';
import { computeShape, type Shape } from './results/shape.ts';
import type { ReplyState, ResultRecord, ResultSource, StoredResult } from './results/store.ts';
import { substituteResult, substituteStatusMessage } from './results/substitute.ts';
import type { Executor, Outcome } from './runtime/executor.ts';
import type { FailureReason } from './runtime/protocol.ts';
import { formatCount, oneLine, stripControl, truncate } from '../../core/text.ts';

/** Cancellation reason — carried in the runner's cancelled outcome */
export const CANCEL = {
	/** Cancelled on the server (pull's cancelled[]) */
	server: 'cancelled',
	/** The same task arrived again with a new lease */
	superseded: 'superseded',
	/** The user stopped this CLI */
	shutdown: 'host_stopped'
} as const;
const STOPPED_PREFIX = 'stopped: ';

/** Cap on unsent replies kept — past the server's 24-hour task deadline they aren't accepted anyway */
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface TaskEnvelope {
	task_id: string;
	worker: string;
	input: unknown;
	/** null = direct local call (`POST /task/<name>`) — no reply */
	callback_url: string | null;
	/** Pull only */
	lease_id: string | null;
	delivery_attempt: number;
	/** Receive path — a stored column; only pull (local workers) sends substitute results */
	source: ResultSource;
	/** Repeat task — the pull envelope's `data.repeat`. Absent for `--serve` and `worker run` */
	repeat?: RepeatSettings;
}

/** Where results are kept — data.db (results/store.ts). Tests inject a stub */
export interface ResultSink {
	save(rec: ResultRecord): void;
	setReply(taskId: string, reply: ReplyState, runNo?: number): void;
	/** Restart cleanup finds results whose reply wasn't sent (#1417) */
	get(taskId: string): StoredResult | null;
}

export interface Reporter {
	report(callbackUrl: string, body: ReportBody): Promise<unknown>;
}

export interface TaskRunnerOptions {
	executor: Executor;
	db: ControlDb;
	logger: Logger;
	now(): number;
	/** Received a stop code while replying */
	onStop(err: StopError): void;
	/** One line for humans (foreground output) */
	onEvent?(line: string): void;
	/**
	 * Free slots went from 0 to some — the live receiver performs its deferred pull (docs/design/14_cli_host.md §13-6 item 4).
	 * Called only on the 0 → positive change, so a string of finishing tasks doesn't trigger a pull each. Repeat runs hold slots too, so also called when a run ends
	 */
	onSlotFree?(): void;
	/** null = no storage (data.db couldn't be opened) — oversized results fail as before */
	results?: ResultSink | null;
	/** Cap on the reply result — reduced in tests */
	maxResultBytes?: number;
	/**
	 * Whether this is a built-in worker — its results aren't stored in data.db (derived from stored originals) and failure
	 * messages aren't written to logs or the control DB (SQL error text can include input fragments — docs/design/15_cli.md §7-4)
	 */
	isBuiltin?(worker: string): boolean;
	/** Currently active built-in read worker name — `reader` of substitute results. null if none */
	reader?(): string | null;
	/**
	 * Report and final-reply client for repeat runs — runs happen outside pull responses. null means repeats aren't accepted (closed as failed)
	 */
	repeatReporter?: Reporter | null;
	/** Repeat scheduler tick — replaced in tests */
	repeatEvery?(fn: () => void, ms: number): { clear(): void };
}

type SendResult = 'ok' | 'skip' | 'stop' | 'drop' | 'too_large' | 'retry';

/** Progress after a run ends — counted on from the control DB row */
interface RunTally {
	runs: number;
	failed: number;
	streak: number;
}

/** One reply — on 413·415 the next one in the list is sent (substitute result → failed) */
interface Reply {
	body: ReportBody;
	state: TerminalState;
	/** data.db reply column */
	reply: ReplyState;
	error?: string;
}

interface Inflight {
	leaseId: string | null;
	done: Promise<void>;
}

interface PendingReply {
	task: TaskEnvelope;
	reporter: Reporter;
	/** Unsent ones first — the first element is the next reply to send */
	replies: Reply[];
	since: number;
}

export class TaskRunner {
	private readonly opts: TaskRunnerOptions;
	private readonly inflight = new Map<string, Inflight>();
	private pending: PendingReply[] = [];
	/** Repeats in ack round trip — they count toward slots (like one-shot inflight). Running runs count as inflight */
	private repeatAcks = 0;
	/** Resend in progress — only one at a time (live also calls it from a timer, separate from pull) */
	private flushing: Promise<void> | null = null;
	/** Once more after the in-progress resend — it took the queue when it started and won't send what queued afterwards */
	private flushAgain: Promise<void> | null = null;
	private readonly scheduler: RepeatScheduler;

	constructor(opts: TaskRunnerOptions) {
		this.opts = opts;
		this.scheduler = new RepeatScheduler({
			db: opts.db,
			logger: opts.logger,
			now: opts.now,
			run: (taskId, runNo) => this.runRepeat(taskId, runNo),
			every: opts.repeatEvery
		});
	}

	/**
	 * How many can be taken now — pull's max (#1417). Counted from **received and unfinished** tasks (inflight), not the
	 * runner's free slots — tasks in ack round trip aren't in the runner yet, so it would show spare slots. Push (`--serve`)
	 * arrives without a cap, so inflight can exceed it
	 */
	get free(): number {
		// Repeats waiting for their next run don't count — so one repeat never blocks a slot forever (docs/design/15_cli.md §8-7)
		return Math.max(0, this.opts.executor.concurrency - this.inflight.size - this.repeatAcks);
	}

	get busy(): number {
		return this.inflight.size;
	}

	/** Number of scheduled repeats */
	get repeating(): number {
		return this.scheduler.size;
	}

	/** Resumes repeats left by the previous run — once, after the first successful pull (docs/design/15_cli.md §8-7) */
	startRepeats(): void {
		this.scheduler.load();
	}

	/** Closes repeats of workers deleted on the server (locally only — already gone on the server, docs/design/14_cli_host.md §10) */
	dropRepeats(workers: readonly string[]): void {
		const gone = new Set(workers);
		const ids = new Set(this.scheduler.dropWorkers(workers));
		// Including previous-run repeats not resumed yet
		for (const row of this.opts.db.repeatTasks()) if (gone.has(row.worker)) ids.add(row.task_id);
		for (const id of ids) {
			this.scheduler.remove(id);
			this.opts.logger.info('repeating task stopped; its worker was deleted on the server', {
				task_id: id
			});
			this.opts.db.markFinished(id, 'cancelled', this.opts.now(), 'worker deleted on the server');
			this.opts.executor.cancel(id, CANCEL.server);
		}
	}

	/** Never throws — the poller moves on to the next task without waiting */
	handle(task: TaskEnvelope, reporter: Reporter | null, { ack }: { ack: boolean }): Promise<void> {
		return this.process(task, reporter, ack).catch((err: unknown) => {
			this.opts.logger.error('task handling failed', {
				task_id: task.task_id,
				worker: task.worker,
				message: (err as Error)?.stack ?? String(err)
			});
		});
	}

	/** Cancelled on the server (pull's cancelled[]) */
	cancel(taskId: string): void {
		// Close repeats even while waiting for a run — including previous-run repeats not yet scheduled (first pull's cancelled[])
		const repeat = this.scheduler.has(taskId) || this.isWaitingRepeat(taskId);
		if (repeat) {
			this.scheduler.remove(taskId);
			this.opts.db.markFinished(taskId, 'cancelled', this.opts.now());
			this.event(`${this.workerOf(taskId)}  ${shortId(taskId)}  repeat cancelled`);
		}
		// A running run is cut too (no reply — concludeRun leaves nothing when the repeat is off the schedule)
		if (this.opts.executor.cancel(taskId, CANCEL.server) || repeat) {
			this.opts.logger.info('task cancelled by the server', { task_id: taskId });
		}
	}

	/** Repeats only in the control DB (not resumed yet) */
	private isWaitingRepeat(taskId: string): boolean {
		const row = this.opts.db.getTask(taskId);
		return Boolean(row?.repeat) && (row!.state === 'received' || row!.state === 'running');
	}

	/**
	 * The user stopped — cancels running tasks, replies failed (host_stopped), then ends. Repeats only have their run cut, with no reply.
	 * The scheduler stops first — enqueuing runs on a stopped runner would pile up failed runs
	 */
	async shutdown(): Promise<void> {
		this.scheduler.stop();
		await this.opts.executor.cancelAll(CANCEL.shutdown);
		await this.settled();
	}

	/** Stop code — cut immediately, no reply */
	async halt(reason: string): Promise<void> {
		this.scheduler.stop();
		// Clear after the in-progress resend ends — clearing first would let it re-queue leftovers (not sent, the client is stopped)
		await (this.flushAgain ?? this.flushing);
		this.pending = [];
		await this.opts.executor.haltAll(STOPPED_PREFIX + reason);
		await this.settled();
	}

	/**
	 * Resends unsent terminal replies — poll: on every pull; live: on every pull plus a `LIVE_RETRY_MS` timer
	 * (docs/design/14_cli_host.md §13-9). One at a time so a reply is never sent twice. A call during a resend runs once
	 * more after it, so replies queued meanwhile (e.g. host_stopped at exit) go out before this call returns (#1462)
	 */
	flushPending(): Promise<void> {
		if (this.flushing) {
			this.flushAgain ??= this.flushing.then(() => {
				this.flushAgain = null;
				return this.flushPending();
			});
			return this.flushAgain;
		}
		this.flushing = this.flushQueue().finally(() => (this.flushing = null));
		return this.flushing;
	}

	private async flushQueue(): Promise<void> {
		const queue = this.pending;
		this.pending = [];
		for (const [i, p] of queue.entries()) {
			const { r, at } = await this.deliver(p.task, p.reporter, p.replies);
			if (r === 'stop') {
				this.pending.push({ ...p, replies: p.replies.slice(at) }, ...queue.slice(i + 1));
				return;
			}
			if (r === 'retry') {
				if (this.opts.now() - p.since < PENDING_MAX_AGE_MS) {
					this.pending.push({ ...p, replies: p.replies.slice(at) });
				} else {
					this.setReply(p.task, 'rejected');
					this.finish(p.task, p.replies[at].state, 'reply was not delivered within 24 hours');
				}
				continue;
			}
			// 413·415 also send the fallback here — otherwise the task stays working on the server for 24 hours (#1397)
			this.settle(p.task, r, p.replies[at]);
		}
	}

	/**
	 * Closes tasks the previous run left unfinished (docs/design/14_cli_host.md §4). Called once by `start` after taking
	 * the runner lock, before the first pull or serve — every unfinished row then is from a previous run. Nothing is
	 * re-run (external side effects could repeat).
	 *
	 *   result whose reply wasn't sent (data.db reply=pending) → resend the stored result
	 *   reply sent but stopped before recording                → close locally only
	 *   run started or ack reached the server                  → failed(host_restarted) — the server won't redeliver
	 *   ack didn't reach the server                            → no reply. The server still treats it as the current lease and
	 *                                                            would accept a final reply, killing a task due for redelivery.
	 *                                                            After the lease ends it comes back and runs
	 *   push (no lease)                                        → no reply key. Close locally only
	 *
	 * Reply handling is as usual — 404·409 clean up locally, network failures retry on each poll. Returns rows closed (#1417)
	 */
	async recover(reporter: Reporter): Promise<number> {
		const rows = this.opts.db.unfinishedTasks();
		for (const row of rows) await this.recoverOne(row, reporter);
		// Acked repeats aren't closed but resumed — only the cut run is recorded as a failed run (docs/design/15_cli.md §8-7)
		for (const row of this.opts.db.repeatTasks()) await this.recoverRepeat(row);
		return rows.length;
	}

	/** A run started but never recorded its end → a host_restarted failed run. Closes the repeat if that fills the consecutive-failure limit */
	private async recoverRepeat(row: TaskRow): Promise<void> {
		const task = this.repeatEnvelope(row);
		if (!task) return;
		const runNo = row.run_no ?? 0;
		if (runNo <= (row.runs ?? 0)) {
			// The last run cut by a stop may have met the end condition (it wasn't closed then)
			await this.closeIfDone(task, tallyOf(row), row.last_run_at ?? this.opts.now(), null);
			return;
		}
		this.opts.logger.warn('a run of a repeating task was cut off by the previous run', {
			task_id: row.task_id,
			worker: row.worker,
			run_no: runNo
		});
		const message =
			"the 3minapi CLI on the user's PC stopped during this run — it is unknown whether it finished";
		await this.recordRun(task, runNo, tallyOf(row), {
			ok: false,
			reason: 'host_restarted',
			message,
			payload: JSON.stringify(failedBody('host_restarted', message).error),
			report: false,
			close: true
		});
	}

	private async recoverOne(row: TaskRow, reporter: Reporter): Promise<void> {
		const { logger } = this.opts;
		const pull = Boolean(row.lease_id);
		if (row.repeat) {
			// Repeat whose ack didn't arrive — the server resends it (progress keeps counting then). A final reply would kill that repeat
			logger.info('dropping an unacknowledged repeating task; the server will deliver it again', {
				task_id: row.task_id,
				worker: row.worker
			});
			return this.opts.db.markFinished(
				row.task_id,
				'superseded',
				this.opts.now(),
				'not acknowledged before the restart; the server will deliver it again'
			);
		}
		const task: TaskEnvelope = {
			task_id: row.task_id,
			worker: row.worker,
			input: null,
			callback_url: row.callback_url ?? null,
			lease_id: pull ? row.lease_id : null,
			delivery_attempt: row.delivery_attempt,
			source: 'pull'
		};
		const id = `${row.worker}  ${shortId(row.task_id)}`;
		const attrs = { task_id: row.task_id, worker: row.worker, state: row.state };
		const message =
			"the 3minapi CLI on the user's PC stopped before this task finished — it is unknown whether it ran";

		if (!pull) {
			logger.warn('closing a pushed task left unfinished by the previous run', attrs);
			return this.finish(task, 'failed', message);
		}

		const stored = this.storedResult(row.task_id);
		if (stored && stored.reply !== 'pending') {
			// The reply went out (or was rejected) — only the record is missing
			return this.finish(task, stored.status);
		}
		if (stored) {
			logger.info('resending the reply of a task the previous run finished', attrs);
			if (stored.status === 'completed')
				return this.completed(task, reporter, stored.payload, 0, stored);
			const failed = parseStoredError(stored.payload);
			if (failed) {
				this.event(`${id}  failed earlier (${failed.reason}); resent its reply`);
				return this.terminal(task, reporter, this.failedReplies(failed.reason, failed.message));
			}
		}

		if (row.state === 'running' || row.acked_at != null) {
			logger.warn('closing a task left unfinished by the previous run', attrs);
			this.event(`${id}  failed (host_restarted): the previous run stopped before it finished`);
			if (task.callback_url === null) return this.finish(task, 'failed', message);
			this.store(task, 'failed', JSON.stringify(failedBody('host_restarted', message).error));
			return this.terminal(task, reporter, this.failedReplies('host_restarted', message));
		}

		logger.info('dropping an unacknowledged task; the server will deliver it again', attrs);
		this.finish(
			task,
			'superseded',
			'not acknowledged before the restart; the server will deliver it again'
		);
	}

	private storedResult(taskId: string): StoredResult | null {
		if (!this.opts.results) return null;
		try {
			return this.opts.results.get(taskId);
		} catch (err) {
			this.opts.logger.warn('could not read the saved result', {
				task_id: taskId,
				message: (err as Error).message
			});
			return null;
		}
	}

	private async settled(): Promise<void> {
		while (this.inflight.size > 0) {
			await Promise.all([...this.inflight.values()].map((f) => f.done));
		}
	}

	private async process(
		task: TaskEnvelope,
		reporter: Reporter | null,
		ack: boolean
	): Promise<void> {
		const { executor, db, logger } = this.opts;
		if (task.repeat && task.lease_id !== null) return this.receiveRepeat(task, reporter, ack);
		const prev = this.inflight.get(task.task_id);
		if (prev) {
			// Same delivery again — already running
			if (prev.leaseId === task.lease_id) return;
			// Arrived again with a new lease = the server didn't get our ack. To the server, the earlier run is dead
			executor.cancel(task.task_id, CANCEL.superseded);
			await prev.done;
		}

		if (db.receive(this.received(task), this.opts.now()) === 'duplicate-done') {
			logger.info('task already finished here; not running it again', { task_id: task.task_id });
			return;
		}

		let release!: () => void;
		const entry: Inflight = { leaseId: task.lease_id, done: new Promise((r) => (release = r)) };
		this.inflight.set(task.task_id, entry);
		try {
			await this.execute(task, reporter, ack);
		} finally {
			this.releaseSlot(() => {
				if (this.inflight.get(task.task_id) === entry) this.inflight.delete(task.task_id);
			});
			release();
		}
	}

	private async execute(
		task: TaskEnvelope,
		reporter: Reporter | null,
		ack: boolean
	): Promise<void> {
		const { executor, db, logger, now } = this.opts;
		const attrs = { task_id: task.task_id, worker: task.worker };

		if (ack) {
			const r = await this.send(task, reporter, { status: 'working' });
			if (r === 'ok') db.markAcked(task.task_id, now());
			if (r === 'stop') return this.finish(task, 'cancelled', 'stopped before it started');
			if (r === 'drop')
				return this.finish(task, 'superseded', 'the server no longer accepts this task');
			if (r === 'retry' || r === 'too_large') {
				// Run anyway. If only the response was lost, the server recorded the ack and won't resend — waiting means failed in 24 hours.
				// A terminal reply is accepted without ack if the lease is current. If the server really missed it, it comes back with a
				// new lease after expiry, and process() cuts this run (superseded) and reruns with the new lease (docs/design/14_cli_host.md §4)
				logger.warn('could not confirm the acknowledgement; running the task anyway', attrs);
			}
		}

		// Started = when the runner puts it in a slot; while queued it is received (#1417)
		let startedAt = null as number | null;
		const outcome = await executor.run(
			{ id: task.task_id, worker: task.worker, input: task.input },
			{
				onStart: () => {
					startedAt = now();
					db.markRunning(task.task_id, startedAt);
					logger.info('task started', attrs);
					this.event(`${task.worker}  ${shortId(task.task_id)}  started`);
				},
				onReport: async (message) => {
					const r = await this.send(task, reporter, {
						status: 'working',
						status_message: clip(message, STATUS_MESSAGE_MAX_CHARS)
					});
					if (r === 'drop') executor.cancel(task.task_id, CANCEL.superseded);
				}
			}
		);
		const ms = startedAt === null ? 0 : now() - startedAt;
		await this.conclude(task, reporter, outcome, ms);
	}

	private async conclude(
		task: TaskEnvelope,
		reporter: Reporter | null,
		outcome: Outcome,
		ms: number
	): Promise<void> {
		const { logger } = this.opts;
		const attrs = { task_id: task.task_id, worker: task.worker, duration_ms: ms };

		if (outcome.status === 'cancelled') {
			if (outcome.reason.startsWith(STOPPED_PREFIX)) {
				// Stop — no reply. ApiClient is already closed too
				logger.warn('task aborted by the stop; not reported', attrs);
				this.event(
					`${task.worker}  ${shortId(task.task_id)}  aborted (not reported — calls are stopped)`
				);
				return this.finish(task, 'cancelled', outcome.reason);
			}
			if (outcome.reason === CANCEL.shutdown) {
				logger.info('task aborted because the CLI is stopping', attrs);
				this.event(`${task.worker}  ${shortId(task.task_id)}  aborted (CLI stopping)`);
				const message = "the 3minapi CLI on the user's PC stopped before the task finished";
				this.store(task, 'failed', JSON.stringify(failedBody('host_stopped', message).error));
				return this.terminal(task, reporter, [
					{ body: failedBody('host_stopped', message), state: 'failed', reply: 'failed' }
				]);
			}
			const state: TerminalState =
				outcome.reason === CANCEL.superseded ? 'superseded' : 'cancelled';
			logger.info(`task ${state}`, attrs);
			this.event(`${task.worker}  ${shortId(task.task_id)}  ${state}`);
			return this.finish(task, state);
		}

		if (outcome.status === 'completed')
			return this.completed(task, reporter, outcome.resultJson, ms);

		const builtin = this.opts.isBuiltin?.(task.worker) ?? false;
		logger.warn('task failed', {
			...attrs,
			reason: outcome.reason,
			...(builtin ? {} : { message: outcome.message })
		});
		this.event(
			`${task.worker}  ${shortId(task.task_id)}  failed (${outcome.reason}): ${clip(outcome.message, EVENT_MESSAGE_MAX_CHARS)}`
		);
		// Store the message before redaction and truncation (executor.ts detail)
		this.store(
			task,
			'failed',
			JSON.stringify(failedBody(outcome.reason, outcome.detail ?? outcome.message).error)
		);
		return this.terminal(task, reporter, [
			{
				body: failedBody(outcome.reason, outcome.message),
				state: 'failed',
				reply: 'failed',
				error: builtin ? outcome.reason : outcome.message
			}
		]);
	}

	/**
	 * Completed — store and choose the reply (table in docs/design/15_cli.md §8-5).
	 * reserved key → failed / within cap → original result / oversized: substitute result if a local worker and stored, otherwise failed
	 */
	private completed(
		task: TaskEnvelope,
		reporter: Reporter | null,
		resultJson: string,
		ms: number,
		/** Restart cleanup resends it — the row is already stored, so it isn't stored again (#1417) */
		resend: StoredResult | null = null
	): Promise<void> {
		const { logger } = this.opts;
		const attrs = { task_id: task.task_id, worker: task.worker, duration_ms: ms };
		const id = `${task.worker}  ${shortId(task.task_id)}`;
		const done = resend ? 'completed earlier; resent its reply' : `completed in ${ms} ms`;
		const value: unknown = JSON.parse(resultJson);
		const bytes = Buffer.byteLength(resultJson);
		let shape: { shape: Shape; hash: string } | null = null;
		let saved: boolean;
		if (resend) {
			shape =
				resend.shape && resend.shape_hash ? { shape: resend.shape, hash: resend.shape_hash } : null;
			saved = true;
		} else {
			if (this.opts.results && !this.opts.isBuiltin?.(task.worker)) shape = computeShape(value);
			saved = this.store(task, 'completed', resultJson, shape);
		}
		const where = saved
			? "it was saved on the user's PC (3minapi worker results show " + task.task_id + ')'
			: "it could not be saved on the user's PC";

		if (isReserved(value)) {
			const message = `the result has a top-level "${RESULT_RESERVED_KEY}" key, which 3minapi reserves — rename it; ${where}`;
			logger.warn('task failed', { ...attrs, reason: 'reserved_result_key' });
			this.event(
				`${id}  failed (reserved_result_key): rename the top-level "${RESULT_RESERVED_KEY}" key`
			);
			return this.terminal(task, reporter, this.failedReplies('reserved_result_key', message));
		}

		const tooLarge = this.failedReplies(
			'result_too_large',
			`the result is ${formatCount(bytes)} bytes, over the 100 KiB reply limit; ${where}`
		);
		const substitute: Reply[] =
			task.source === 'pull' && saved && shape
				? [
						{
							body: {
								status: 'completed',
								status_message: substituteStatusMessage(bytes),
								result: substituteResult({
									taskId: task.task_id,
									worker: task.worker,
									bytes,
									shape: shape.shape,
									shapeHash: shape.hash,
									reader: this.opts.reader?.() ?? null
								})
							},
							state: 'completed',
							reply: 'substitute'
						}
					]
				: [];
		const max = this.opts.maxResultBytes ?? REPORT_MAX_BYTES - REPORT_ENVELOPE_RESERVE;
		if (bytes <= max) {
			logger.info('task completed', attrs);
			this.event(`${id}  ${done}`);
			// If the server still answers 413·415, substitute result, then failed
			return this.terminal(task, reporter, [
				{ body: { status: 'completed', result: value }, state: 'completed', reply: 'result' },
				...substitute,
				...tooLarge
			]);
		}
		if (substitute.length > 0) {
			logger.info('task completed; the result is stored locally and a summary was sent', {
				...attrs,
				bytes
			});
			this.event(`${id}  ${done} — ${formatCount(bytes)} bytes saved in data.db, sent a summary`);
			return this.terminal(task, reporter, [...substitute, ...tooLarge]);
		}
		logger.warn('task failed', { ...attrs, reason: 'result_too_large', bytes, saved });
		this.event(
			`${id}  failed (result_too_large): ${formatCount(bytes)} bytes${saved ? ' — saved in data.db' : ''}`
		);
		return this.terminal(task, reporter, tooLarge);
	}

	/** Failure reply — if even that gets 413·415, there is nothing left to shrink */
	private failedReplies(reason: FailureReason, message: string): Reply[] {
		return [
			{ body: failedBody(reason, message), state: 'failed', reply: 'failed', error: message }
		];
	}

	/** Stores to data.db — failures only warn (the reply continues). true if stored */
	private store(
		task: TaskEnvelope,
		status: 'completed' | 'failed',
		payload: string,
		shape: { shape: Shape; hash: string } | null = null,
		/** Repeat run — a row that gets no reply ('none') */
		runNo?: number
	): boolean {
		const { results } = this.opts;
		if (!results || this.opts.isBuiltin?.(task.worker)) return false;
		try {
			results.save({
				taskId: task.task_id,
				worker: task.worker,
				createdAt: this.opts.now(),
				source: task.source,
				status,
				reply: task.source === 'serve' || runNo !== undefined ? 'none' : 'pending',
				payload,
				shape: shape?.shape ?? null,
				shapeHash: shape?.hash ?? null,
				...(runNo !== undefined ? { runNo } : {})
			});
			return true;
		} catch (err) {
			const message = (err as Error).message;
			this.opts.logger.warn('could not save the result to data.db', {
				task_id: task.task_id,
				message
			});
			this.event(
				`${task.worker}  ${shortId(task.task_id)}  result not saved to data.db: ${message}`
			);
			return false;
		}
	}

	private setReply(task: TaskEnvelope, reply: ReplyState): void {
		// A repeat's final reply (summary) has no data.db row — run rows stay 'none'
		if (task.repeat) return;
		if (!this.opts.results || task.source === 'serve' || this.opts.isBuiltin?.(task.worker)) return;
		try {
			this.opts.results.setReply(task.task_id, reply);
		} catch (err) {
			this.opts.logger.warn('could not update the saved result', {
				task_id: task.task_id,
				message: (err as Error).message
			});
		}
	}

	private async terminal(
		task: TaskEnvelope,
		reporter: Reporter | null,
		replies: Reply[]
	): Promise<void> {
		const { r, at } = await this.deliver(task, reporter, replies);
		if (r === 'retry') {
			this.opts.logger.warn('reply not delivered; will retry later', {
				task_id: task.task_id
			});
			this.pending.push({
				task,
				reporter: reporter!,
				replies: replies.slice(at),
				since: this.opts.now()
			});
			return;
		}
		this.settle(task, r, replies[at]);
	}

	/** On 413·415 move to the next fallback — the result and the index of the reply last sent (or attempted) */
	private async deliver(
		task: TaskEnvelope,
		reporter: Reporter | null,
		replies: Reply[]
	): Promise<{ r: SendResult; at: number }> {
		let at = 0;
		let r = await this.send(task, reporter, replies[0].body);
		while (r === 'too_large' && at < replies.length - 1) {
			at++;
			r = await this.send(task, reporter, replies[at].body);
		}
		return { r, at };
	}

	/** Finish with the sent result (except retry) */
	private settle(task: TaskEnvelope, r: Exclude<SendResult, 'retry'>, reply: Reply): void {
		switch (r) {
			case 'ok':
				this.setReply(task, reply.reply);
				return this.finish(task, reply.state, reply.error);
			case 'skip':
				return this.finish(task, reply.state, reply.error);
			case 'drop':
				this.setReply(task, 'rejected');
				return this.finish(task, reply.state, 'the server no longer accepts this task');
			case 'stop':
				this.setReply(task, 'rejected');
				return this.finish(task, reply.state, 'not reported — calls are stopped');
			case 'too_large':
				// Even the last fallback (a small failed) was rejected — resending gives the same
				this.setReply(task, 'rejected');
				return this.finish(task, 'failed', 'the server rejected every reply as too large');
		}
	}

	private async send(
		task: TaskEnvelope,
		reporter: Reporter | null,
		body: ReportBody,
		/** Treat 400 (invalid_request) as drop — repeat reports. Resending the same report gets the same 400 */
		invalidAsDrop = false,
		/** Repeat run report — logged with `run_no` (the dashboard filters per run) */
		runNo?: number
	): Promise<SendResult> {
		if (!reporter || task.callback_url === null) return 'skip';
		const withLease: ReportBody =
			task.lease_id === null ? body : { ...body, lease_id: task.lease_id };
		try {
			await reporter.report(task.callback_url, withLease);
			return 'ok';
		} catch (err) {
			if (err instanceof StopError) {
				this.opts.onStop(err);
				return 'stop';
			}
			if (err instanceof ApiError) {
				const attrs = {
					task_id: task.task_id,
					...(runNo !== undefined ? { run_no: runNo } : {}),
					status: err.status,
					code: err.code,
					message: err.message
				};
				if (err.code !== null && (TASK_CODES as readonly string[]).includes(err.code)) {
					this.opts.logger.info('the server dropped the task', attrs);
					return 'drop';
				}
				if (invalidAsDrop && err.code === 'invalid_request') {
					this.opts.logger.error('the server rejected a repeat report (a CLI bug)', attrs);
					return 'drop';
				}
				if (err.code === 'payload_too_large' || err.code === 'unsupported_media_type') {
					this.opts.logger.warn('the server rejected the reply', attrs);
					return 'too_large';
				}
				this.opts.logger.warn('reply failed', attrs);
				return 'retry';
			}
			throw err;
		}
	}

	// ── Repeat tasks ──────────────────────────────────

	/**
	 * Received a repeat task — ack, then hand to the scheduler (run 1 immediately). If the same repeat comes back with a
	 * new lease (the server missed the ack), only the row's lease changes and it is acked again — a running run isn't cut.
	 * Each run reads the lease from the row
	 */
	private async receiveRepeat(
		task: TaskEnvelope,
		reporter: Reporter | null,
		ack: boolean
	): Promise<void> {
		const { db, logger, now } = this.opts;
		const attrs = { task_id: task.task_id, worker: task.worker };
		if (db.receive(this.received(task), now()) === 'duplicate-done') {
			logger.info('task already finished here; not running it again', attrs);
			return;
		}
		if (this.opts.isBuiltin?.(task.worker) || !this.opts.repeatReporter) {
			// Built-in read worker results aren't stored — repeating leaves nothing
			const message = this.opts.isBuiltin?.(task.worker)
				? 'the built-in results reader does not repeat — create a single task for each read'
				: 'this 3minapi CLI cannot run repeating tasks here';
			logger.warn('repeating task rejected', attrs);
			return this.terminal(task, reporter, this.failedReplies('invalid_input', message));
		}
		this.repeatAcks++;
		let r: SendResult = 'skip';
		try {
			if (ack) r = await this.send(task, reporter, { status: 'working' });
		} finally {
			this.releaseSlot(() => this.repeatAcks--);
		}
		if (r === 'ok') db.markAcked(task.task_id, now());
		if (r === 'stop') return this.finish(task, 'cancelled', 'stopped before it started');
		if (r === 'drop')
			return this.finish(task, 'superseded', 'the server no longer accepts this task');
		if (r === 'retry' || r === 'too_large') {
			// Same as one-shot — only the response may have been lost. If truly missed, it returns after lease expiry and the lease is swapped here
			logger.warn(
				'could not confirm the acknowledgement; running the repeating task anyway',
				attrs
			);
		}
		if (this.scheduler.has(task.task_id)) {
			logger.info('repeating task delivered again; continuing with the new lease', attrs);
			return;
		}
		const every = task.repeat!.max_runs === undefined ? '' : `, ${task.repeat!.max_runs} runs`;
		logger.info('repeating task accepted', {
			...attrs,
			interval_seconds: task.repeat!.interval_seconds,
			max_runs: task.repeat!.max_runs ?? null
		});
		this.event(
			`${task.worker}  ${shortId(task.task_id)}  repeating every ${task.repeat!.interval_seconds}s${every}`
		);
		const row = db.getTask(task.task_id);
		this.scheduler.add(
			task.task_id,
			task.worker,
			task.repeat!,
			Math.max(row?.run_no ?? 0, row?.runs ?? 0)
		);
	}

	/** One run — called by the scheduler. Never throws */
	private async runRepeat(taskId: string, runNo: number): Promise<void> {
		const { executor, db, logger, now } = this.opts;
		const row = db.getTask(taskId);
		const task =
			row && (row.state === 'received' || row.state === 'running')
				? this.repeatEnvelope(row)
				: null;
		if (!row || !task) {
			this.scheduler.remove(taskId);
			return;
		}
		let release!: () => void;
		const entry: Inflight = { leaseId: task.lease_id, done: new Promise((r) => (release = r)) };
		this.inflight.set(taskId, entry);
		try {
			let startedAt = null as number | null;
			const outcome = await executor.run(
				{ id: taskId, worker: task.worker, input: task.input, run: runNo },
				{
					onStart: () => {
						startedAt = now();
						db.startRun(taskId, runNo, startedAt);
						logger.info('repeat run started', {
							task_id: taskId,
							worker: task.worker,
							run_no: runNo
						});
					},
					onReport: async (message) => {
						const r = await this.send(
							this.withCurrentLease(task),
							this.opts.repeatReporter!,
							{ status: 'working', status_message: clip(message, STATUS_MESSAGE_MAX_CHARS) },
							false,
							runNo
						);
						if (r === 'drop') executor.cancel(taskId, CANCEL.superseded);
					}
				}
			);
			const ms = startedAt === null ? 0 : now() - startedAt;
			const current = db.getTask(taskId) ?? row;
			await this.concludeRun(
				this.withCurrentLease(task, current),
				runNo,
				tallyOf(current),
				outcome,
				ms,
				startedAt !== null
			);
		} catch (err) {
			logger.error('repeat run failed', {
				task_id: taskId,
				run_no: runNo,
				message: (err as Error)?.stack ?? String(err)
			});
		} finally {
			this.releaseSlot(() => {
				if (this.inflight.get(taskId) === entry) this.inflight.delete(taskId);
			});
			release();
		}
	}

	/** Returns a slot — notifies (onSlotFree) when it frees up after being full */
	private releaseSlot(release: () => void): void {
		const wasFull = this.free === 0;
		release();
		if (wasFull && this.free > 0) this.opts.onSlotFree?.();
	}

	private async concludeRun(
		task: TaskEnvelope,
		runNo: number,
		tally: RunTally,
		outcome: Outcome,
		ms: number,
		/** The runner put it in a slot — a run cut while queued never ran */
		started: boolean
	): Promise<void> {
		const { logger } = this.opts;
		const attrs = { task_id: task.task_id, worker: task.worker, run_no: runNo, duration_ms: ms };
		// Closed meanwhile (server cancel, worker deletion, 409) — nothing to record
		if (!this.scheduler.has(task.task_id)) return;

		if (outcome.status === 'cancelled') {
			if (outcome.reason === CANCEL.server || outcome.reason === CANCEL.superseded) {
				this.scheduler.remove(task.task_id);
				logger.info('repeating task closed', { ...attrs, reason: outcome.reason });
				return this.finish(
					task,
					'cancelled',
					outcome.reason === CANCEL.superseded
						? 'the server no longer accepts this task'
						: undefined
				);
			}
			// User stop or stop code — a run still waiting for a slot never ran, so nothing is recorded (counting it would falsely fill
			// the consecutive-failure limit). The next start reuses the run number (run_no is recorded only on start)
			if (!started) {
				logger.info(
					'queued repeat run dropped; the repeating task resumes on the next start',
					attrs
				);
				return;
			}
			// Only the running run was cut. Record it as a failed run with no reply (the next start resumes)
			const message = outcome.reason.startsWith(STOPPED_PREFIX)
				? `the run was aborted because calls are ${outcome.reason}`
				: "the 3minapi CLI on the user's PC stopped during this run";
			logger.info('repeat run aborted; the repeating task resumes on the next start', attrs);
			return this.recordRun(task, runNo, tally, {
				ok: false,
				reason: 'host_stopped',
				message,
				payload: JSON.stringify(failedBody('host_stopped', message).error),
				report: false,
				close: false
			});
		}

		if (outcome.status === 'completed') {
			const shape = this.opts.results ? computeShape(JSON.parse(outcome.resultJson)) : null;
			logger.info('repeat run completed', attrs);
			return this.recordRun(task, runNo, tally, {
				ok: true,
				payload: outcome.resultJson,
				shape,
				report: true,
				close: true
			});
		}

		logger.warn('repeat run failed', {
			...attrs,
			reason: outcome.reason,
			message: outcome.message
		});
		return this.recordRun(task, runNo, tally, {
			ok: false,
			reason: outcome.reason,
			message: outcome.message,
			// Store the message before redaction and truncation (executor.ts detail)
			payload: JSON.stringify(failedBody(outcome.reason, outcome.detail ?? outcome.message).error),
			report: true,
			close: true
		});
	}

	/**
	 * End of a run — one data.db row, progress record, then the report (1 progress call or the final reply). report=false
	 * skips progress (stop, restart — the next run's report carries cumulative values). close=false doesn't close even if the end condition is met (stopping — no reply)
	 */
	private async recordRun(
		task: TaskEnvelope,
		runNo: number,
		tally: RunTally,
		run:
			| {
					ok: true;
					payload: string;
					shape: { shape: Shape; hash: string } | null;
					report: boolean;
					close: boolean;
			  }
			| {
					ok: false;
					reason: FailureReason;
					message: string;
					payload: string;
					report: boolean;
					close: boolean;
			  }
	): Promise<void> {
		const { db, logger, now } = this.opts;
		this.store(
			task,
			run.ok ? 'completed' : 'failed',
			run.payload,
			run.ok ? run.shape : null,
			runNo
		);
		const next: RunTally = {
			runs: tally.runs + 1,
			failed: tally.failed + (run.ok ? 0 : 1),
			streak: run.ok ? 0 : tally.streak + 1
		};
		const lastRunAt = now();
		db.recordRun(task.task_id, {
			runs: next.runs,
			failed: next.failed,
			failStreak: next.streak,
			lastRunAt
		});
		const settings = task.repeat!;
		const of = settings.max_runs === undefined ? '' : ` of ${settings.max_runs}`;
		this.event(
			run.ok
				? `${task.worker}  ${shortId(task.task_id)}  run ${runNo}${of} completed`
				: `${task.worker}  ${shortId(task.task_id)}  run ${runNo}${of} failed (${run.reason}): ${clip(run.message, EVENT_MESSAGE_MAX_CHARS)}`
		);
		// A run cut by a stop doesn't close the repeat (no reply) — the next start's recover decides
		if (!run.close) return;
		if (await this.closeIfDone(task, next, lastRunAt, run.ok ? null : run.message)) return;
		if (!run.report) return;

		const progress: RepeatProgress = {
			runs: next.runs,
			failed: next.failed,
			last_run_at: new Date(lastRunAt).toISOString()
		};
		const r = await this.send(
			task,
			this.opts.repeatReporter ?? null,
			{
				status: 'working',
				status_message: clip(
					run.ok ? `Run ${runNo}${of} completed.` : `Run ${runNo}${of} failed: ${run.message}`,
					STATUS_MESSAGE_MAX_CHARS
				),
				repeat: progress
			},
			true,
			runNo
		);
		if (r === 'ok') {
			// If the ack response was lost, this shows the ack arrived — the server accepting a report means it recorded the ack.
			// Otherwise restart cleanup would close this repeat as "not acked" while the server never resends it (docs/design/14_cli_host.md §4)
			if (this.opts.db.getTask(task.task_id)?.acked_at == null) {
				this.opts.db.markAcked(task.task_id, this.opts.now());
			}
		} else if (r === 'drop') {
			// Already finished on the server (cancelled, expired, worker deleted) — close locally only
			this.scheduler.remove(task.task_id);
			this.event(`${task.worker}  ${shortId(task.task_id)}  repeat ended on the server`);
			this.finish(task, 'cancelled', 'the server no longer accepts this task');
		} else if (r === 'retry') {
			// Not resent — the next run's report carries cumulative values
			logger.warn('repeat report not delivered; the next run reports the totals', {
				task_id: task.task_id,
				run_no: runNo
			});
		}
	}

	/**
	 * End condition — failed (repeat_failed) when consecutive failures hit the limit, completed (summary) at `max_runs`. true if closed.
	 * The final reply takes the same path as one-shot (including the resend queue)
	 */
	private async closeIfDone(
		task: TaskEnvelope,
		tally: RunTally,
		lastRunAt: number,
		lastMessage: string | null
	): Promise<boolean> {
		const { db, logger } = this.opts;
		const settings = task.repeat!;
		const progress: RepeatProgress = {
			runs: tally.runs,
			failed: tally.failed,
			last_run_at: new Date(lastRunAt).toISOString()
		};
		const reporter = this.opts.repeatReporter ?? null;
		if (tally.streak >= REPEAT_FAIL_STREAK_MAX) {
			this.scheduler.remove(task.task_id);
			logger.warn('repeating task failed; too many runs failed in a row', {
				task_id: task.task_id,
				runs: tally.runs,
				failed: tally.failed
			});
			this.event(
				`${task.worker}  ${shortId(task.task_id)}  repeat failed: ${REPEAT_FAIL_STREAK_MAX} runs in a row failed`
			);
			const message =
				`${REPEAT_FAIL_STREAK_MAX} runs in a row failed` +
				(lastMessage ? `; the last one: ${lastMessage}` : '');
			const body = failedBody('repeat_failed', message);
			body.error.data = { reason: 'repeat_failed', runs: tally.runs, failed: tally.failed };
			await this.terminal(task, reporter, [
				{ body: { ...body, repeat: progress }, state: 'failed', reply: 'failed', error: message }
			]);
			return true;
		}
		if (settings.max_runs !== undefined && tally.runs >= settings.max_runs) {
			this.scheduler.remove(task.task_id);
			logger.info('repeating task completed', {
				task_id: task.task_id,
				runs: tally.runs,
				failed: tally.failed
			});
			this.event(
				`${task.worker}  ${shortId(task.task_id)}  repeat completed (${tally.runs} runs, ${tally.failed} failed)`
			);
			const firstRunAt = db.getTask(task.task_id)?.started_at ?? lastRunAt;
			await this.terminal(task, reporter, [
				{
					body: {
						status: 'completed',
						status_message: `All ${tally.runs} runs finished; ${tally.failed} failed.`,
						result: {
							runs: tally.runs,
							failed: tally.failed,
							first_run_at: new Date(firstRunAt).toISOString(),
							last_run_at: progress.last_run_at
						},
						repeat: progress
					},
					state: 'completed',
					reply: 'result'
				}
			]);
			return true;
		}
		return false;
	}

	/** Builds a run's envelope from the control DB row — lease and reply address read from the row each time (redelivery changes them). null if unreadable */
	private repeatEnvelope(row: TaskRow): TaskEnvelope | null {
		const repeat = parseSettings(row.repeat);
		let input: unknown = null;
		try {
			input = JSON.parse(row.input_json ?? 'null');
		} catch {
			// Broken input — closed below
		}
		if (!repeat || row.input_json == null || !row.lease_id) {
			this.opts.logger.warn('closing a repeating task that cannot be resumed', {
				task_id: row.task_id
			});
			this.scheduler.remove(row.task_id);
			this.opts.db.markFinished(
				row.task_id,
				'failed',
				this.opts.now(),
				'its saved settings could not be read'
			);
			return null;
		}
		return {
			task_id: row.task_id,
			worker: row.worker,
			input,
			callback_url: row.callback_url ?? null,
			lease_id: row.lease_id,
			delivery_attempt: row.delivery_attempt,
			source: 'pull',
			repeat
		};
	}

	/** Redelivery may have changed the lease mid-run — report with the row's current lease */
	private withCurrentLease(
		task: TaskEnvelope,
		row = this.opts.db.getTask(task.task_id)
	): TaskEnvelope {
		if (!row?.lease_id || row.lease_id === task.lease_id) return task;
		return { ...task, lease_id: row.lease_id, callback_url: row.callback_url ?? task.callback_url };
	}

	private workerOf(taskId: string): string {
		return this.opts.db.getTask(taskId)?.worker ?? '';
	}

	private finish(task: TaskEnvelope, state: TerminalState, error?: string): void {
		this.opts.db.markFinished(task.task_id, state, this.opts.now(), error);
	}

	private received(task: TaskEnvelope) {
		return {
			task_id: task.task_id,
			worker: task.worker,
			lease_id: task.lease_id ?? '',
			delivery_attempt: task.delivery_attempt,
			callback_url: task.callback_url,
			...(task.repeat ? { repeat: task.repeat, input: task.input } : {})
		};
	}

	/** Goes to the terminal — worker names and failure messages are external values (may echo remote AI input), so control characters are stripped (#1410) */
	private event(line: string): void {
		this.opts.onEvent?.(stripControl(line));
	}
}

export function failedBody(
	reason: FailureReason,
	message: string
): ReportBody & { error: NonNullable<ReportBody['error']> } {
	return {
		status: 'failed',
		status_message: clip(message, STATUS_MESSAGE_MAX_CHARS),
		error: { code: TASK_ERROR_CODE, message, data: { reason } }
	};
}

/** data.db failed payload (reply error JSON) — null if the shape doesn't match */
function parseStoredError(payload: string): { reason: FailureReason; message: string } | null {
	try {
		const error = JSON.parse(payload) as { message?: unknown; data?: { reason?: unknown } };
		const reason = error?.data?.reason;
		if (typeof reason !== 'string' || typeof error.message !== 'string') return null;
		return {
			reason: reason as FailureReason,
			message: truncate(error.message, ERROR_MESSAGE_MAX_CHARS)
		};
	} catch {
		return null;
	}
}

/** Reserved keys at the top level of a result — indistinguishable from a substitute result */
function isReserved(value: unknown): boolean {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.hasOwn(value, RESULT_RESERVED_KEY)
	);
}

/** Folds to one line and truncates */
function clip(message: string, max: number): string {
	return truncate(oneLine(message), max);
}

function shortId(id: string): string {
	return id.length > 13 ? id.slice(-12) : id;
}

function tallyOf(row: TaskRow): RunTally {
	return { runs: row.runs ?? 0, failed: row.failed ?? 0, streak: row.fail_streak ?? 0 };
}
