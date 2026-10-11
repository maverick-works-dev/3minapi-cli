/**
 * `worker delete <name>` — deletes this host's local worker on the server (with its task history) and its worker file.
 * See docs/design/14_cli_host.md §3-5 and docs/design/15_cli.md §4.
 *
 * Order is **server → file**. If the server call fails, the file stays and state remains consistent. A file left behind
 * would be re-registered by the next `start` sync, undoing the delete.
 *
 * A running `start` is not touched here — it sees the worker missing from the next pull's `workers`, deactivates it, and
 * exits if it was the last worker (#1377).
 */
import { rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { ApiError } from '../core/api.ts';
import {
	BIN,
	CliError,
	ExitCode,
	StopError,
	UsageError,
	WORKER_EXTENSIONS,
	type Command,
	type CommandContext,
	type Quota
} from '../core/domain/index.ts';
import { assertWorkerName } from '../core/names.ts';
import { confirm } from '../core/prompt.ts';
import { notifyDeleted, readRunner, type RunnerInfo } from '../core/host/runner-lock.ts';
import {
	clearStop,
	openSession,
	recordStop,
	rememberQuota,
	stopHint
} from '../core/host/session.ts';
import { formatCount } from '../core/text.ts';
import { ResultStore } from '../modules/workers/results/store.ts';
import { client, requireToken, workersPath } from './common.ts';

/**
 * Cap on repeat calls after `complete: false`. Each call deletes a bounded batch (docs/design/14_cli_host.md §3-5), so the
 * retained history (up to 91 days) finishes within it. Past the cap, stop and ask to re-run — the call is idempotent and resumes.
 */
const DELETE_MAX_ROUNDS = 500;

type ServerResult = { server: 'deleted'; quota: Quota | null } | { server: 'not_found' };

export const workerDelete: Command = {
	name: 'worker delete',
	summary: 'Delete a local worker and its task history from 3Min API, and remove its file',
	usage: '<worker> [--yes]',
	description:
		'Deletes the local worker of this host from 3Min API together with its task history (this\n' +
		'cannot be undone), then removes its file from the workers folder. Removing the file alone\n' +
		"leaves the worker on 3Min API, where AIs keep sending it tasks. A running 'start' on this PC\n" +
		'turns the worker off right away (no API call). Works when the quota is used up; one API call when\n' +
		'there is quota left. Asks for confirmation in a terminal; pass --yes otherwise.',
	options: {
		yes: { type: 'boolean', description: 'Delete without asking for confirmation' }
	},
	args: { min: 1, max: 1 },
	async run(ctx) {
		const { out } = ctx;
		const name = ctx.positionals[0];
		assertWorkerName(name);
		const token = requireToken(ctx);
		const { files, runner } = localFiles(ctx, name);

		if (!ctx.values.yes) {
			if (out.json || !ctx.stdin.isTTY) {
				throw new UsageError(
					`deleting a worker removes its task history and cannot be undone. Nothing was deleted. Once the user has agreed, run: ${BIN} worker delete ${name} --yes`
				);
			}
			const also =
				files.length > 0 ? `, and remove ${files.map((f) => shown(ctx, f)).join(', ')}` : '';
			const yes = await confirm(
				ctx.stdin,
				out,
				`Delete local worker "${name}" and its task history from 3Min API${also}? This cannot be undone.`
			);
			if (!yes) throw new CliError('cancelled — nothing was deleted.');
		}

		const result = await deleteOnServer(ctx, token.token, name);
		if (result.server === 'not_found' && files.length === 0) {
			throw new CliError(
				`no local worker "${name}" on this host, and no file for it here. '${BIN} status' lists the workers 3Min API has for this host.`
			);
		}

		const failed: string[] = [];
		for (const file of files) {
			try {
				rmSync(file);
			} catch (err) {
				failed.push(`${file}: ${(err as Error).message}`);
			}
		}
		const removed = files.filter((f) => !failed.some((line) => line.startsWith(`${f}:`)));
		const quota = result.server === 'deleted' ? result.quota : null;

		const lines: string[] = [];
		if (result.server === 'deleted') {
			lines.push(`Deleted local worker "${name}" and its task history from 3Min API.`);
		} else {
			lines.push(`"${name}" was not a local worker on this host — nothing to delete on 3Min API.`);
		}
		if (removed.length > 0) lines.push(`Removed ${removed.map((f) => shown(ctx, f)).join(', ')}.`);
		else if (files.length === 0) lines.push('No local file for it was found here.');
		// Nothing to do for a running start, but tell the user here — if it was the last worker, start exits.
		// Only when the file was in that start's folder — a worker with no file (server-only orphan) was never active there.
		// Runner state is read once before deleting — a read failure after the irreversible delete would hide the result
		if (result.server === 'deleted' && runner && files.length > 0) {
			lines.push(
				tellRunner(ctx, runner, name)
					? `'${BIN} start' is running: it turns "${name}" off now, and stops if no other worker is left. No restart needed.`
					: `'${BIN} start' is running: it turns "${name}" off on its next fetch, and stops if no other worker is left. No restart needed.`
			);
		}
		if (quota)
			lines.push(
				`quota    ${formatCount(quota.remaining)} of ${formatCount(quota.limit)} calls left`
			);
		// Saved results on this PC (data.db) are not deleted — they are the user's data (docs/design/15_cli.md §8-5)
		const kept = savedResultCount(ctx, name);
		if (kept > 0) {
			lines.push(
				`${formatCount(kept)} saved result(s) of "${name}" stay in data.db — ` +
					`'${BIN} worker results prune --worker ${name} --before <date>' deletes them.`
			);
		}

		out.result({ name, server: result.server, files: removed, quota }, lines.join('\n'));
		if (failed.length > 0) {
			throw new CliError(
				`could not remove the worker file — delete it yourself, or the next '${BIN} start' registers it again:\n` +
					failed.map((line) => `  ${line}`).join('\n')
			);
		}
		return ExitCode.Ok;
	}
};

/** Number of that worker's results left in this project's data.db — 0 if unreadable (the hint is skipped) */
function savedResultCount(ctx: CommandContext, name: string): number {
	try {
		const root = ctx.loadConfig().projectRoot;
		const store = root ? ResultStore.openReadOnly(root) : null;
		if (!store) return 0;
		try {
			return store.usage({ worker: name }).count;
		} finally {
			store.close();
		}
	} catch {
		return 0;
	}
}

/** Server delete — repeats until `complete: true`. Only 404 `worker_not_found` means "not on the server" */
async function deleteOnServer(
	ctx: CommandContext,
	token: string,
	name: string
): Promise<ServerResult> {
	const session = openSession(ctx);
	try {
		const api = client(ctx, session, token);
		for (let round = 0; round < DELETE_MAX_ROUNDS; round += 1) {
			let res;
			try {
				res = await api.deleteWorker(name);
			} catch (err) {
				if (err instanceof StopError) {
					recordStop(session, err, ctx.now());
					throw new StopError(err.reason, `${err.message}\n${stopHint(err.reason)}`, err.resetAt);
				}
				// A 404 without code means something else (no route, edge) — fail so the file is kept
				if (err instanceof ApiError && err.code === 'worker_not_found') {
					clearStop(session);
					// If an earlier call was mid-delete, another run finished it
					return round === 0 ? { server: 'not_found' } : { server: 'deleted', quota: null };
				}
				throw err;
			}
			clearStop(session);
			rememberQuota(session, res.quota, ctx.now());
			if (res.complete) return { server: 'deleted', quota: res.quota };
			if (round === 0)
				ctx.out.info(`deleting the task history of "${name}" — this can take a while…`);
		}
	} finally {
		session.close();
	}
	throw new CliError(
		`the task history of "${name}" is still being deleted. Run '${BIN} worker delete ${name} --yes' again to continue.`
	);
}

/**
 * All files with this name in the workers folder (.js, .mjs, .ts, .mts). With a running `start`, looks in **the folder it reads** —
 * deleting from another project's folder would remove only the server side; the live file stays and the next start re-registers it.
 * None outside a project or without a folder. `runnerFolder` = found in the running start's folder (its run info has one)
 */
function localFiles(
	ctx: CommandContext,
	name: string
): { files: string[]; runner: RunnerInfo | null } {
	const state = readRunner(ctx.dirs.data);
	const runner = state.state === 'running' && state.info.workersDir ? state.info : null;
	let dir: string;
	if (runner) {
		dir = runner.workersDir!;
	} else {
		const config = ctx.loadConfig();
		if (!config.projectRoot) return { files: [], runner };
		dir = workersPath(config.projectRoot, config);
	}
	const files = WORKER_EXTENSIONS.map((ext) => path.join(dir, name + ext)).filter((f) =>
		statSync(f, { throwIfNoEntry: false })?.isFile()
	);
	return { files, runner };
}

/**
 * Notifies a running start of the deleted worker so it turns it off without a server call — in live mode pulls are rare, so
 * the server list would take long to show it. false for runs that can't receive it (0.19 and earlier) or on write failure (#1462)
 */
function tellRunner(ctx: CommandContext, runner: RunnerInfo, name: string): boolean {
	if (!runner.localDelete) return false;
	try {
		notifyDeleted(ctx.dirs.data, runner, [name]);
		return true;
	} catch {
		return false;
	}
}

function shown(ctx: CommandContext, file: string): string {
	const rel = path.relative(ctx.cwd, file);
	return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
}
