/**
 * Pull worker name check — the rule (regex) is in docs/design/14_cli_host.md §8, the code in domain/contract.ts.
 * This module only builds the human-readable reason.
 */
import {
	PULL_WORKER_NAME,
	RESERVED_NAME_PREFIX,
	UsageError,
	WINDOWS_RESERVED_NAME,
	isReservedWorkerName
} from './domain/index.ts';

export type NameCheck = { ok: true } | { ok: false; reason: string };

export function checkWorkerName(name: string): NameCheck {
	if (!PULL_WORKER_NAME.test(name)) {
		return {
			ok: false,
			reason: 'use 1-50 characters of lowercase letters, digits, "_" or "-"'
		};
	}
	if (WINDOWS_RESERVED_NAME.test(name)) {
		return { ok: false, reason: `"${name}" is a reserved device name on Windows` };
	}
	// Reserved for built-in workers (docs/design/14_cli_host.md §8) — the server sync rejects it too
	if (isReservedWorkerName(name)) {
		return {
			ok: false,
			reason: `names starting with "${RESERVED_NAME_PREFIX}" are reserved for built-in workers`
		};
	}
	return { ok: true };
}

export function invalidNameMessage(name: string, reason: string): string {
	return `invalid worker name "${name}": ${reason}`;
}

/** A name given as a command argument — a rule violation is a usage error (exit 2) */
export function assertWorkerName(name: string): void {
	const check = checkWorkerName(name);
	if (!check.ok) throw new UsageError(invalidNameMessage(name, check.reason));
}
