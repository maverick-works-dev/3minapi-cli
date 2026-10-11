/**
 * Poller ↔ module interface (docs/design/15_cli.md §4, §8).
 *
 * The host runtime (resident process, lock, poller) is feature-neutral; features attach as modules. One pull per
 * host — the poller pulls and hands the response to the module. Only the workers module exists, so the poller takes
 * one module. Serving several modules needs multiplexed pull (docs/design/14_cli_host.md §12).
 */
import type { EndReason } from '../control-db.ts';
import type { LiveTopic, PullResponse, StopCode } from '../domain/index.ts';

/** Ended on its own with no active module — the end reason stored in the control DB */
export interface ModuleEnded {
	ended: EndReason;
	/** Workers turned off because they were deleted on the server (workers module) */
	deletedWorkers: string[];
}

export interface HostModule {
	/** Count of things to run — at 0 the host ends so empty polls don't burn quota (docs/design/14_cli_host.md §10) */
	readonly activeCount: number;
	/**
	 * Topics subscribed in live mode (docs/design/14_cli_host.md §13-3) — a signal on one triggers a pull. The runtime
	 * owns the `host` topic; modules do not subscribe to it
	 */
	readonly topics: readonly LiveTopic[];
	/** Right before a pull — flushes pending work. If stopped meanwhile, the poller skips the pull */
	beforePull(): Promise<void>;
	/**
	 * Flushes pending work independent of pulls — live pulls are rare, so a timer calls it
	 * (docs/design/14_cli_host.md §13-9). Must be safe under concurrent calls
	 */
	flushPending(): Promise<void>;
	/**
	 * Registers a callback for when free slots go from 0 to more — live runs its deferred pull
	 * (docs/design/14_cli_host.md §13-6 item 4). Registered once
	 */
	onSlotFree(cb: () => void): void;
	/** Batch size for this pull */
	pullMax(): number;
	/** A successful pull response */
	onPull(res: PullResponse): void;
	/** Turns off workers deleted on this PC (`worker delete`) — no server call. The active count may drop */
	dropLocal(names: string[]): void;
	/** `reload` — throws StopError only for a stop code (full stop); reports and swallows other failures itself */
	resync(): Promise<void>;
	/** On ending with a stop code — aborts work in progress */
	halt(reason: StopCode): Promise<void>;
	/** On ending by user stop or no active workers — winds down work in progress and flushes the rest */
	shutdown(): Promise<void>;
	/** What to record when ended with nothing active */
	ended(): ModuleEnded;
}
