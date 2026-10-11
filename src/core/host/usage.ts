/**
 * Disk used by this host — control DB and logs (docs/design/15_cli.md §7-2, §7-3). `status` shows it because the
 * control DB is never pruned and logs fill up to their cap. No server call. Project data.db belongs to the workers
 * module (results/store.ts).
 */
import type { ControlDb } from '../control-db.ts';
import { listAllLogFiles } from '../logger.ts';

export interface HostUsage {
	controlDb: { file: string; bytes: number; tasks: number; unfinished: number } | null;
	logs: { dir: string; bytes: number; files: number };
}

/** A failed read blanks only that item (null or 0) — display only */
export function hostUsage(db: ControlDb, logsDir: string): HostUsage {
	let controlDb: HostUsage['controlDb'] = null;
	try {
		const { total, unfinished } = db.taskCounts();
		controlDb = { file: db.file, bytes: db.fileBytes(), tasks: total, unfinished };
	} catch {
		// Only the display is skipped
	}
	let files: { size: number }[] = [];
	try {
		files = listAllLogFiles(logsDir);
	} catch {
		// Only the display is skipped
	}
	return {
		controlDb,
		logs: { dir: logsDir, bytes: files.reduce((n, f) => n + f.size, 0), files: files.length }
	};
}
