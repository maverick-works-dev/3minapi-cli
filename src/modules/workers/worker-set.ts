/**
 * Workers this run can receive — docs/design/14_cli_host.md §3-4, §10.
 *
 *   active = push serving ∪ ((local files − sync rejections) ∩ latest server list)
 *
 * - Right after sync the server list equals "sent − rejected"; afterwards each pull's `workers` replaces it. A worker
 *   gone from the server does not come back until the next sync — pull workers are created only by CLI sync. Syncs
 *   happen at `start` and on `reload` (#1393)
 * - **Resync (`resync`) updates in place without replacing the object** — the poller and local server hold the same reference
 * - **A worker left out of sync (load failure) cannot be found on the server from the sync response.** If an earlier
 *   run registered it, it is on the server and therefore active — handler code is imported fresh per task, so a fix
 *   takes effect immediately. It stays active until the first server list (first pull) and is marked "not registered"
 *   if absent there. That is not a server-side deletion and is not counted as one
 * - **Push serving** — `--public` serves the same file under the push worker contract (docs/design/15_cli.md §8-4).
 *   That name exists on the server as a push worker, so sync rejects it with `worker_name_taken` (push). When the keys
 *   are set, this is treated as this PC serving it via push, not a rejection. It never appears in the pull list, so it
 *   is excluded from deletion detection
 * - **Built-in workers (#1398)** — local workers without a file (`_results_<host>`). Sync, server list and deletion
 *   detection work as for other local workers, but they are **not counted in `activeCount`**: the run ends when no
 *   file workers remain (docs/design/14_cli_host.md §10), and polling for built-ins alone would only spend quota
 */
import type { SyncRejected, SyncWorkersResponse } from '../../core/domain/index.ts';

export type InactiveReason = 'rejected' | 'not_on_server' | 'deleted_on_server';

export interface SyncContext {
	/** `start --serve --public` */
	public: boolean;
	/** Both THREEMINAPI_WORKER_<NAME>_SECRET and _KEY are set for that worker */
	hasPushKeys(name: string): boolean;
}

export class WorkerSet {
	private local: ReadonlySet<string>;
	private readonly rejected = new Map<string, SyncRejected>();
	private readonly pushServed = new Set<string>();
	private readonly deleted = new Set<string>();
	/** Names left out of sync — undecided until the first server list */
	private readonly unsent = new Set<string>();
	private serverSeen = false;
	private server = new Set<string>();

	/** This run's built-in worker name — only when included in sync */
	private builtinName: string | null;

	constructor(localNames: Iterable<string>, builtin: string | null = null) {
		this.local = new Set(localNames);
		this.builtinName = builtin;
	}

	get builtin(): string | null {
		return this.builtinName;
	}

	/** Whether the built-in worker receives tasks in this run */
	get builtinActive(): boolean {
		return this.builtinName !== null && this.isActive(this.builtinName);
	}

	/**
	 * Applies the sync response. Returns true rejections (excluding those accepted as push serving).
	 * The server list is not known yet — it starts from the names in the response (created, updated, unchanged).
	 * unsent = workers left out of the request for load failure — active until the first server list
	 */
	applySync(
		res: Pick<SyncWorkersResponse, 'workers' | 'rejected'>,
		ctx: SyncContext,
		unsent: Iterable<string> = []
	): SyncRejected[] {
		for (const name of unsent) this.unsent.add(name);
		const real: SyncRejected[] = [];
		for (const r of res.rejected) {
			if (
				ctx.public &&
				r.code === 'worker_name_taken' &&
				r.conflict?.kind === 'push' &&
				ctx.hasPushKeys(r.name)
			) {
				this.pushServed.add(r.name);
			} else {
				this.rejected.set(r.name, r);
				real.push(r);
			}
		}
		this.server = new Set(res.workers.map((w) => w.name));
		return real;
	}

	/**
	 * `reload` (#1393) — swaps in the result of re-reading and syncing the worker files. Returns true rejections.
	 * Rejections, push serving and load failures are recomputed from this response so a fixed worker doesn't stay off.
	 * Workers turned off by server-side deletion revive if the server accepted them now (the upsert recreated them).
	 * Resets to the pre-first-list state so load-failure decisions are deferred again.
	 */
	resync(
		localNames: Iterable<string>,
		res: Pick<SyncWorkersResponse, 'workers' | 'rejected'>,
		ctx: SyncContext,
		unsent: Iterable<string> = [],
		builtin: string | null = this.builtinName
	): SyncRejected[] {
		this.local = new Set(localNames);
		this.builtinName = builtin;
		this.rejected.clear();
		this.pushServed.clear();
		this.unsent.clear();
		for (const w of res.workers) this.deleted.delete(w.name);
		this.serverSeen = false;
		return this.applySync(res, ctx, unsent);
	}

	/**
	 * The pull response's `workers`. Returns the names deactivated now —
	 * deleted: removed on the server / unregistered: a worker left out of sync was also missing from the first list (never registered)
	 */
	applyServerList(names: Iterable<string>): { deleted: string[]; unregistered: string[] } {
		const before = this.activeNames({ builtin: true });
		const first = !this.serverSeen;
		this.server = new Set(names);
		this.serverSeen = true;
		const deleted: string[] = [];
		const unregistered: string[] = [];
		for (const name of before) {
			if (this.isActive(name)) continue;
			if (first && this.unsent.has(name)) {
				unregistered.push(name);
			} else {
				this.deleted.add(name);
				deleted.push(name);
			}
		}
		return { deleted, unregistered };
	}

	/**
	 * `worker delete` on the same PC removed it from the server and disk (docs/design/14_cli_host.md §13-3) — turn it off
	 * without waiting for the next pull. Uses the same state as a server-side deletion (same exit record and local
	 * server notice). Returns the names turned off now (#1462)
	 */
	dropLocal(names: Iterable<string>): string[] {
		const dropped: string[] = [];
		for (const name of names) {
			if (!this.isActive(name)) continue;
			this.deleted.add(name);
			this.server.delete(name);
			dropped.push(name);
		}
		return dropped.sort();
	}

	/** Names undecided until the first server list (workers left out of sync for load failure) */
	pendingNames(): string[] {
		return this.serverSeen ? [] : [...this.unsent].filter((n) => this.local.has(n)).sort();
	}

	isActive(name: string): boolean {
		if (!this.local.has(name) && name !== this.builtinName) return false;
		if (this.pushServed.has(name)) return true;
		if (this.rejected.has(name) || this.deleted.has(name)) return false;
		if (!this.serverSeen && this.unsent.has(name)) return true;
		return this.server.has(name);
	}

	inactiveReason(name: string): InactiveReason | null {
		if (this.isActive(name)) return null;
		if (this.rejected.has(name)) return 'rejected';
		if (this.deleted.has(name)) return 'deleted_on_server';
		return 'not_on_server';
	}

	/** Active file workers — plus the built-in worker when `builtin: true` */
	activeNames({ builtin = false }: { builtin?: boolean } = {}): string[] {
		const names = [...this.local];
		if (builtin && this.builtinName !== null) names.push(this.builtinName);
		return names.filter((n) => this.isActive(n)).sort();
	}

	get activeCount(): number {
		return this.activeNames().length;
	}

	/** Number of active workers received via pull — 0 means polling only gets empty responses (only push serving left) */
	get pullActiveCount(): number {
		return this.activeNames().filter((n) => !this.pushServed.has(n)).length;
	}

	pushServedNames(): string[] {
		return [...this.pushServed].sort();
	}

	/** Names deactivated by server-side deletion — for the exit record */
	deletedNames(): string[] {
		return [...this.deleted].sort();
	}
}
