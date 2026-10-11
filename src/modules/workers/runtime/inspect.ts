/**
 * Worker file inspection for `worker list` — imports the file in the same kind of thread as execution and reports
 * its exports without calling the handler.
 *
 * ⚠️ Importing runs the file's top-level code, so a worker with top-level side effects triggers them on inspection.
 */
import { getDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { Worker } from 'node:worker_threads';
import { ERROR_MESSAGE_MAX_CHARS } from '../../../core/domain/index.ts';
import { redactAndTruncate } from '../../../core/redact.ts';
import { THREAD_URL } from './executor.ts';
import type { FailureReason, FromThread, ThreadInput, WorkerMeta } from './protocol.ts';

/** Lets the listing finish even if a top-level await hangs */
export const INSPECT_TIMEOUT_MS = 10_000;

export type Inspection =
	| { ok: true; meta: WorkerMeta }
	| { ok: false; reason: FailureReason; message: string };

export function inspectWorker(
	file: string,
	env: Record<string, string | undefined>,
	timeoutMs = INSPECT_TIMEOUT_MS
): Promise<Inspection> {
	return new Promise((resolve) => {
		const workerData: ThreadInput = {
			file,
			input: null,
			inspect: true,
			// Top-level code may use the network — same value as the execution thread (core/network.ts)
			connectAttemptTimeoutMs: getDefaultAutoSelectFamilyAttemptTimeout()
		};
		// Capture and discard top-level console output so it does not mix into the listing
		const thread = new Worker(THREAD_URL, {
			workerData,
			env,
			execArgv: [],
			stdout: true,
			stderr: true
		});
		thread.stdout.resume();
		thread.stderr.resume();
		let settled = false;
		const settle = (result: Inspection) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			void thread.terminate();
			resolve(
				result.ok
					? result
					: { ...result, message: redactAndTruncate(result.message, ERROR_MESSAGE_MAX_CHARS) }
			);
		};
		const timer = setTimeout(
			() =>
				settle({
					ok: false,
					reason: 'invalid_worker',
					message: `loading did not finish within ${timeoutMs} ms`
				}),
			timeoutMs
		);
		thread.on('message', (msg: FromThread) => {
			if (msg.type === 'meta') settle({ ok: true, meta: msg.meta });
			else if (msg.type === 'fail') settle({ ok: false, reason: msg.reason, message: msg.message });
		});
		thread.on('error', (err) =>
			settle({ ok: false, reason: 'invalid_worker', message: `cannot load: ${err.message}` })
		);
		thread.on('exit', (code) =>
			settle({
				ok: false,
				reason: 'invalid_worker',
				message: `exited while loading (exit code ${code})`
			})
		);
	});
}
