/**
 * Local state a command uses — config, control DB, logger. Opening the logger (and each UTC date change) prunes log
 * files by retention days and total size (docs/design/15_cli.md §7-3). The control DB is never pruned automatically;
 * see `tasks prune`.
 */
import { ControlDb, type EndReason } from '../control-db.ts';
import type {
	CommandContext,
	OutputPort,
	Quota,
	ResolvedConfig,
	StopError,
	StopReason
} from '../domain/index.ts';
import { Logger, pruneLogs } from '../logger.ts';
import { updateCommand, updateNote } from '../update-notice.ts';

export interface Session {
	config: ResolvedConfig;
	out: OutputPort;
	db: ControlDb;
	logger: Logger;
	close(): void;
}

export function openSession(ctx: CommandContext): Session {
	const config = ctx.loadConfig();
	const db = ControlDb.open(ctx.dirs.data);
	try {
		const { logRetentionDays, logMaxBytes } = config.values;
		const logger = new Logger({
			dir: ctx.dirs.logs,
			now: ctx.now,
			onMaintenance(now) {
				pruneLogs({
					dir: ctx.dirs.logs,
					now,
					retentionDays: logRetentionDays,
					maxBytes: logMaxBytes
				});
			},
			onError: (message) => ctx.out.warn(message)
		});
		return { config, out: ctx.out, db, logger, close: () => db.close() };
	} catch (err) {
		db.close();
		throw err;
	}
}

/**
 * Shared handling of a server stop code — records the reason in the control DB and the app log. No auto resume.
 * The poller uses it too.
 *
 * ⚠️ Never throws. Even if recording fails (lock, disk), the caller must still throw its StopError and exit 4/5/6.
 */
export function recordStop(session: Session, err: StopError, now: number): void {
	try {
		session.db.recordStop(err.reason, now, err.resetAt);
	} catch (e) {
		session.out.warn(`could not record the stop in ${session.db.file}: ${(e as Error).message}`);
	}
	session.logger.warn('stopped all API calls', { reason: err.reason, message: err.message });
}

/** On a server-accepted call the old stop reason no longer holds. A failure here does not fail the main work */
export function clearStop(session: Session): void {
	try {
		session.db.clearStop();
	} catch (e) {
		session.out.warn(
			`could not clear the previous stop record in ${session.db.file}: ${(e as Error).message}`
		);
	}
}

/**
 * start ended on its own without a server stop (no active workers, docs/design/14_cli_host.md §10) — records the
 * reason for `status`. Never throws, like recordStop
 */
export function recordEnd(
	session: Session,
	reason: EndReason,
	deletedWorkers: string[],
	now: number
): void {
	try {
		session.db.recordEnd(reason, now, deletedWorkers);
	} catch (e) {
		session.out.warn(
			`could not record why it ended in ${session.db.file}: ${(e as Error).message}`
		);
	}
	session.logger.warn('runner ended: no active workers', { deleted_workers: deletedWorkers });
}

/** A new start synced — old stop and end records no longer hold. A failure here does not fail the main work */
export function clearRunnerRecords(session: Session): void {
	clearStop(session);
	try {
		session.db.clearEnd();
	} catch (e) {
		session.out.warn(
			`could not clear the previous end record in ${session.db.file}: ${(e as Error).message}`
		);
	}
}

/**
 * Saves the quota from a server response so `status` can show the last value when offline. Only a cache, so failures
 * are swallowed
 */
export function rememberQuota(
	session: Session,
	quota: Quota | null | undefined,
	now: number
): void {
	if (!quota) return;
	try {
		session.db.recordQuota(quota, now);
	} catch {
		// the next response saves it again
	}
}

/** Next step for each stop reason */
export function stopHint(reason: StopReason): string {
	switch (reason) {
		case 'host_token_invalid':
			return "The host token was revoked or the host was deleted. Issue a new token on the dashboard and run '3minapi login'.";
		case 'no_subscription':
			return 'There is no active subscription for this account. Subscribe on the dashboard, then run the command again.';
		case 'quota_exhausted':
			return 'All API calls are stopped. After the quota resets or the plan is upgraded, run the command again.';
		case 'cli_outdated':
			return `All API calls are stopped until this CLI is updated. Run: ${updateCommand()}\n${updateNote(null)}`;
	}
}
