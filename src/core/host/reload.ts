/**
 * reload — asks the running start to resync and returns its result (docs/design/15_cli.md §4).
 *
 * Uses files like `stop` does (Windows processes cannot receive signals). The request is a file carrying the nonce;
 * the result is a file written by start (runner-lock.ts). Shared by the `reload` command and `worker new`'s auto reload.
 *
 * Host runtime side — handles request, wait and failure only; the module defines the success result shape
 * (workers: modules/workers/reload-result.ts).
 */
import {
	CliError,
	ExitCode,
	RELOAD_WAIT_MS,
	StopError,
	type CommandContext,
	type StopCode
} from '../domain/index.ts';
import { readReload, readRunner, requestReload, type RunnerInfo } from './runner-lock.ts';
import { stopHint } from './session.ts';
import { sleep } from '../time.ts';

/** Resync failure — with a stop code, the running start has stopped too */
export interface ReloadFailure {
	ok: false;
	error: string;
	stopped?: StopCode;
}

const POLL_MS = 200;

/**
 * Requests a resync and waits for the result. A failed result is returned as is (the caller picks the exit code);
 * CliError if start ends or the wait times out.
 *
 * Overlapping requests overwrite the request file, so this takes the result of any resync started after its own
 * request time rather than matching an id (every resync reads the whole folder).
 */
export async function reloadRunner<R extends { ok: true }>(
	ctx: CommandContext,
	info: RunnerInfo
): Promise<R | ReloadFailure> {
	if (!info.reload) {
		throw new CliError(
			`the running start (pid ${info.pid}) is from an older 3minapi and cannot reload. Restart it: '3minapi stop' then '3minapi start'.`
		);
	}
	const requestedAt = requestReload(ctx.dirs.data, info);
	const deadline = requestedAt + RELOAD_WAIT_MS;
	for (;;) {
		const record = readReload<R | ReloadFailure>(ctx.dirs.data, info);
		if (record?.state === 'done' && record.startedAt >= requestedAt && record.result) {
			return record.result;
		}
		const runner = readRunner(ctx.dirs.data);
		if (runner.state !== 'running' || runner.info.nonce !== info.nonce) {
			throw new CliError(
				"the running start ended before the reload finished. See '3minapi status' and '3minapi logs'."
			);
		}
		if (Date.now() >= deadline) {
			throw new CliError(
				`no reload result after ${RELOAD_WAIT_MS / 1000}s — the start may still be loading worker files. See '3minapi logs'.`
			);
		}
		await sleep(POLL_MS, ctx.signal);
		if (ctx.signal.aborted)
			throw new CliError('cancelled — the running start may still reload.', ExitCode.Interrupted);
	}
}

/** Maps a failed result to an exit code — StopError (4/5/6) for a stop code, otherwise CliError (1) */
export function failReload(result: ReloadFailure): never {
	if (result.stopped) {
		throw new StopError(
			result.stopped,
			`${result.error}\nThe running start stopped all calls. ${stopHint(result.stopped)}`
		);
	}
	throw new CliError(`reload failed: ${result.error} The running start keeps its current workers.`);
}
