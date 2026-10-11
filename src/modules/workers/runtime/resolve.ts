/**
 * Worker name → file. Exactly one of `workers/<name>.{js,mjs,ts,mts}` must exist (docs/design/15_cli.md §3).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { WORKER_EXTENSIONS } from '../../../core/domain/index.ts';
import { checkWorkerName, invalidNameMessage } from '../../../core/names.ts';

export type Resolved =
	| { ok: true; file: string }
	| { ok: false; reason: 'worker_not_found' | 'invalid_worker'; message: string };

export function resolveWorkerFile(workersDir: string, name: string): Resolved {
	const check = checkWorkerName(name);
	if (!check.ok) {
		return {
			ok: false,
			reason: 'invalid_worker',
			message: invalidNameMessage(name, check.reason)
		};
	}
	const found = WORKER_EXTENSIONS.map((ext) => path.join(workersDir, name + ext)).filter((f) =>
		existsSync(f)
	);
	if (found.length === 0) {
		return {
			ok: false,
			reason: 'worker_not_found',
			// Folder name only — this text goes to the server and the AI; an absolute path exposes the OS user name (#1410)
			message: `no worker file for "${name}" in the ${path.basename(workersDir)} folder (expected ${name}${WORKER_EXTENSIONS.join(` / ${name}`)})`
		};
	}
	if (found.length > 1) {
		return {
			ok: false,
			reason: 'invalid_worker',
			message: `more than one file for worker "${name}": ${found.map((f) => path.basename(f)).join(', ')}. Keep only one.`
		};
	}
	return { ok: true, file: found[0] };
}
