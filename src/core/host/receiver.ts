/**
 * Receiver — decides **when** the host pulls (docs/design/14_cli_host.md §13). poll uses the poller (poller.ts); live
 * uses a receiver that takes live channel signals (live-receiver.ts). `start` picks one by mode and drives both alike.
 */
import type { StopError } from '../domain/index.ts';
import type { ModuleEnded } from './module.ts';

export interface Receiver {
	/** The stop error (with resetAt) if stopped, ModuleEnded if no workers stayed active, null if the user stopped it */
	run(): Promise<StopError | ModuleEnded | null>;
	/** Called when a module receives a stop code (workers: while reporting a result — TaskRunner) */
	stop(err: StopError): void;
	/** Requests a resync (`reload`) — runs between pulls, while idle */
	requestResync(): void;
	/**
	 * Turns off workers deleted on this PC (`worker delete`) — applied between pulls; ends when none stay active.
	 * Live pulls are rare, so waiting for the server list would take long (#1462)
	 */
	requestDrop(names: string[]): void;
	/** Can accept a new resync request — none is pending or running */
	readonly resyncIdle: boolean;
}
