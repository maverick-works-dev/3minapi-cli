/**
 * Reload result of the workers module (#1393) — `start` writes it to the result file; `reload` and `worker new` print it.
 * Requesting and waiting live on the host side (core/host/reload.ts).
 */
import type { Quota } from '../../core/domain/index.ts';
import type { ReloadFailure } from '../../core/host/reload.ts';
import { formatCount } from '../../core/text.ts';

export interface WorkersReloaded {
	ok: true;
	created: string[];
	updated: string[];
	unchanged: string[];
	/** Per-item server rejections (docs/design/14_cli_host.md §6-4) and names withheld for case collisions */
	rejected: { name: string; code: string; error: string }[];
	/** Not sent because loading failed — an earlier registration, if any, stays on the server */
	notLoaded: { name: string; message: string }[];
	active: string[];
	quota: Quota;
}

export type ReloadResult = WorkersReloaded | ReloadFailure;

/** Human-readable result lines */
export function reloadLines(result: WorkersReloaded): string[] {
	const lines: string[] = [];
	const registered = [
		...result.created.map((n) => `${n} (new)`),
		...result.updated.map((n) => `${n} (updated)`)
	];
	if (registered.length > 0) lines.push(`registered  ${registered.join(', ')}`);
	for (const r of result.rejected) lines.push(`rejected    ${r.name} — ${r.error}`);
	for (const w of result.notLoaded) lines.push(`not loaded  ${w.name} — ${w.message}`);
	lines.push(
		`workers     ${result.active.length} active (${result.active.join(', ') || 'none'})`,
		`quota       ${formatCount(result.quota.remaining)} of ${formatCount(result.quota.limit)} calls left`
	);
	return lines;
}
