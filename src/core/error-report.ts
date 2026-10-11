/**
 * Errors that reach the top level → a human message + the `--json` error document (docs/design/15_cli.md §4 output contract).
 *
 *   { "error": { "kind", "message", "exitCode", "code"?, "resetAt"? } }
 *
 * kind tells the sources apart — if one code mixed stop codes, server error codes and errnos, an AI would have to guess from the string's shape.
 * Expected file system errors (permission, read-only, disk full) and SQLite write failures are reported as actionable messages, not CLI bugs (exit 3).
 */
import { ApiError } from './api.ts';
import { BIN, CliError, ConfigError, ExitCode, StopError, UsageError } from './domain/index.ts';

export type ErrorKind =
	| 'usage'
	| 'config'
	| 'stop'
	| 'server'
	| 'network'
	| 'fs'
	| 'failure'
	| 'bug';

export interface ErrorReport {
	kind: ErrorKind;
	/** Message for stderr (may span lines). Same as the JSON document's message */
	message: string;
	exitCode: ExitCode;
	code?: string;
	resetAt?: string;
	/** Bugs only — written to stderr only */
	stack?: string;
}

/** Appended only when a network error with no response reaches the top level — not to the poller's repeated warnings */
const NETWORK_HINT = `Check the network, or run '${BIN} doctor' (it checks the API URL and proxy settings).`;

export function describeError(err: unknown): ErrorReport {
	if (err instanceof StopError) {
		return {
			kind: 'stop',
			message: err.message,
			exitCode: err.exitCode,
			code: err.reason,
			...(err.resetAt ? { resetAt: err.resetAt } : {})
		};
	}
	if (err instanceof ApiError) {
		if (err.status === null) {
			return {
				kind: 'network',
				message: `${err.message}\n${NETWORK_HINT}`,
				exitCode: err.exitCode
			};
		}
		return {
			kind: 'server',
			message: err.message,
			exitCode: err.exitCode,
			...(err.code ? { code: err.code } : {})
		};
	}
	if (err instanceof UsageError)
		return { kind: 'usage', message: err.message, exitCode: err.exitCode };
	if (err instanceof ConfigError)
		return { kind: 'config', message: err.message, exitCode: err.exitCode };
	if (err instanceof CliError)
		return { kind: 'failure', message: err.message, exitCode: err.exitCode };

	const fs = fsFailure(err);
	if (fs) return fs;

	const e = err as Error | undefined;
	return {
		kind: 'bug',
		message: `unexpected error: ${firstLine(e?.message ?? String(err))}`,
		exitCode: ExitCode.Failure,
		stack: e?.stack ?? String(err)
	};
}

/** errno → cause · action. Only errors with a path (`err.path`) — without a path there is nothing to tell the user to fix */
const ERRNO: Record<string, string> = {
	EACCES: 'permission denied — check the owner and permissions of that folder or file',
	EPERM:
		'operation not permitted — check the permissions, or close a program holding it (antivirus, indexer)',
	EROFS: 'the file system is read-only — run it in a folder you can write to',
	ENOSPC: `the disk is full — free some space (logs: logMaxBytes, results: '${BIN} worker results prune', history: '${BIN} tasks prune')`,
	EDQUOT: 'the disk quota is used up — free some space',
	EBUSY: 'it is in use by another program — close it and try again',
	EMFILE: 'too many open files — close some programs and try again',
	ENFILE: 'too many open files — close some programs and try again',
	ENOTDIR: 'a part of the path is a file, not a folder — check the path',
	EISDIR: 'it is a folder, not a file — check the path',
	ENOENT: 'it does not exist — check the path',
	EEXIST: 'it already exists — check the path'
};

/** SQLite result code → name · cause. Write failures while running (open failures are already wrapped by ControlDb) */
const SQLITE: Record<number, [string, string]> = {
	5: ['SQLITE_BUSY', 'the database is locked by another program — close it and try again'],
	8: ['SQLITE_READONLY', 'the database file is read-only — check its permissions'],
	13: ['SQLITE_FULL', 'the disk is full — free some space'],
	14: [
		'SQLITE_CANTOPEN',
		'the database file cannot be opened — check the folder and its permissions'
	]
};

function fsFailure(err: unknown): ErrorReport | null {
	const e = err as (NodeJS.ErrnoException & { errcode?: number; errstr?: string }) | null;
	if (!e || typeof e !== 'object') return null;
	if (e.code === 'ERR_SQLITE_ERROR' && typeof e.errcode === 'number') {
		// The low 8 bits of an extended result code (e.g. 1555) are the primary code
		const known = SQLITE[e.errcode & 0xff];
		if (!known) return null;
		return {
			kind: 'fs',
			message: `${firstLine(e.message)}: ${known[1]}`,
			exitCode: ExitCode.Environment,
			code: known[0]
		};
	}
	if (typeof e.code !== 'string' || typeof e.path !== 'string') return null;
	const reason = ERRNO[e.code];
	if (!reason) return null;
	const action = typeof e.syscall === 'string' ? e.syscall : 'use';
	return {
		kind: 'fs',
		message: `cannot ${action} ${e.path}: ${reason}`,
		exitCode: ExitCode.Environment,
		code: e.code
	};
}

function firstLine(text: string): string {
	return text.split('\n')[0];
}

/** The `--json` error document */
export function errorDocument(report: ErrorReport): { error: Omit<ErrorReport, 'stack'> } {
	const { stack: _stack, ...error } = report;
	return { error };
}
