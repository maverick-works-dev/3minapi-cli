/**
 * stop — ends a running start (docs/design/15_cli.md §4).
 */
import { existsSync, rmSync } from 'node:fs';
import {
	CliError,
	ExitCode,
	STOP_WAIT_MS,
	type Command,
	type CommandContext
} from '../core/domain/index.ts';
import {
	isAlive,
	lockPath,
	readRunner,
	readRunnerSettled,
	heartbeatStopped,
	requestStop,
	type LockedProcess,
	type LockState
} from '../core/host/runner-lock.ts';
import { sleep } from '../core/time.ts';

// Ends a start launched in the background (--detach). A forgotten poller uses quota on empty polls alone (docs/design/15_cli.md §4)
export const stop: Command = {
	name: 'stop',
	summary: "Stop this host's running 'start' (background or another terminal)",
	usage: '',
	description:
		'Asks the running start to finish — the whole host process, whatever it runs: running\n' +
		'tasks are cancelled and reported as failed.\n' +
		`If it has not exited after ${STOP_WAIT_MS / 1000}s it is killed.`,
	options: {},
	args: { min: 0, max: 0 },
	run(ctx) {
		return stopLocked(ctx, {
			read: () => readRunner(ctx.dirs.data),
			readSettled: () => readRunnerSettled(ctx.dirs.data),
			requestStop: (info) => requestStop(ctx.dirs.data, info),
			lockFile: lockPath(ctx.dirs.data)
		});
	}
};

/**
 * Ends a lock-guarded resident process — requests via the stop file, waits for the lock to release, force-kills if it doesn't.
 * Shared by `stop` (start) and `dashboard stop`
 */
export async function stopLocked<T extends LockedProcess>(
	ctx: CommandContext,
	target: {
		read(): LockState<T>;
		readSettled(): Promise<LockState<T>>;
		requestStop(info: T): void;
		lockFile: string;
	}
): Promise<ExitCode> {
	const { out } = ctx;
	const current = await target.readSettled();
	if (current.state !== 'running') {
		out.result({ stopped: false, running: false }, 'Not running.');
		return ExitCode.Ok;
	}
	const { info } = current;
	target.requestStop(info);
	out.info(`stopping pid ${info.pid}...`);

	const deadline = Date.now() + STOP_WAIT_MS;
	while (Date.now() < deadline && isAlive(info.pid) && existsSync(target.lockFile)) {
		await sleep(200);
	}
	let forced = false;
	if (
		isAlive(info.pid) &&
		target.read().state === 'running' &&
		heartbeatStopped(target.lockFile, info)
	) {
		// The lock owner stopped its heartbeat — the pid may now belong to another program that reused it (#1410).
		// Remove the lock without killing. Locks written by 0.10 and earlier (no heartbeat) go to the force kill below
		rmSync(target.lockFile, { force: true });
		out.result(
			{ stopped: true, pid: info.pid, forced: false, killed: false },
			`pid ${info.pid} has not updated this lock for a while — it may be another program that reused the pid. ` +
				'It was not killed; the stale lock was removed.'
		);
		return ExitCode.Ok;
	}
	if (isAlive(info.pid) && target.read().state === 'running') {
		// No graceful exit — force it
		forced = true;
		if (!(await forceKill(info.pid))) {
			throw new CliError(
				`pid ${info.pid} did not stop and could not be killed. Stop it from the OS (Activity Monitor / Task Manager / kill -9).`
			);
		}
		rmSync(target.lockFile, { force: true });
	}
	out.result(
		{ stopped: true, pid: info.pid, forced },
		forced ? `Killed pid ${info.pid} (it did not stop in time).` : `Stopped pid ${info.pid}.`
	);
	return ExitCode.Ok;
}

/**
 * Force kill. SIGKILL on POSIX — a running start handles SIGTERM itself (graceful exit), which would be ignored if already exiting.
 * On Windows any signal name terminates immediately (TerminateProcess). true if it died
 */
export async function forceKill(pid: number): Promise<boolean> {
	try {
		process.kill(pid, process.platform === 'win32' ? undefined : 'SIGKILL');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true;
		return false;
	}
	for (let i = 0; i < 20 && isAlive(pid); i++) await sleep(100);
	return !isAlive(pid);
}
