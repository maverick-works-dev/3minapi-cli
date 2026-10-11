/**
 * Scans the workers folder — shared by `worker list` and `start` (sync, docs/design/14_cli_host.md §3-4).
 * One file = one worker; the file name without extension = the worker name. Each file is imported only to read
 * its exports; the handler is not called.
 *
 * ⚠️ Importing runs the file's top-level code — see inspect.ts.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import {
	CliError,
	WORKER_DESCRIPTION_MAX_CHARS,
	WORKER_EXTENSIONS
} from '../../core/domain/index.ts';
import { checkWorkerName } from '../../core/names.ts';
import { inspectWorker } from './runtime/inspect.ts';
import type { WorkerMeta } from './runtime/protocol.ts';

/** Concurrent inspection threads — each worker may take up to 10 s, so a serial scan slows `start` */
const INSPECT_CONCURRENCY = 4;

export type WorkerProblem =
	/** Name breaks the rules in docs/design/14_cli_host.md §8 — the server rejects it with invalid_worker_name */
	| 'invalid_name'
	/** More than one file with the same name */
	| 'duplicate'
	/** Import failed, no handler, etc. */
	| 'load_failed';

export interface LocalWorker {
	name: string;
	files: string[];
	/** null = OK; `meta` is present only then */
	problem: WorkerProblem | null;
	message: string | null;
	meta: WorkerMeta | null;
}

/** Name → files (including duplicates that differ only by extension). No import. CliError if the folder is unreadable. Sorted by name */
export function workerFiles(dir: string): Map<string, string[]> {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch (err) {
		// The folder exists but is unreadable (permissions etc.) — don't surface the raw OS error
		throw new CliError(`cannot read workers folder ${dir}: ${(err as Error).message}`);
	}

	const byName = new Map<string, string[]>();
	for (const entry of entries.sort()) {
		const ext = path.extname(entry);
		if (!(WORKER_EXTENSIONS as readonly string[]).includes(ext)) continue;
		const name = entry.slice(0, -ext.length);
		byName.set(name, [...(byName.get(name) ?? []), path.join(dir, entry)]);
	}
	return byName;
}

/** Imports each file to read its exports. Sorted by name */
export async function collectWorkers(
	dir: string,
	env: Record<string, string | undefined>
): Promise<LocalWorker[]> {
	const workers: LocalWorker[] = [...workerFiles(dir)].map(([name, files]) => ({
		name,
		files,
		problem: null,
		message: null,
		meta: null
	}));
	const toInspect: LocalWorker[] = [];
	for (const w of workers) {
		const check = checkWorkerName(w.name);
		if (!check.ok) {
			w.problem = 'invalid_name';
			w.message = `not a valid worker name (${check.reason}) — tasks cannot reach it`;
		} else if (w.files.length > 1) {
			w.problem = 'duplicate';
			w.message = 'more than one file with this name — keep only one';
		} else {
			toInspect.push(w);
		}
	}

	let next = 0;
	const lane = async () => {
		while (next < toInspect.length) {
			const w = toInspect[next++];
			const r = await inspectWorker(w.files[0], env);
			if (r.ok) w.meta = r.meta;
			else {
				w.problem = 'load_failed';
				w.message = `${r.reason}: ${r.message}`;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(INSPECT_CONCURRENCY, toInspect.length) }, lane));
	return workers;
}

/** Same rule the server enforces (docs/design/14_cli_host.md §8) — length counts code points, not UTF-16 units */
export function descriptionTooLong(description: string): boolean {
	return Array.from(description).length > WORKER_DESCRIPTION_MAX_CHARS;
}
