/**
 * One dashboard per host — the `<data>/dashboard.json` lock (docs/design/15_cli.md §9-6).
 *
 * Same rules as start's runner.json (`wx` create, stale-lock reclaim, boot time, stop file — core/host/runner-lock.ts).
 * Both foreground and detached runs take it, so `status`, `dashboard url` and `dashboard stop` see the same run either way.
 *
 * No token in the lock — `status --json` prints the lock as is. The tokenized link lives in a separate 0600 file
 * (`dashboard.link`), read only by `dashboard url`.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
	BIN,
	CliError,
	DASHBOARD_LINK_FILE,
	DASHBOARD_LOCK_FILE,
	DASHBOARD_STOP_FILE,
	SECRET_FILE_MODE
} from '../../core/domain/index.ts';
import {
	claimLockFile,
	heartbeater,
	readLockFile,
	readSettled,
	releaseLockFile,
	stopFileMatches,
	type LockedProcess,
	type LockState
} from '../../core/host/runner-lock.ts';
import { writeSecretFile } from '../../core/secure-fs.ts';

export interface DashboardInfo extends LockedProcess {
	detached: boolean;
	/** Open to the local network (`--lan`) */
	lan: boolean;
	/** null before listen — the lock is taken before the port opens */
	port: number | null;
	/** URLs without token. First is this PC (127.0.0.1), the rest LAN */
	origins: string[];
	/** Output file with --detach */
	outFile: string | null;
}

export type DashboardState = LockState<DashboardInfo>;

/** Link file — the nonce tells whether it belongs to that run */
interface LinkRecord {
	nonce: string;
	/** Token link for this PC (127.0.0.1) */
	url: string;
	/** Token link for other devices (LAN) */
	lanUrls: string[];
}

export interface DashboardLinks {
	url: string;
	lanUrls: string[];
}

export function dashboardLockPath(dataDir: string): string {
	return path.join(dataDir, DASHBOARD_LOCK_FILE);
}

function stopPath(dataDir: string): string {
	return path.join(dataDir, DASHBOARD_STOP_FILE);
}

function linkPath(dataDir: string): string {
	return path.join(dataDir, DASHBOARD_LINK_FILE);
}

export function readDashboard(dataDir: string): DashboardState {
	return readLockFile<DashboardInfo>(dashboardLockPath(dataDir));
}

export function readDashboardSettled(dataDir: string): Promise<DashboardState> {
	return readSettled(() => readDashboard(dataDir));
}

export interface DashboardLock {
	readonly info: DashboardInfo;
	/** After listen — writes port and URLs to the lock, token links to the link file */
	listening(links: DashboardLinks & { port: number; origins: string[] }): void;
	stopRequested(): boolean;
	/** Liveness mark — safe to call on every watch-loop tick */
	heartbeat(): void;
	/** Idempotent. Leaves a lock reclaimed by another run untouched */
	release(): void;
}

export function acquireDashboardLock(
	dataDir: string,
	fields: Pick<DashboardInfo, 'detached' | 'lan' | 'outFile'>,
	now: number
): DashboardLock {
	const file = dashboardLockPath(dataDir);
	let info: DashboardInfo = {
		pid: process.pid,
		nonce: randomBytes(8).toString('hex'),
		startedAt: now,
		heartbeat: true,
		port: null,
		origins: [],
		...fields
	};
	claimLockFile(file, info, (cause) => alreadyRunning(dataDir, cause));
	const beat = heartbeater(file);
	// Remove a leftover stop request or link from a previous run — that link holds a dead token
	rmSync(stopPath(dataDir), { force: true });
	rmSync(linkPath(dataDir), { force: true });

	let released = false;
	return {
		get info() {
			return info;
		},
		listening({ url, lanUrls, port, origins }) {
			const record: LinkRecord = { nonce: info.nonce, url, lanUrls };
			writeSecretFile(linkPath(dataDir), JSON.stringify(record));
			info = { ...info, port, origins };
			// Atomic replace — so a reader (status) never sees half-written JSON as a "stale lock"
			writeSecretFile(file, JSON.stringify(info));
		},
		stopRequested() {
			return stopFileMatches(stopPath(dataDir), info.nonce);
		},
		heartbeat: beat,
		release() {
			if (released) return;
			released = true;
			releaseLockFile(file, info.nonce);
			rmSync(stopPath(dataDir), { force: true });
			try {
				const record = JSON.parse(readFileSync(linkPath(dataDir), 'utf8')) as LinkRecord;
				if (record.nonce === info.nonce) rmSync(linkPath(dataDir), { force: true });
			} catch {
				// already gone
			}
		}
	};
}

/** That run's token links. null if missing or from another run */
export function readDashboardLinks(dataDir: string, info: DashboardInfo): DashboardLinks | null {
	try {
		const record = JSON.parse(readFileSync(linkPath(dataDir), 'utf8')) as LinkRecord;
		if (record.nonce !== info.nonce || typeof record.url !== 'string') return null;
		return { url: record.url, lanUrls: Array.isArray(record.lanUrls) ? record.lanUrls : [] };
	} catch {
		return null;
	}
}

/** Asks the running dashboard to stop */
export function requestDashboardStop(dataDir: string, info: DashboardInfo): void {
	writeFileSync(stopPath(dataDir), info.nonce, { mode: SECRET_FILE_MODE });
}

function alreadyRunning(dataDir: string, cause: unknown): CliError {
	const current = readDashboard(dataDir);
	if (current.state === 'running') {
		const where = current.info.detached ? 'in the background' : 'in another terminal';
		return new CliError(
			`the dashboard is already running ${where} (pid ${current.info.pid}). Only one can run per host.\n` +
				`Open it with '${BIN} dashboard url', or stop it with '${BIN} dashboard stop' first.`
		);
	}
	if (current.state === 'starting') {
		return new CliError(`another '${BIN} dashboard' is starting right now.`);
	}
	return new CliError(`cannot create ${dashboardLockPath(dataDir)}: ${(cause as Error).message}`);
}
