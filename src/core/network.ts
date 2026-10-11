/**
 * Process-wide net defaults — raises the Happy Eyeballs attempt timeout (see NETWORK_FAMILY_ATTEMPT_TIMEOUT_MS).
 *
 * - `autoSelectFamily` itself stays on — turning it off drops the IPv6→IPv4 fallback and breaks `::1`/localhost
 * - A value set by flag (`node --network-family-autoselection-attempt-timeout=…` or `NODE_OPTIONS`) is kept
 * - A larger current value (if a future Node raises the default) is kept
 *
 * net defaults are per thread (isolate) — Executor passes this value to worker threads via workerData.
 * Called by bin.ts (so it imports nothing besides domain/constants.ts).
 */
import {
	getDefaultAutoSelectFamilyAttemptTimeout,
	setDefaultAutoSelectFamilyAttemptTimeout
} from 'node:net';
import { NETWORK_FAMILY_ATTEMPT_TIMEOUT_MS } from './domain/constants.ts';

const FLAG = '--network-family-autoselection-attempt-timeout';

export interface NetworkDefaultsInput {
	execArgv: readonly string[];
	nodeOptions: string | undefined;
}

/** Returns the value after applying */
export function raiseConnectAttemptTimeout(
	{ execArgv, nodeOptions }: NetworkDefaultsInput,
	target = NETWORK_FAMILY_ATTEMPT_TIMEOUT_MS
): number {
	const userSet = execArgv.some((a) => a.startsWith(FLAG)) || (nodeOptions ?? '').includes(FLAG);
	if (!userSet && getDefaultAutoSelectFamilyAttemptTimeout() < target) {
		setDefaultAutoSelectFamilyAttemptTimeout(target);
	}
	return getDefaultAutoSelectFamilyAttemptTimeout();
}
