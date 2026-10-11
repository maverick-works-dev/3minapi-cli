/**
 * workers module — the `HostModule` attached to the host runtime (docs/design/15_cli.md §4, §8).
 *
 * Handles the workers part of a pull response: reconciling with the server list (server-side deletion,
 * docs/design/14_cli_host.md §10), cancellation and task execution. The workers part of `start` (initial sync,
 * local server) is in start.ts in this folder.
 */
import type { ApiClient } from '../../core/api.ts';
import {
	PULL_MAX_LIMIT,
	isPullWorkerName,
	type LiveTopic,
	type PullResponse,
	type StopCode
} from '../../core/domain/index.ts';
import type { HostModule, ModuleEnded } from '../../core/host/module.ts';
import type { Logger } from '../../core/logger.ts';
import { checkRepeat } from './repeat-scheduler.ts';
import type { TaskRunner } from './task-runner.ts';
import type { WorkerSet } from './worker-set.ts';

export interface WorkersModuleOptions {
	/** Client for acking and replying to pulled tasks */
	api: ApiClient;
	runner: TaskRunner;
	logger: Logger;
	/** Active workers for this run — received already synced (docs/design/14_cli_host.md §3-4) */
	workers: WorkerSet;
	/** Worker deactivated because it disappeared from the server list in a pull response */
	onWorkersDeleted?(names: string[]): void;
	/** Worker turned off by `worker delete` on the same PC */
	onWorkersDropped?(names: string[]): void;
	/** A worker left out of sync (load failure) was also missing from the first server list — it was never registered */
	onWorkersUnregistered?(names: string[]): void;
	/**
	 * Resync (`reload`, #1393). Throws StopError only for stop codes (full stop); reports and swallows any other
	 * failure (polling continues with the previous list)
	 */
	resync?(): Promise<void>;
}

export class WorkersModule implements HostModule {
	/** Task created, cancelled or re-rung (docs/design/14_cli_host.md §13-3) */
	readonly topics: readonly LiveTopic[] = ['workers'];
	private readonly opts: WorkersModuleOptions;
	private repeatsStarted = false;
	private slotFree: (() => void) | null = null;

	constructor(opts: WorkersModuleOptions) {
		this.opts = opts;
	}

	get activeCount(): number {
		return this.opts.workers.activeCount;
	}

	beforePull(): Promise<void> {
		return this.opts.runner.flushPending();
	}

	flushPending(): Promise<void> {
		return this.opts.runner.flushPending();
	}

	onSlotFree(cb: () => void): void {
		this.slotFree = cb;
	}

	/** Called by TaskRunner's onSlotFree — indirect because the runner is created before the module */
	notifySlotFree(): void {
		this.slotFree?.();
	}

	/**
	 * Takes only as many tasks as can run now — acks on receipt, and the server never redelivers an acked task
	 * (docs/design/14_cli_host.md §3-2). With no free slot, max is 0: no tasks, only cancellations (cancelled[]) of running ones (#1417)
	 */
	pullMax(): number {
		return Math.min(PULL_MAX_LIMIT, this.opts.runner.free);
	}

	onPull(res: PullResponse): void {
		const { api, runner, logger, workers } = this.opts;
		const { deleted, unregistered } = workers.applyServerList(res.workers.map((w) => w.name));
		if (unregistered.length > 0) {
			logger.warn('workers that could not load are not registered on the server', {
				workers: unregistered
			});
			this.opts.onWorkersUnregistered?.(unregistered);
		}
		if (deleted.length > 0) {
			logger.warn('workers deleted on the server; reload or restart start to register them again', {
				workers: deleted
			});
			this.opts.onWorkersDeleted?.(deleted);
			// The server dropped the deleted worker's repeats with it — remove them from the schedule (docs/design/14_cli_host.md §10)
			runner.dropRepeats(deleted);
		}
		for (const id of res.cancelled) runner.cancel(id);
		for (const t of res.tasks) {
			// The server only sends tasks whose names follow the rules. Drop a nonconforming name before it reaches the
			// control DB or a log path (guard against server misbehavior). No reply — the server closes it at its 24 h deadline.
			if (!isPullWorkerName(t.worker)) {
				logger.warn('ignored a task with an invalid worker name', {
					task_id: String(t.data?.task_id)
				});
				continue;
			}
			// Same guard for repeat settings outside the contract — they would set how often the worker runs
			// A missing or null `repeat` is a one-off task
			const repeat = t.data.repeat == null ? null : checkRepeat(t.data.repeat);
			if (t.data.repeat != null && repeat === null) {
				logger.warn('ignored a repeating task with invalid settings', {
					task_id: String(t.data?.task_id)
				});
				continue;
			}
			void runner.handle(
				{
					task_id: t.data.task_id,
					worker: t.worker,
					input: t.data.input,
					callback_url: t.data.callback_url,
					lease_id: t.lease_id,
					delivery_attempt: t.delivery_attempt,
					source: 'pull',
					...(repeat ? { repeat } : {})
				},
				api,
				{ ack: true }
			);
		}
		// Previous run's repeats resume after the first successful pull — cancellations made while offline (cancelled[] above) apply first (docs/design/15_cli.md §8-7)
		if (!this.repeatsStarted) {
			this.repeatsStarted = true;
			runner.startRepeats();
		}
	}

	dropLocal(names: string[]): void {
		const dropped = this.opts.workers.dropLocal(names);
		if (dropped.length === 0) return;
		this.opts.logger.info('workers deleted with worker delete; turned off', { workers: dropped });
		this.opts.onWorkersDropped?.(dropped);
		// The server dropped the repeats too — remove them from the schedule as with a server-side deletion
		this.opts.runner.dropRepeats(dropped);
	}

	async resync(): Promise<void> {
		await this.opts.resync?.();
	}

	halt(reason: StopCode): Promise<void> {
		return this.opts.runner.halt(reason);
	}

	async shutdown(): Promise<void> {
		await this.opts.runner.shutdown();
		// Send replies left after a user stop (host_stopped etc.) once more
		await this.opts.runner.flushPending();
	}

	ended(): ModuleEnded {
		return { ended: 'no_active_workers', deletedWorkers: this.opts.workers.deletedNames() };
	}
}
