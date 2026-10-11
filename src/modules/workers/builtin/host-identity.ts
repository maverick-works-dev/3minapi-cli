/**
 * This host's id and name, used for the built-in reader worker's name (`_results_<last 8 chars of host id>`) and
 * description. See docs/design/15_cli.md §7-2, §8-6.
 *
 * `start` does not call `GET /api/v1/host` by itself. `login` and `status` (which already call it) cache the result
 * in the control DB `meta` table; `start` makes one call only when the cache is missing or belongs to another token.
 * The token is never stored (docs/design/15_cli.md §7-2) — the cache is keyed by the first 12 hex chars of its hash.
 *
 * A host renamed on the web keeps its old name in the description until the next `status` or `login`; the worker
 * name (from the id) does not change.
 *
 * **When the host changes** (re-login with another host's token) the previous host id is returned and the caller
 * warns. The previous host's task history and saved results stay; the built-in reader only reads results whose
 * `host_id` is the current host. (#1403)
 */
import { createHash } from 'node:crypto';
import type { ApiClient } from '../../../core/api.ts';
import type { ControlDb } from '../../../core/control-db.ts';
import { StopError, builtinResultsName } from '../../../core/domain/index.ts';
import type { BuiltinSpec } from '../sync.ts';

export const HOST_META = {
	id: 'host_id',
	name: 'host_name',
	tokenFp: 'host_token_fp'
} as const;

export interface HostIdentity {
	id: string;
	name: string;
}

export function tokenFingerprint(token: string): string {
	return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

/**
 * Called by login and status; failures are swallowed (the command itself succeeded). Returns the previously cached
 * host id when it was a different host.
 */
export function cacheHostIdentity(
	db: ControlDb,
	token: string,
	host: HostIdentity,
	now: number
): string | null {
	try {
		const previous = db.getMeta(HOST_META.id);
		// All three together — a new id with a stale fingerprint would make the next start use the wrong cache
		db.setMetas(
			{
				[HOST_META.id]: host.id,
				[HOST_META.name]: host.name,
				[HOST_META.tokenFp]: tokenFingerprint(token)
			},
			now
		);
		return previous !== null && previous !== host.id ? previous : null;
	} catch {
		// Only a cache — the next start asks again
		return null;
	}
}

/** Warning shown when the host changed */
export function hostChangedWarning(previousId: string, host: HostIdentity): string {
	return (
		`this token is for host "${host.name}" (${host.id}); this PC was host ${previousId}. ` +
		"The previous host's task history and saved results stay on this PC; remote AIs on the new host " +
		"cannot read those results. Remove the task history with '3minapi tasks prune' if you no longer need it."
	);
}

export function cachedHostIdentity(db: ControlDb, token: string): HostIdentity | null {
	if (db.getMeta(HOST_META.tokenFp) !== tokenFingerprint(token)) return null;
	const id = db.getMeta(HOST_META.id);
	const name = db.getMeta(HOST_META.name);
	return id && name ? { id, name } : null;
}

/**
 * Cache first, else one `getHost` call. Stop codes are rethrown (the caller stops). Other failures return null —
 * this run continues without the built-in worker rather than blocking startup.
 */
export async function resolveHostIdentity(
	db: ControlDb,
	api: ApiClient,
	token: string,
	now: number
): Promise<{ host: HostIdentity | null; error?: string; previousHostId?: string }> {
	const cached = cachedHostIdentity(db, token);
	if (cached) return { host: cached };
	try {
		const res = await api.getHost();
		const host = { id: res.host.id, name: res.host.name };
		const previous = cacheHostIdentity(db, token, host, now);
		return previous === null ? { host } : { host, previousHostId: previous };
	} catch (err) {
		if (err instanceof StopError) throw err;
		return { host: null, error: (err as Error).message };
	}
}

/**
 * Built-in reader worker added to sync. The description states facts only; usage lives in help(tasks)
 * (docs/mcp/02_tool_description_guide.md §4-1).
 */
export function builtinResultsSpec(host: HostIdentity): BuiltinSpec {
	return {
		name: builtinResultsName(host.id),
		description:
			`Built-in reader for the task results saved on host ${JSON.stringify(host.name)}. ` +
			'input: {"op":"describe"|"query"|"read", …} — see help(tasks) for the fields and examples.'
	};
}
