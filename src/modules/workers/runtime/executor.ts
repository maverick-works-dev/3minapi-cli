/**
 * Worker executor — for each task, imports the worker file in a fresh `worker_threads` thread and calls its handler
 * (docs/design/15_cli.md §3).
 *
 * - Latest code without restart: each thread gets a fresh module cache
 * - Isolation: a throw, infinite loop or process.exit in worker code cannot kill the CLI process
 * - Timeouts and cancels are enforced with terminate(). Cancel aborts ctx.signal first, then terminates after
 *   CANCEL_GRACE_MS
 * - Tasks over the concurrency limit wait in order
 *
 * ⚠️ terminate() only stops JS execution. A thread blocked in a native addon, execSync or a hung synchronous fs
 * call cannot be stopped — the result (failed) and the slot are still returned immediately, with a warning.
 */
import { getDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { Worker } from 'node:worker_threads';
import type { Readable } from 'node:stream';
import {
	CANCEL_GRACE_MS,
	DEFAULT_WORKER_TIMEOUT_MS,
	ERROR_MESSAGE_MAX_CHARS,
	STORED_ERROR_MAX_CHARS,
	TERMINATE_WAIT_MS,
	WORKER_TIMEOUT_MAX_MS,
	type LogLevel
} from '../../../core/domain/index.ts';
import { redactAndTruncate } from '../../../core/redact.ts';
import type { BuiltinRun } from '../builtin/results-worker.ts';
import { errorMessage, errorStack, withoutHome } from './error-chain.ts';
import type { FailureReason, FromThread, ThreadInput, ToThread } from './protocol.ts';
import { resolveWorkerFile } from './resolve.ts';

/** Finds the thread file in the same folder, from both the build (dist/*.js) and source (src/*.ts) */
export const THREAD_URL = new URL(
	import.meta.url.endsWith('.ts') ? './thread.ts' : './thread.js',
	import.meta.url
);

export interface Job {
	id: string;
	worker: string;
	input: unknown;
	/** Run number of a repeating task — logged as `run_no` so the dashboard can filter by run */
	run?: number;
}

export interface RunHooks {
	/** ctx.report(msg) — resolves once sent. Must not reject, even on failure */
	onReport?(message: string): Promise<void>;
	/** One line of ctx.log or console output */
	onLog?(message: string, level: LogLevel): void;
	/**
	 * When the task gets a slot and actually starts (including when taken from the queue). Not called if it ends
	 * before a slot (no worker, .env failure, stop). A throw does not stop execution. (#1417)
	 */
	onStart?(): void;
}

export type Outcome =
	| { status: 'completed'; resultJson: string }
	/** message = for the reply (redacted, 4,000 chars), detail = for data.db (redacted, not truncated) */
	| { status: 'failed'; reason: FailureReason; message: string; detail?: string }
	| { status: 'cancelled'; reason: string };

export interface ExecutorLogger {
	worker(name: string, level: LogLevel, body: string, attributes?: Record<string, unknown>): void;
	warn(body: string, attributes?: Record<string, unknown>): void;
}

export interface ExecutorOptions {
	workersDir: string;
	concurrency: number;
	/**
	 * The worker thread's full process.env (workerEnv in env.ts). A function is called **per task**, so `.env` edits
	 * apply from the next task without a restart, like code
	 */
	env: WorkerEnv | (() => WorkerEnv);
	logger?: ExecutorLogger;
	/**
	 * Built-in workers — on a name match this is called instead of a worker file; slots, cancel and stop work as for
	 * file workers. A function because built-in names are known only after the startup sync
	 */
	builtin?(worker: string): BuiltinRun | null;
	/** Shortened by tests */
	cancelGraceMs?: number;
	terminateWaitMs?: number;
}

type WorkerEnv = Record<string, string | undefined>;

interface Active {
	cancel(reason: string): void;
	kill(reason: string): void;
}

interface Queued {
	job: Job;
	hooks: RunHooks;
	resolve(outcome: Outcome): void;
}

export class Executor {
	private readonly opts: ExecutorOptions;
	private readonly active = new Map<string, Active>();
	private readonly queue: Queued[] = [];
	private readonly stopping = new Set<Promise<unknown>>();
	private halted: string | null = null;

	constructor(opts: ExecutorOptions) {
		this.opts = opts;
	}

	/** Running + queued */
	get size(): number {
		return this.active.size + this.queue.length;
	}

	/** Concurrency limit */
	get concurrency(): number {
		return this.opts.concurrency;
	}

	/** How many more tasks can be accepted now */
	get free(): number {
		return Math.max(0, this.opts.concurrency - this.size);
	}

	has(id: string): boolean {
		return this.active.has(id) || this.queue.some((q) => q.job.id === id);
	}

	run(job: Job, hooks: RunHooks = {}): Promise<Outcome> {
		return new Promise<Outcome>((resolve) => {
			if (this.halted !== null) return resolve({ status: 'cancelled', reason: this.halted });
			const entry = { job, hooks, resolve };
			if (this.active.size < this.opts.concurrency) this.start(entry);
			else this.queue.push(entry);
		});
	}

	/** Cancel — aborts ctx.signal, terminates after the grace period. False for an unknown id */
	cancel(id: string, reason = 'cancelled'): boolean {
		const i = this.queue.findIndex((q) => q.job.id === id);
		if (i !== -1) {
			const [q] = this.queue.splice(i, 1);
			q.resolve({ status: 'cancelled', reason });
			return true;
		}
		const a = this.active.get(id);
		if (!a) return false;
		a.cancel(reason);
		return true;
	}

	/** Cancel everything (with grace) and wait until done — Ctrl+C, stop */
	async cancelAll(reason: string): Promise<void> {
		this.halted ??= reason;
		this.drainQueue(reason);
		for (const a of [...this.active.values()]) a.cancel(reason);
		await this.idle();
	}

	/** Terminate everything immediately (no grace) — on a stop code. Later run() calls are cancelled at once */
	async haltAll(reason: string): Promise<void> {
		this.halted ??= reason;
		this.drainQueue(reason);
		for (const a of [...this.active.values()]) a.kill(reason);
		await this.idle();
	}

	/** Until running tasks and terminating threads have all finished */
	async idle(): Promise<void> {
		while (this.active.size > 0 || this.queue.length > 0 || this.stopping.size > 0) {
			await Promise.race([new Promise((r) => setTimeout(r, 20)), ...this.stopping]);
		}
	}

	private drainQueue(reason: string): void {
		for (const q of this.queue.splice(0)) q.resolve({ status: 'cancelled', reason });
	}

	private next(): void {
		while (
			this.halted === null &&
			this.queue.length > 0 &&
			this.active.size < this.opts.concurrency
		) {
			this.start(this.queue.shift()!);
		}
	}

	private start({ job, hooks, resolve }: Queued): void {
		const builtin = this.opts.builtin?.(job.worker) ?? null;
		if (builtin) {
			this.started(job, hooks);
			return this.startBuiltin(job, builtin, resolve);
		}

		const found = resolveWorkerFile(this.opts.workersDir, job.worker);
		if (!found.ok) {
			resolve({ status: 'failed', reason: found.reason, message: found.message });
			return;
		}

		const log = (message: string, level: LogLevel) => {
			hooks.onLog?.(message, level);
			this.opts.logger?.worker(job.worker, level, message, {
				task_id: job.id,
				...(job.run !== undefined ? { run_no: job.run } : {})
			});
		};

		let env: WorkerEnv;
		try {
			env = typeof this.opts.env === 'function' ? this.opts.env() : this.opts.env;
		} catch (err) {
			// .env could not be read (permissions etc.) — report why instead of running
			resolve({ status: 'failed', reason: 'invalid_worker', message: (err as Error).message });
			return;
		}

		const workerData: ThreadInput = {
			file: found.file,
			input: job.input,
			// With execArgv: [] the thread does not inherit the parent's net defaults
			connectAttemptTimeoutMs: getDefaultAutoSelectFamilyAttemptTimeout()
		};
		this.started(job, hooks);
		const thread = new Worker(THREAD_URL, {
			workerData,
			env,
			// Do not pass on the parent's runtime flags or loader hooks (--import etc.)
			execArgv: [],
			stdout: true,
			stderr: true,
			name: `3minapi:${job.worker}`
		});
		pipeLines(thread.stdout, (line) => log(line, 'info'));
		pipeLines(thread.stderr, (line) => log(line, 'warn'));

		const startedAt = Date.now();
		let settled = false;
		let cancelReason: string | null = null;
		let timer: NodeJS.Timeout | undefined;
		let grace: NodeJS.Timeout | undefined;

		const settle = (outcome: Outcome) => {
			if (settled) return;
			settled = true;
			// Failure messages go to the server and terminal — redacted and truncated. Stacks stay in the local worker
			// log only. data.db stores the redacted, untruncated message (docs/design/15_cli.md §8-5)
			if (outcome.status === 'failed') {
				outcome = {
					...outcome,
					message: redactAndTruncate(outcome.message, ERROR_MESSAGE_MAX_CHARS),
					detail: redactAndTruncate(outcome.message, STORED_ERROR_MAX_CHARS)
				};
			}
			clearTimeout(timer);
			clearTimeout(grace);
			this.active.delete(job.id);
			this.stopThread(thread, job);
			resolve(cancelReason !== null ? { status: 'cancelled', reason: cancelReason } : outcome);
			this.next();
		};
		const arm = (ms: number) => {
			clearTimeout(timer);
			timer = setTimeout(
				() =>
					settle({
						status: 'failed',
						reason: 'timeout',
						message: `did not finish within ${ms} ms`
					}),
				Math.max(0, ms - (Date.now() - startedAt))
			);
		};
		arm(DEFAULT_WORKER_TIMEOUT_MS);

		thread.on('message', (msg: FromThread) => {
			switch (msg.type) {
				case 'loaded':
					if (msg.timeoutMs !== null) arm(Math.min(msg.timeoutMs, WORKER_TIMEOUT_MAX_MS));
					return;
				case 'log':
					log(msg.message, 'info');
					return;
				case 'report': {
					const ack = () => {
						if (!settled) post(thread, { type: 'report-ack', id: msg.id });
					};
					Promise.resolve(hooks.onReport?.(msg.message)).then(ack, ack);
					return;
				}
				// Size is not checked here — the result is saved and the reply decides (substitute or failed, task-runner.ts)
				case 'done':
					return settle({ status: 'completed', resultJson: msg.json });
				case 'fail':
					if (msg.stack) log(msg.stack, 'error');
					return settle({ status: 'failed', reason: msg.reason, message: msg.message });
			}
		});
		// Uncaught exceptions outside the handler (timer callbacks etc.)
		thread.on('error', (err) => {
			const stack = errorStack(err);
			if (stack) log(stack, 'error');
			settle({
				status: 'failed',
				reason: 'handler_error',
				message: `uncaught error: ${withoutHome(errorMessage(err), homedir())}`
			});
		});
		thread.on('exit', (code) =>
			settle({
				status: 'failed',
				reason: 'handler_error',
				message: `the worker exited before returning a result (exit code ${code})`
			})
		);

		this.active.set(job.id, {
			cancel: (reason) => {
				if (settled || cancelReason !== null) return;
				cancelReason = reason;
				post(thread, { type: 'cancel' });
				grace = setTimeout(
					() => settle({ status: 'cancelled', reason }),
					this.opts.cancelGraceMs ?? CANCEL_GRACE_MS
				);
			},
			kill: (reason) => {
				cancelReason ??= reason;
				settle({ status: 'cancelled', reason });
			}
		});
	}

	/** onStart — also called from another task's settle → next(), so throws are swallowed here */
	private started(job: Job, hooks: RunHooks): void {
		try {
			hooks.onStart?.();
		} catch (err) {
			this.opts.logger?.warn('task start hook failed', {
				task_id: job.id,
				message: (err as Error)?.message ?? String(err)
			});
		}
	}

	/** Built-in worker — called in the parent without a thread (heavy work goes to a child process). Cancel is the signal only */
	private startBuiltin(job: Job, run: BuiltinRun, resolve: (outcome: Outcome) => void): void {
		const controller = new AbortController();
		let settled = false;
		let cancelReason: string | null = null;
		const settle = (outcome: Outcome) => {
			if (settled) return;
			settled = true;
			if (outcome.status === 'failed') {
				outcome = {
					...outcome,
					message: redactAndTruncate(outcome.message, ERROR_MESSAGE_MAX_CHARS),
					detail: redactAndTruncate(outcome.message, STORED_ERROR_MAX_CHARS)
				};
			}
			this.active.delete(job.id);
			resolve(cancelReason !== null ? { status: 'cancelled', reason: cancelReason } : outcome);
			this.next();
		};
		const stop = (reason: string) => {
			if (settled) return;
			cancelReason ??= reason;
			controller.abort();
			settle({ status: 'cancelled', reason });
		};
		this.active.set(job.id, { cancel: stop, kill: stop });
		run(job.input, controller.signal).then(settle, (err: unknown) =>
			settle({
				status: 'failed',
				reason: 'handler_error',
				message: `the built-in worker failed: ${(err as Error)?.message ?? String(err)}`
			})
		);
	}

	private stopThread(thread: Worker, job: Job): void {
		const wait = this.opts.terminateWaitMs ?? TERMINATE_WAIT_MS;
		let timeout: NodeJS.Timeout | undefined;
		const done = Promise.race([
			thread.terminate().then(() => true),
			new Promise<boolean>((r) => {
				timeout = setTimeout(() => r(false), wait);
			})
		]).then((stopped) => {
			clearTimeout(timeout);
			if (!stopped) {
				this.opts.logger?.warn(
					'worker thread did not stop; it may be blocked in native or synchronous code',
					{
						worker: job.worker,
						task_id: job.id
					}
				);
			}
		});
		this.stopping.add(done);
		void done.finally(() => this.stopping.delete(done));
	}
}

function post(thread: Worker, msg: ToThread): void {
	try {
		thread.postMessage(msg);
	} catch {
		// Thread already exited
	}
}

function pipeLines(stream: Readable | null, onLine: (line: string) => void): void {
	if (!stream) return;
	createInterface({ input: stream, crlfDelay: Infinity }).on('line', onLine);
}
