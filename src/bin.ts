#!/usr/bin/env node
/**
 * Entry point. Order matters:
 *   1. Node version check — shows how to fix an old Node instead of an import error (e.g. node:sqlite)
 *   2. node:sqlite ExperimentalWarning filter — before any module that imports sqlite
 *   3. net defaults (Happy Eyeballs attempt timeout) — before the CLI's own API calls
 *   4. only then dynamic-import the CLI itself
 * So this file statically imports nothing besides domain/constants.ts, version.ts, warnings.ts and network.ts.
 */
import { EXIT_GRACE_MS, MIN_NODE_VERSION } from './core/domain/constants.ts';
import { raiseConnectAttemptTimeout } from './core/network.ts';
import { satisfiesMinNode } from './core/version.ts';
import { suppressSqliteExperimentalWarning } from './core/warnings.ts';

if (!satisfiesMinNode(process.versions.node)) {
	const message =
		`3minapi requires Node.js ${MIN_NODE_VERSION} or later (you have ${process.versions.node}).\n` +
		'Install the current Node.js 24 LTS from https://nodejs.org and try again.';
	process.stderr.write(`error: ${message}\n`);
	// With `--json`, emit the same error document (docs/design/15_cli.md §4) — written by hand since the CLI is not imported yet
	if (process.argv.includes('--json'))
		process.stdout.write(
			JSON.stringify({ error: { kind: 'config', message, exitCode: 3 } }, null, 2) + '\n'
		);
	process.exit(3);
}

suppressSqliteExperimentalWarning();
raiseConnectAttemptTimeout({ execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS });

// Ctrl+C — Node emulates SIGINT on Windows too. By default exit 130 immediately.
// Commands that need cleanup (start, worker run, dashboard, worker results query) take the first signal as an abort via claimInterrupt(); a second signal force-exits.
const interrupt = new AbortController();
let claimed = false;
const onSignal = () => {
	if (claimed && !interrupt.signal.aborted) interrupt.abort();
	else process.exit(130);
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
// SIGHUP is not handled — a listener would override the "ignore" inherited under `nohup 3minapi start &` and stop the process when the terminal closes (docs/design/15_cli.md §4, #1410)

// The reader closed first (`3minapi logs | head`) — exit quietly instead of printing a stack. Exit 0 so `| head`
// does not count as a failure in `set -o pipefail` scripts (#1410)
for (const stream of [process.stdout, process.stderr]) {
	stream.on('error', (err: NodeJS.ErrnoException) => {
		if (err.code === 'EPIPE') process.exit(0);
		throw err;
	});
}

const { main } = await import('./cli.ts');
process.exitCode = await main(process.argv.slice(2), {
	stdout: process.stdout,
	stderr: process.stderr,
	stdin: process.stdin,
	env: process.env,
	cwd: process.cwd(),
	platform: process.platform,
	home: (await import('node:os')).homedir(),
	signal: interrupt.signal,
	claimInterrupt: () => {
		claimed = true;
	}
});

// If the event loop is still alive after the command finishes, exit shortly after — a live WebSocket that sent a close to a vanished peer
// holds the loop until TCP closes (undici, #1462). The timer is unref'd, so it never delays a normal exit.
// Wait while output is still flushing — pipe output on macOS and Windows is async (`logs | less`), so exiting early truncates it
const exitWhenFlushed = (): void => {
	if (process.stdout.writableLength > 0 || process.stderr.writableLength > 0) {
		setTimeout(exitWhenFlushed, EXIT_GRACE_MS).unref();
		return;
	}
	process.exit();
};
setTimeout(exitWhenFlushed, EXIT_GRACE_MS).unref();
