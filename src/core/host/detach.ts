/**
 * Shared detached-run (`--detach`) code for `start` and `dashboard` (docs/design/15_cli.md §4).
 * The child re-runs the same CLI with `ENV.detached=1` and writes its output to a file in the logs folder.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV, OUT_FILE_MAX_BYTES, SECRET_FILE_MODE } from '../domain/index.ts';
import { ensurePrivateDir } from '../secure-fs.ts';

/** Runs the same CLI detached. The output file is appended to */
export function spawnDetached(opts: {
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv | Record<string, string | undefined>;
	outFile: string;
}): ChildProcess {
	ensurePrivateDir(path.dirname(opts.outFile));
	rotateIfLarge(opts.outFile);
	const fd = openSync(opts.outFile, 'a', SECRET_FILE_MODE);
	try {
		return spawn(process.execPath, [...proxyNodeArgs(), binPath(), ...opts.args], {
			cwd: opts.cwd,
			env: { ...opts.env, [ENV.detached]: '1' },
			detached: true,
			stdio: ['ignore', fd, fd],
			// Windows: detached opens a new console window — hide it
			windowsHide: true
		});
	} finally {
		closeSync(fd);
	}
}

/**
 * Output file cap — log pruning (dated .jsonl) skips this file, so appending on every detached run grows it forever.
 * Past OUT_FILE_MAX_BYTES on open, keeps one `<name>.1`. A failure never blocks the run (#1410)
 */
export function rotateIfLarge(file: string): void {
	try {
		const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
		if (size <= OUT_FILE_MAX_BYTES) return;
		rmSync(`${file}.1`, { force: true });
		renameSync(file, `${file}.1`);
	} catch {
		// keep appending
	}
}

/** Works for both the build (dist/*.js) and the source (src/*.ts) */
function binPath(): string {
	return fileURLToPath(
		new URL(import.meta.url.endsWith('.ts') ? '../../bin.ts' : '../../bin.js', import.meta.url)
	);
}

/** Tail of the output file — shows why the child failed to start */
export function outputTail(file: string): string {
	try {
		const text = readFileSync(file, 'utf8').trimEnd().split('\n').slice(-10).join('\n');
		return text ? `Last output (${file}):\n${text}` : `See ${file}`;
	} catch {
		return `See ${file}`;
	}
}

/**
 * A proxy enabled by Node flag (`node --use-env-proxy`) is not inherited by the child, unlike env vars — pass just that
 * flag so detached runs use the same route (live WebSocket and API calls). `NODE_USE_ENV_PROXY=1` already passes via env
 */
function proxyNodeArgs(): string[] {
	return process.execArgv.filter((a) => a === '--use-env-proxy');
}
