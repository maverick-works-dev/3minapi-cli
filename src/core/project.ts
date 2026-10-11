/**
 * This host's project — one project per host (docs/design/15_cli.md §5).
 *
 * The control DB and logs are one per host. The project (`3minapi.json`, `workers/`, `.env`, `data.db`) is pinned to one as well, so "one host =
 * one control DB, log set and user DB". `init` records the path in `<data>/project.json`, and later commands use that project
 * regardless of cwd.
 *
 * - The record lives in the **data folder** (machine-specific) — the Windows config folder is Roaming and follows a domain profile to other PCs
 * - A file rather than the control DB, so `paths` and `doctor` can read it without opening sqlite
 * - With no record (fresh state folder, or a folder initialized before recording existed), the project found from cwd is recorded on first use
 * - If the recorded folder is gone (renamed or deleted), it counts as no record — the project found from cwd is recorded instead
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { findProjectFile } from './config.ts';
import {
	BIN,
	DEFAULT_PROJECT_DIR,
	PROJECT_CONFIG_FILE,
	PROJECT_RECORD_FILE
} from './domain/index.ts';
import { writeSecretFile } from './secure-fs.ts';
import { shellArg } from './text.ts';

export interface ProjectRecord {
	root: string;
	recordedAt: string;
}

export function projectRecordPath(dataDir: string): string {
	return path.join(dataDir, PROJECT_RECORD_FILE);
}

/** The record. null if missing or broken — a broken record counts as none (the next init or auto-record overwrites it) */
export function readProjectRecord(dataDir: string): ProjectRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(projectRecordPath(dataDir), 'utf8'));
	} catch {
		return null;
	}
	const root = (parsed as Partial<ProjectRecord> | null)?.root;
	if (typeof root !== 'string' || !path.isAbsolute(root)) return null;
	return { root, recordedAt: String((parsed as ProjectRecord).recordedAt ?? '') };
}

export function writeProjectRecord(dataDir: string, root: string, now: number): void {
	const body: ProjectRecord = { root, recordedAt: new Date(now).toISOString() };
	writeSecretFile(projectRecordPath(dataDir), JSON.stringify(body, null, '\t') + '\n');
}

/** The project `init` creates when given no path — `~/3minapi` regardless of where it runs */
export function defaultProjectRoot(home: string): string {
	return path.join(home, DEFAULT_PROJECT_DIR);
}

/**
 * Hint when there is no project — includes the absolute path that would be created.
 * Where home is unknown (functions that only get config), uses `~/3minapi`
 */
export function initHint(home?: string): string {
	const where = home === undefined ? `~/${DEFAULT_PROJECT_DIR}` : defaultProjectRoot(home);
	return `Run '${BIN} init' (creates ${where}) or '${BIN} init <folder>'.`;
}

/** When the recorded project folder is gone — if it was moved, run any command inside the new folder instead of init */
export function goneHint(root: string, home: string): string {
	return (
		`this host's project ${root} no longer exists. If you moved it, run any ${BIN} command inside ` +
		`the new folder (e.g. '${BIN} status') and it is picked up. Otherwise: ${initHint(home)}`
	);
}

/** Whether the recorded project still exists — the folder must contain 3minapi.json */
export function projectAlive(root: string): boolean {
	return existsSync(path.join(root, PROJECT_CONFIG_FILE));
}

/**
 * Whether two paths are the same folder — resolves symlinks and compares lowercased on the default case-insensitive file systems (macOS, Windows).
 * Paths that do not exist are only resolved
 */
export function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
	const norm = (p: string) => {
		let real = path.resolve(p);
		try {
			real = realpathSync.native(real);
		} catch {
			// Folder does not exist — compare as is
		}
		return platform === 'darwin' || platform === 'win32' ? real.toLowerCase() : real;
	};
	return norm(a) === norm(b);
}

export interface ProjectResolution {
	/** The 3minapi.json to use, or null */
	projectFile: string | null;
	/** Project folder to record — there was no record, or the recorded folder is gone */
	record: string | null;
	/** Notice to show once */
	notices: string[];
}

/**
 * Resolves the project a command uses (docs/design/15_cli.md §5).
 * 1. The record, if present and alive — if cwd is inside another project, a notice says that project is ignored
 * 2. Otherwise the one found upward from cwd — recorded when found (existing setups, renamed folders)
 *
 * A file given with `--config` bypasses this function (explicit — not recorded)
 */
export function resolveProject(input: {
	cwd: string;
	dataDir: string;
	platform: NodeJS.Platform;
	home: string;
}): ProjectResolution {
	const recorded = readProjectRecord(input.dataDir);
	// The record file exists but could not be read — reported separately from a first-time record
	const unreadable =
		recorded === null && existsSync(projectRecordPath(input.dataDir))
			? `could not read ${projectRecordPath(input.dataDir)} (this host's project record). `
			: '';
	const found = findProjectFile(input.cwd);
	if (recorded && projectAlive(recorded.root)) {
		const notices: string[] = [];
		if (found && !samePath(path.dirname(found), recorded.root, input.platform)) {
			notices.push(
				`ignoring ${found} — this host's project is ${recorded.root}. ` +
					`Run '${BIN} init ${shellArg(path.dirname(found))} --move' to make it the project instead.`
			);
		}
		return { projectFile: path.join(recorded.root, PROJECT_CONFIG_FILE), record: null, notices };
	}
	if (!found) {
		const notices = recorded
			? [goneHint(recorded.root, input.home)]
			: unreadable
				? [`${unreadable}${initHint(input.home)}`]
				: [];
		return { projectFile: null, record: null, notices };
	}
	const root = path.dirname(found);
	return {
		projectFile: found,
		record: root,
		notices: [
			recorded
				? `this host's project ${recorded.root} no longer exists — now using ${root}.`
				: `${unreadable}this host's project is now ${root} — commands use it from any folder.`
		]
	};
}
