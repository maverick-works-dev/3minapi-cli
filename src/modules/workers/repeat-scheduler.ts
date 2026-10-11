/**
 * Repeat task scheduler (docs/design/15_cli.md §8-7) — decides only when to enqueue a run. Execution, reporting
 * and completion belong to TaskRunner.
 *
 * - **One tick.** Every second (REPEAT_TICK_MS) it checks repeats whose due time has passed. One timer regardless of
 *   how many repeats; nothing re-arms a timer per due time. `unref()` keeps it from holding `start` open
 * - **Fixed interval.** next due = previous due + interval, so run time doesn't push it later. If that time has also
 *   passed (restart, sleep), missed runs are not replayed; the interval continues from now
 * - **Skip.** If the previous run hasn't finished (queued, running or reporting), this run is skipped — no run
 *   number is used, only a log line. A repeat runs at most one run at a time
 * - Due times are stored in the control DB (`next_at`) so the next `start` continues them (`load`)
 */
import type { ControlDb } from '../../core/control-db.ts';
import {
	REPEAT_INTERVAL_MAX_S,
	REPEAT_INTERVAL_MIN_S,
	REPEAT_TICK_MS,
	type RepeatSettings
} from '../../core/domain/index.ts';
import type { Logger } from '../../core/logger.ts';

export interface RepeatEntry {
	taskId: string;
	worker: string;
	intervalMs: number;
	/** Last enqueued run */
	runNo: number;
	nextAt: number;
	/** A run is still in progress (through reporting) */
	busy: boolean;
}

export interface RepeatSchedulerOptions {
	db: ControlDb;
	logger: Logger;
	now(): number;
	/** One run — a Promise that settles when execution, storage and reporting finish. Never throws */
	run(taskId: string, runNo: number): Promise<void>;
	/** Registers the tick — replaced in tests. Defaults to an unref'd setInterval */
	every?(fn: () => void, ms: number): { clear(): void };
}

export class RepeatScheduler {
	private readonly opts: RepeatSchedulerOptions;
	private readonly entries = new Map<string, RepeatEntry>();
	private timer: { clear(): void } | null = null;
	private stopped = false;
	private loaded = false;

	constructor(opts: RepeatSchedulerOptions) {
		this.opts = opts;
	}

	has(taskId: string): boolean {
		return this.entries.has(taskId);
	}

	get size(): number {
		return this.entries.size;
	}

	/**
	 * An acked repeat — enqueues the next run immediately. `doneRuns` = run numbers already used (a repeat redelivered after a restart keeps counting)
	 */
	add(taskId: string, worker: string, settings: RepeatSettings, doneRuns = 0): void {
		if (this.stopped || this.entries.has(taskId)) return;
		const entry: RepeatEntry = {
			taskId,
			worker,
			intervalMs: settings.interval_seconds * 1000,
			runNo: doneRuns,
			nextAt: this.opts.now(),
			busy: false
		};
		this.entries.set(taskId, entry);
		this.ensureTimer();
		this.due(entry, this.opts.now());
	}

	/**
	 * Resumes repeats left by the previous run — once, **after the first successful pull** following a restart (that
	 * pull's cancelled[] applies first). If the due time has passed, runs once now and continues the interval from now
	 * (the phase from while it was off is dropped)
	 */
	load(): void {
		if (this.stopped || this.loaded) return;
		this.loaded = true;
		const now = this.opts.now();
		for (const row of this.opts.db.repeatTasks()) {
			if (this.entries.has(row.task_id)) continue;
			const settings = parseSettings(row.repeat);
			if (!settings) {
				this.opts.logger.warn('ignored a repeating task with unreadable settings', {
					task_id: row.task_id
				});
				continue;
			}
			this.entries.set(row.task_id, {
				taskId: row.task_id,
				worker: row.worker,
				intervalMs: settings.interval_seconds * 1000,
				// A run cut off before starting is counted only in runs, without run_no — take the larger so no number is reused
				runNo: Math.max(row.run_no ?? 0, row.runs ?? 0),
				// Pull an overdue time to now — run once now, next at now + interval (docs/design/15_cli.md §8-7)
				nextAt: row.next_at == null || row.next_at < now ? now : row.next_at,
				busy: false
			});
		}
		if (this.entries.size > 0) {
			this.ensureTimer();
			this.tick();
		}
	}

	/** Removes it from the schedule — the repeat ended (completed, failed, cancelled, worker deleted) */
	remove(taskId: string): void {
		this.entries.delete(taskId);
	}

	/** Removes those workers' repeats and returns their task_ids — the workers were deleted on the server */
	dropWorkers(names: readonly string[]): string[] {
		const gone = new Set(names);
		const ids: string[] = [];
		for (const e of this.entries.values()) {
			if (gone.has(e.worker)) ids.push(e.taskId);
		}
		for (const id of ids) this.entries.delete(id);
		return ids;
	}

	/** Stops enqueuing — user stop or stop code. Entries stay (the in-flight run records its end) */
	stop(): void {
		this.stopped = true;
		this.timer?.clear();
		this.timer = null;
	}

	snapshot(): RepeatEntry[] {
		return [...this.entries.values()].map((e) => ({ ...e }));
	}

	/** For each repeat past its due time */
	tick(): void {
		if (this.stopped) return;
		const now = this.opts.now();
		for (const entry of [...this.entries.values()]) {
			if (entry.nextAt <= now) this.due(entry, now);
		}
	}

	private due(entry: RepeatEntry, now: number): void {
		let next = entry.nextAt + entry.intervalMs;
		if (next <= now) next = now + entry.intervalMs;
		entry.nextAt = next;
		this.persistNextAt(entry);
		if (entry.busy) {
			this.opts.logger.info('repeat run skipped; the previous run has not finished', {
				task_id: entry.taskId,
				worker: entry.worker,
				run_no: entry.runNo
			});
			return;
		}
		entry.busy = true;
		entry.runNo += 1;
		void this.opts
			.run(entry.taskId, entry.runNo)
			.catch((err: unknown) => {
				this.opts.logger.error('repeat run failed to start', {
					task_id: entry.taskId,
					message: (err as Error)?.stack ?? String(err)
				});
			})
			.finally(() => {
				entry.busy = false;
			});
	}

	private persistNextAt(entry: RepeatEntry): void {
		try {
			this.opts.db.setNextAt(entry.taskId, entry.nextAt);
		} catch (err) {
			// The next `start` just resumes slightly early or late
			this.opts.logger.warn('could not record the next run time', {
				task_id: entry.taskId,
				message: (err as Error).message
			});
		}
	}

	private ensureTimer(): void {
		if (this.timer || this.stopped) return;
		const every =
			this.opts.every ??
			((fn: () => void, ms: number) => {
				const t = setInterval(fn, ms);
				t.unref();
				return { clear: () => clearInterval(t) };
			});
		this.timer = every(() => this.tick(), REPEAT_TICK_MS);
	}
}

/** The control DB's `repeat` JSON — null if the shape doesn't match */
export function parseSettings(json: string | null | undefined): RepeatSettings | null {
	if (!json) return null;
	try {
		return checkRepeat(JSON.parse(json));
	} catch {
		return null;
	}
}

/**
 * Repeat settings within the contract, or null — the interval is a whole number of seconds in
 * [REPEAT_INTERVAL_MIN_S, REPEAT_INTERVAL_MAX_S] and `max_runs`, if present, a positive integer. Applied to what the server
 * sends, so a bad value can't run a worker every tick (docs/design/17_cli_security_review.md S9).
 */
export function checkRepeat(value: unknown): RepeatSettings | null {
	if (typeof value !== 'object' || value === null) return null;
	const { interval_seconds: every, max_runs: max } = value as Record<string, unknown>;
	if (!Number.isInteger(every)) return null;
	const seconds = every as number;
	if (seconds < REPEAT_INTERVAL_MIN_S || seconds > REPEAT_INTERVAL_MAX_S) return null;
	if (max !== undefined && !(Number.isSafeInteger(max) && (max as number) > 0)) return null;
	return { interval_seconds: seconds, ...(max === undefined ? {} : { max_runs: max as number }) };
}
