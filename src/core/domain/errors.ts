/**
 * Process exit codes and CLI errors — docs/design/15_cli.md §4 is authoritative.
 *
 * Three kinds of error code, distinguished by name:
 *   - `ExitCode`        process exit code (here)
 *   - `ServerErrorCode` `code` in a server response body (contract.ts)
 *   - `StopReason`      stop reason stored in the control DB (types.ts)
 *
 * Small numbers only, to avoid sysexits (64–78).
 */
import type { StopReason } from './types.ts';

export const ExitCode = {
	Ok: 0,
	/** General failure */
	Failure: 1,
	/** Usage error — unknown command, bad flag, invalid name */
	Usage: 2,
	/** Environment or config error — Node too old, bad config file, failed doctor check */
	Environment: 3,
	/** Auth stop — host_token_invalid / no_subscription (docs/design/14_cli_host.md §6-3). No auto resume */
	AuthStopped: 4,
	/** Quota stop — quota_exhausted (docs/design/14_cli_host.md §6-3). No auto resume */
	QuotaStopped: 5,
	/** Update required — cli_outdated (docs/design/14_cli_host.md §6-5). The server no longer accepts this version; only an update clears it */
	UpdateRequired: 6,
	/** Ctrl+C. On Windows, Node emulates SIGINT too */
	Interrupted: 130
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** An error the user can fix. Prints only the message to stderr and exits with the code (no stack). */
export class CliError extends Error {
	readonly exitCode: ExitCode;

	constructor(message: string, exitCode: ExitCode = ExitCode.Failure) {
		super(message);
		this.name = 'CliError';
		this.exitCode = exitCode;
	}
}

export class UsageError extends CliError {
	constructor(message: string) {
		super(message, ExitCode.Usage);
		this.name = 'UsageError';
	}
}

export class ConfigError extends CliError {
	constructor(message: string) {
		super(message, ExitCode.Environment);
		this.name = 'ConfigError';
	}
}

/**
 * The control DB schema was created by a newer CLI — a sure sign this CLI is outdated. Exit 3, like ConfigError.
 * Kept apart from other open failures (locked, permission, corrupt) so `doctor` suggests updating only when it helps
 */
export class NewerSchemaError extends ConfigError {
	constructor(file: string, found: number, known: number) {
		super(
			`${file} was created by a newer version of 3minapi (schema ${found}, this CLI knows ${known}). ` +
				'Update 3minapi.'
		);
		this.name = 'NewerSchemaError';
	}
}

/** Stop reason → exit code — auth 4, quota 5, update required 6 (docs/design/15_cli.md §4) */
function stopExitCode(reason: StopReason): ExitCode {
	switch (reason) {
		case 'quota_exhausted':
			return ExitCode.QuotaStopped;
		case 'cli_outdated':
			return ExitCode.UpdateRequired;
		default:
			return ExitCode.AuthStopped;
	}
}

/**
 * The server sent a stop code (docs/design/14_cli_host.md §6-3) — all calls stop. No auto resume.
 * A stop is decided only by the JSON body `code`, never by status code alone (§6-2).
 */
export class StopError extends CliError {
	readonly reason: StopReason;
	/** Reset time for quota_exhausted (ISO 8601 UTC). Not in the error body; the caller fills it from the last successful response's quota.reset_at */
	readonly resetAt: string | undefined;

	constructor(reason: StopReason, message: string, resetAt?: string) {
		super(message, stopExitCode(reason));
		this.name = 'StopError';
		this.reason = reason;
		this.resetAt = resetAt;
	}
}
