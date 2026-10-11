/**
 * Built-in reader worker — lets a remote AI describe, query and read the results saved on this PC
 * (docs/design/15_cli.md §8-6).
 *
 * A **local worker** with no file: `start` syncs it per host as `_results_<last 8 chars of host id>` (contract.ts
 * `builtinResultsName`), and its tasks arrive on the same pull/ack/reply path as other local workers. The executor
 * (executor.ts) calls this function instead of a worker file; execution slots, cancel and stop still apply.
 *
 * - Input is validated here; execution runs in a child process (results-child.ts → reader.ts). 30s limit per op
 * - Results are not saved to data.db (task-runner.ts) — they derive from saved data and always fit the reply budget
 * - ⚠️ Messages never carry paths — they go to the server and the AI and would expose the OS user name
 *   (docs/design/15_cli.md §8-5)
 */
import { RESULTS_QUERY_TIMEOUT_MS } from '../../../core/domain/index.ts';
import { runReaderChild } from '../results/query.ts';
import { parseReaderInput } from '../results/reader-input.ts';
import { resultsDbPath } from '../results/store.ts';
import type { FailureReason } from '../runtime/protocol.ts';

export type BuiltinOutcome =
	| { status: 'completed'; resultJson: string }
	| { status: 'failed'; reason: FailureReason; message: string };

/** Signature the executor calls — `signal` aborts on cancel or stop */
export type BuiltinRun = (input: unknown, signal: AbortSignal) => Promise<BuiltinOutcome>;

/** `hostId` = the current host — only results run by that host are read (#1403) */
export function resultsWorker(
	root: string,
	hostId: string,
	timeoutMs = RESULTS_QUERY_TIMEOUT_MS
): BuiltinRun {
	return async (input, signal) => {
		const parsed = parseReaderInput(input);
		if (!parsed.ok) return { status: 'failed', reason: 'invalid_input', message: parsed.message };
		let r;
		try {
			r = await runReaderChild(root, hostId, parsed.req, timeoutMs, signal);
		} catch {
			// The child died without a result — its message carries the child's stderr (stack, CLI install path), so drop it
			return {
				status: 'failed',
				reason: 'query_error',
				message: "could not read the saved results on the user's PC"
			};
		}
		if (r === 'cancelled') return { status: 'failed', reason: 'query_error', message: 'cancelled' };
		if (r === 'timeout') {
			return {
				status: 'failed',
				reason: 'timeout',
				message: `did not finish within ${timeoutMs / 1000}s — narrow the scope or aggregate in SQL`
			};
		}
		if (!r.ok)
			return { status: 'failed', reason: r.reason, message: withoutPaths(root, r.message) };
		return { status: 'completed', resultJson: JSON.stringify(r.result) };
	};
}

/** Paths on this PC → file names */
function withoutPaths(root: string, message: string): string {
	return message.split(resultsDbPath(root)).join('data.db').split(root).join('<project>');
}
