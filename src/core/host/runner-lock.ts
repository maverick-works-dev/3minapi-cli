/**
 * One `start` per host — `<data>/runner.json` lock file (docs/design/15_cli.md §4).
 * Two runners would spend quota twice and steal each other's leases.
 *
 * - Created with `wx` (O_CREAT|O_EXCL), atomic on all three OSes. Read between create and write, it is empty → "starting"
 * - Liveness: `process.kill(pid, 0)` — no error or EPERM = alive, ESRCH = dead (stale → reclaim)
 * - PIDs are reused, especially after a reboot. A lock whose startedAt predates this boot is treated as dead (`stop`
 *   must not kill that PID). The stop file carries the nonce so it never stops the wrong run
 * - Stopping: Windows cannot receive SIGTERM (it exits at once with no handler). So `stop` creates a stop file that the
 *   running start checks periodically and shuts down on its own; kill only if it doesn't end
 * - Resync: same approach. `reload` creates a request file; start **consumes** (deletes) it, resyncs, and writes
 *   progress and result to a result file. A later request overwrites an earlier one — since every resync reads the
 *   whole folder, the requester accepts any resync started after its request rather than matching an id
 */
import { randomBytes } from 'node:crypto';
import {
	existsSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync
} from 'node:fs';
import { uptime } from 'node:os';
import path from 'node:path';
import {
	BIN,
	CliError,
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_STALE_MS,
	RUNNER_LOCK_FILE,
	RUNNER_DELETED_FILE,
	RUNNER_RELOADED_FILE,
	RUNNER_RELOAD_FILE,
	RUNNER_STOP_FILE,
	SECRET_FILE_MODE,
	type ReceiveMode
} from '../domain/index.ts';
import { ensurePrivateDir, writeSecretFile } from '../secure-fs.ts';
import { sleep } from '../time.ts';

/** How long an empty lock file counts as "starting" — empty for longer means dead */
const STARTING_GRACE_MS = 10_000;
/** Tolerance for boot time (= now - uptime) — clock adjustment and rounding to seconds */
const BOOT_TOLERANCE_MS = 60_000;

/** Boot time of this session (epoch ms, approximate) */
export function bootTime(now = Date.now()): number {
	return now - uptime() * 1000;
}

export interface RunnerInfo extends LockedProcess {
	detached: boolean;
	/** Local server port. null if not opened */
	port: number | null;
	/** `--serve --public`. Absent in locks written by 0.2 and earlier */
	public?: boolean;
	/** Config pollIntervalMs — the actual interval is the larger of this and the server minimum. null for live (no interval) */
	intervalMs: number | null;
	/** Receive mode. Absent in locks written by 0.19 and earlier — read as poll (`runnerMode`) */
	mode?: ReceiveMode;
	/** Config concurrency — max tasks per pull. Absent in locks written by 0.12 and earlier */
	concurrency?: number;
	/** API URL this run uses. Absent in locks written by 0.2 and earlier — status compares it with the shell config */
	apiUrl?: string;
	/** Output file with --detach */
	outFile: string | null;
	/**
	 * workers folder this run reads (absolute path). Absent in locks written by 0.3 and earlier — lets status and
	 * worker delete, run from another folder, compare against the worker files actually running
	 */
	workersDir?: string;
	/** Accepts `reload`. Absent in locks written by 0.4 and earlier — no one would consume the request, so say so at once */
	reload?: boolean;
	/** Accepts local `worker delete` notices. Absent in locks written by 0.19 and earlier — that run learns on its next pull */
	localDelete?: boolean;
}

/** Receive mode of the running start — locks without `mode` (0.19 and earlier) are poll */
export function runnerMode(info: Pick<RunnerInfo, 'mode'>): ReceiveMode {
	return info.mode ?? 'poll';
}

/** Resync progress and result (`runner.reloaded`). The nonce tells which run wrote it */
export interface ReloadRecord<R = unknown> {
	nonce: string;
	state: 'running' | 'done';
	/** When the resync began reading worker files (epoch ms) — requests before this are covered by the result */
	startedAt: number;
	finishedAt?: number;
	result?: R;
}

export type RunnerState = LockState<RunnerInfo>;

export function lockPath(dataDir: string): string {
	return path.join(dataDir, RUNNER_LOCK_FILE);
}

export function stopPath(dataDir: string): string {
	return path.join(dataDir, RUNNER_STOP_FILE);
}

function reloadPath(dataDir: string): string {
	return path.join(dataDir, RUNNER_RELOAD_FILE);
}

function reloadedPath(dataDir: string): string {
	return path.join(dataDir, RUNNER_RELOADED_FILE);
}

function deletedPath(dataDir: string): string {
	return path.join(dataDir, RUNNER_DELETED_FILE);
}

interface DeletedRecord {
	nonce: string;
	names: string[];
}

function readDeleted(file: string): DeletedRecord | null {
	try {
		const v = JSON.parse(readFileSync(file, 'utf8')) as DeletedRecord;
		return typeof v?.nonce === 'string' && Array.isArray(v.names) ? v : null;
	} catch {
		return null;
	}
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** A resident process guarded by a lock file — start (runner.json) and dashboard (dashboard.json) share these rules */
export interface LockedProcess {
	pid: number;
	nonce: string;
	/** epoch ms */
	startedAt: number;
	/** The owner refreshes the lock mtime periodically. Absent in locks written by 0.10 and earlier — those are not judged by it (#1410) */
	heartbeat?: boolean;
}

export type LockState<T extends LockedProcess> =
	| { state: 'running'; info: T }
	| { state: 'starting' }
	| { state: 'stopped' };

/** Whether a start is running. A dead run's lock reads as stopped (not deleted) */
export function readRunner(dataDir: string): RunnerState {
	return readLockFile<RunnerInfo>(lockPath(dataDir));
}

/** Whether the lock file's owner is alive. A dead run's lock reads as stopped (not deleted) */
export function readLockFile<T extends LockedProcess>(file: string): LockState<T> {
	let text: string;
	try {
		text = readFileSync(file, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'stopped' };
		throw err;
	}
	if (text.trim() === '') {
		const age = Date.now() - statSync(file, { throwIfNoEntry: false })!.mtimeMs;
		return age < STARTING_GRACE_MS ? { state: 'starting' } : { state: 'stopped' };
	}
	let info: T;
	try {
		info = JSON.parse(text) as T;
	} catch {
		return { state: 'stopped' };
	}
	if (!Number.isInteger(info.pid) || !isAlive(info.pid)) return { state: 'stopped' };
	// A run started before this boot cannot be alive — the PID now belongs to another program
	if (!Number.isFinite(info.startedAt) || info.startedAt < bootTime() - BOOT_TOLERANCE_MS) {
		return { state: 'stopped' };
	}
	return { state: 'running', info };
}

/**
 * Creates the lock file atomically (`wx`) and writes it. Reclaims a dead run's lock once.
 * Throws the error from `busy(cause)` if a live owner holds it
 */
export function claimLockFile<T extends LockedProcess>(
	file: string,
	info: T,
	busy: (cause: unknown) => Error
): void {
	ensurePrivateDir(path.dirname(file));
	for (let attempt = 0; ; attempt++) {
		try {
			writeFileSync(file, '', { flag: 'wx', mode: SECRET_FILE_MODE });
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw busy(err);
			if (readLockFile(file).state !== 'stopped') throw busy(err);
			rmSync(file, { force: true }); // dead run's lock — reclaim
		}
	}
	writeFileSync(file, JSON.stringify(info), { mode: SECRET_FILE_MODE });
}

/** Deletes the lock if it belongs to this run (nonce) — never touches a lock another run reclaimed */
export function releaseLockFile(file: string, nonce: string): void {
	try {
		const current = JSON.parse(readFileSync(file, 'utf8')) as LockedProcess;
		if (current.nonce === nonce) rmSync(file, { force: true });
	} catch {
		// already gone
	}
}

/** Sets the lock mtime to now — the owner is alive. Failures are ignored (retried next cycle) */
export function touchLockFile(file: string): void {
	try {
		const now = new Date();
		utimesSync(file, now, now);
	} catch {
		// missing or not writable — `stop` makes the call
	}
}

/**
 * Whether the owner stopped its heartbeat — a heartbeat lock whose mtime is older than HEARTBEAT_STALE_MS.
 * A live pid may not own this lock (PID reuse within a boot), so `stop` does not kill it
 */
export function heartbeatStopped(file: string, info: LockedProcess, now = Date.now()): boolean {
	if (info.heartbeat !== true) return false;
	const stat = statSync(file, { throwIfNoEntry: false });
	return stat !== undefined && now - stat.mtimeMs > HEARTBEAT_STALE_MS;
}

/** Actually refreshes only once per HEARTBEAT_INTERVAL_MS — called from the 1 s watch loop */
export function heartbeater(file: string): () => void {
	let last = Date.now();
	return () => {
		const now = Date.now();
		if (now - last < HEARTBEAT_INTERVAL_MS) return;
		last = now;
		touchLockFile(file);
	};
}

/** Whether the stop file targets this run (nonce) */
export function stopFileMatches(file: string, nonce: string): boolean {
	try {
		return readFileSync(file, 'utf8').trim() === nonce;
	} catch {
		return false;
	}
}

/** If starting (lock taken, contents not yet written), waits briefly and reads again */
export async function readSettled<T extends LockedProcess>(
	read: () => LockState<T>
): Promise<LockState<T>> {
	const current = read();
	if (current.state !== 'starting') return current;
	await sleep(2_000);
	return read();
}

export interface RunnerLock {
	readonly info: RunnerInfo;
	/** Whether the stop file targets this run */
	stopRequested(): boolean;
	/** Consumes (deletes) a reload request and returns true if it targets this run. Left in place, it would rerun every check */
	takeReload(): boolean;
	/** Records resync progress and result */
	writeReload(record: Omit<ReloadRecord, 'nonce'>): void;
	/** Consumes names reported by `worker delete` — only those targeting this run. Empty array if none */
	takeDeleted(): string[];
	/** Liveness mark — safe to call every watch loop (refreshes once per HEARTBEAT_INTERVAL_MS) */
	heartbeat(): void;
	/** Safe to call twice. Never touches a lock another run reclaimed */
	release(): void;
}

export function acquireRunnerLock(
	dataDir: string,
	fields: Omit<RunnerInfo, 'pid' | 'nonce' | 'startedAt'>,
	now: number
): RunnerLock {
	const file = lockPath(dataDir);
	const info: RunnerInfo = {
		pid: process.pid,
		nonce: randomBytes(8).toString('hex'),
		startedAt: now,
		heartbeat: true,
		...fields
	};
	claimLockFile(file, info, (cause) => alreadyRunning(dataDir, cause));
	const beat = heartbeater(file);
	// A leftover stop request for a previous run would stop this one at once. Reload requests and results are stale too
	rmSync(stopPath(dataDir), { force: true });
	rmSync(reloadPath(dataDir), { force: true });
	rmSync(reloadedPath(dataDir), { force: true });
	rmSync(deletedPath(dataDir), { force: true });

	let released = false;
	return {
		info,
		stopRequested() {
			return stopFileMatches(stopPath(dataDir), info.nonce);
		},
		heartbeat: beat,
		takeReload() {
			let text: string;
			try {
				text = readFileSync(reloadPath(dataDir), 'utf8');
			} catch {
				return false;
			}
			rmSync(reloadPath(dataDir), { force: true });
			return text.trim() === info.nonce;
		},
		takeDeleted() {
			// Rename first, then read — so names `worker delete` merges in between read and delete are not lost.
			// Usually there is no file; skip the rename so it doesn't fail and throw every second
			if (!existsSync(deletedPath(dataDir))) return [];
			const taken = `${deletedPath(dataDir)}.${randomBytes(6).toString('hex')}.taking`;
			try {
				renameSync(deletedPath(dataDir), taken);
			} catch {
				return [];
			}
			const record = readDeleted(taken);
			rmSync(taken, { force: true });
			return record?.nonce === info.nonce ? record.names.filter((n) => typeof n === 'string') : [];
		},
		writeReload(record) {
			writeFileSync(reloadedPath(dataDir), JSON.stringify({ nonce: info.nonce, ...record }), {
				mode: SECRET_FILE_MODE
			});
		},
		release() {
			if (released) return;
			released = true;
			releaseLockFile(file, info.nonce);
			rmSync(stopPath(dataDir), { force: true });
			rmSync(reloadPath(dataDir), { force: true });
			rmSync(deletedPath(dataDir), { force: true });
			// Keep the result file — a resync that gets a stop code writes its result and exits at once; deleting it here
			// would show a waiting `reload` "start ended" instead of the result (exit 4/5). The nonce scopes it; the next start deletes it
		}
	};
}

/** Asks the running start to resync. Returns the request time — wait for a resync started after it */
export function requestReload(dataDir: string, info: RunnerInfo, now = Date.now()): number {
	writeFileSync(reloadPath(dataDir), info.nonce, { mode: SECRET_FILE_MODE });
	return now;
}

/**
 * Tells the running start about deleted workers (`worker delete`) — turned off on the next 1 s watch cycle. Merged with
 * names not yet consumed, so back-to-back deletes don't overwrite earlier names
 */
export function notifyDeleted(dataDir: string, info: RunnerInfo, names: string[]): void {
	const prev = readDeleted(deletedPath(dataDir));
	const merged = new Set(prev?.nonce === info.nonce ? prev.names : []);
	for (const n of names) merged.add(n);
	writeSecretFile(
		deletedPath(dataDir),
		JSON.stringify({ nonce: info.nonce, names: [...merged] } satisfies DeletedRecord)
	);
}

/** That run's resync record. null if missing or from another run */
export function readReload<R>(dataDir: string, info: RunnerInfo): ReloadRecord<R> | null {
	try {
		const record = JSON.parse(readFileSync(reloadedPath(dataDir), 'utf8')) as ReloadRecord<R>;
		return record.nonce === info.nonce ? record : null;
	} catch {
		return null;
	}
}

/** If starting (lock taken, contents not yet written), waits briefly and reads again — used by `stop` and `reload` */
export function readRunnerSettled(dataDir: string): Promise<RunnerState> {
	return readSettled(() => readRunner(dataDir));
}

/** Tells the running start to stop */
export function requestStop(dataDir: string, info: RunnerInfo): void {
	writeFileSync(stopPath(dataDir), info.nonce, { mode: SECRET_FILE_MODE });
}

function alreadyRunning(dataDir: string, cause: unknown): CliError {
	const current = readRunner(dataDir);
	if (current.state === 'running') {
		const where = current.info.detached ? 'in the background' : 'in another terminal';
		return new CliError(
			`3minapi is already running ${where} (pid ${current.info.pid}). Only one can run per host.\n` +
				`Stop it with '${BIN} stop' first.`
		);
	}
	if (current.state === 'starting') {
		return new CliError(
			`another '${BIN} start' is starting right now. Check with '${BIN} status'.`
		);
	}
	return new CliError(`cannot create ${lockPath(dataDir)}: ${(cause as Error).message}`);
}
