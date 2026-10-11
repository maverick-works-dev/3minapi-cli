/**
 * Writing files and folders that hold secrets (docs/design/15_cli.md §7-1).
 *
 * - POSIX: files 0600, folders 0700. `mode` applies **only on creation** (fs.open docs), so an existing file is replaced by
 *   writing a temp file in the same folder (`wx`, 0600) and renaming it
 * - Windows: mode only affects write permission (fs.chmod docs). Relies on ACL inheritance from the user profile
 *   (%APPDATA%, %LOCALAPPDATA%). rename can fail with EPERM/EBUSY while antivirus or an indexer holds the target, so it retries briefly
 */
import { randomBytes } from 'node:crypto';
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import path from 'node:path';
import { PRIVATE_DIR_MODE, SECRET_FILE_MODE } from './domain/index.ts';

const isWindows = process.platform === 'win32';

/** Creates the folder (kept if it exists) and sets 0700 on POSIX */
export function ensurePrivateDir(dir: string): void {
	const existed = existsSync(dir);
	mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
	// Only tighten folders created here — an existing folder the user chose (e.g. THREEMINAPI_HOME) is left alone
	if (!existed && !isWindows) chmodSync(dir, PRIVATE_DIR_MODE);
}

/** Writes a 0600 file by atomic replace */
export function writeSecretFile(file: string, data: string): void {
	ensurePrivateDir(path.dirname(file));
	const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
	try {
		writeFileSync(tmp, data, { mode: SECRET_FILE_MODE, flag: 'wx' });
		if (!isWindows) chmodSync(tmp, SECRET_FILE_MODE); // umask can narrow 0600 but never widen it; set explicitly anyway
		renameWithRetry(tmp, file);
	} catch (err) {
		rmSync(tmp, { force: true });
		throw err;
	}
}

/** Creates an empty 0600 file if missing — SQLite copies the main DB file's mode to -wal and -shm */
export function touchSecretFile(file: string): void {
	ensurePrivateDir(path.dirname(file));
	closeSync(openSync(file, 'a', SECRET_FILE_MODE));
}

/** On POSIX, returns the mode if group/other permissions are open. null if safe or on Windows */
export function looseMode(file: string): number | null {
	if (isWindows || !existsSync(file)) return null;
	const mode = statSync(file).mode & 0o777;
	return mode & 0o077 ? mode : null;
}

function renameWithRetry(from: string, to: string): void {
	for (let attempt = 0; ; attempt++) {
		try {
			renameSync(from, to);
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (!isWindows || attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) {
				throw err;
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
		}
	}
}
