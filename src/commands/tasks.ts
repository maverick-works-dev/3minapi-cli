/**
 * `tasks` group — this host's task run history (control DB `tasks`) (docs/design/15_cli.md §4, §7-2).
 *
 * The control DB is never auto-pruned — so run details (duration, retries, cancel, failure reason) don't vanish while results
 * (data.db) remain. Only this command deletes, like `worker results prune` (count and size first, confirm, `--yes` for non-TTY/`--json`).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ControlDb, type TaskPruneFilter } from '../core/control-db.ts';
import {
	BIN,
	CONTROL_DB_FILE,
	CliError,
	ExitCode,
	TASKS_PRUNE_MIN_AGE_MS,
	UsageError,
	type Command
} from '../core/domain/index.ts';
import { assertWorkerName } from '../core/names.ts';
import { confirm } from '../core/prompt.ts';
import { formatBytes, formatCount } from '../core/text.ts';
import { formatLocal, parseDateArg } from '../core/time.ts';

export const tasksPrune: Command = {
	name: 'tasks prune',
	summary: 'Delete the run history of tasks that finished before a date',
	usage: '--before <date> [--worker <name>] [--yes]',
	description:
		"Deletes this host's task records — when each task ran, retries, cancellations and why it\n" +
		'failed. Nothing is deleted automatically otherwise. Tasks still waiting or running, and tasks\n' +
		'that finished in the last 24 hours, are kept: those records stop a task from running twice\n' +
		'when it is delivered again. Saved results in data.db are not touched (worker results prune).\n' +
		'Shows how many first and asks to confirm. The file does not shrink; new records reuse the space.',
	options: {
		before: {
			type: 'string',
			valueName: 'date',
			description:
				'Delete tasks that finished before this time — YYYY-MM-DD (local midnight) or ISO 8601'
		},
		worker: { type: 'string', valueName: 'name', description: 'Only this worker' },
		yes: { type: 'boolean', description: 'Delete without asking for confirmation' }
	},
	args: { min: 0, max: 0 },
	async run(ctx) {
		const { out, values } = ctx;
		if (typeof values.before !== 'string') {
			throw new UsageError(`--before is required.\nusage: ${BIN} tasks prune --before <date>`);
		}
		const before = parseDateArg(values.before);
		if (before === null) {
			throw new UsageError(
				`--before "${values.before}" is not a date. Use YYYY-MM-DD (local midnight) or ISO 8601 like 2026-10-01T09:00.`
			);
		}
		const filter: TaskPruneFilter = { before };
		if (typeof values.worker === 'string') {
			assertWorkerName(values.worker);
			filter.worker = values.worker;
		}
		// Don't create a missing control DB
		if (!existsSync(path.join(ctx.dirs.data, CONTROL_DB_FILE))) {
			out.result({ deleted: 0, bytes: 0, kept: 0 }, 'Nothing to delete.');
			return ExitCode.Ok;
		}
		const db = ControlDb.open(ctx.dirs.data);
		try {
			const now = ctx.now();
			const target = db.pruneUsage(filter, now);
			const keptNote =
				target.recent > 0
					? `${formatCount(target.recent)} task(s) that finished in the last 24 hours are kept.`
					: null;
			if (target.count === 0) {
				out.result(
					{ deleted: 0, bytes: 0, kept: target.recent },
					['Nothing to delete.', ...(keptNote ? [keptNote] : [])].join('\n')
				);
				return ExitCode.Ok;
			}
			const what = `the run history of ${formatCount(target.count)} finished task(s) (about ${formatBytes(target.bytes)})${
				filter.worker ? ` of ${filter.worker}` : ''
			} from before ${formatLocal(Math.min(before, now - TASKS_PRUNE_MIN_AGE_MS))}`;
			if (!values.yes) {
				if (out.json || !ctx.stdin.isTTY) {
					throw new UsageError(
						`this deletes ${what} and cannot be undone.${keptNote ? ` ${keptNote}` : ''} ` +
							'Nothing was deleted. Once the user has agreed, run it again with --yes.'
					);
				}
				if (keptNote) out.info(keptNote);
				if (!(await confirm(ctx.stdin, out, `Delete ${what}? This cannot be undone.`))) {
					throw new CliError('cancelled — nothing was deleted.');
				}
			}
			const deleted = db.prune(filter, now);
			out.result(
				{ deleted, bytes: target.bytes, kept: target.recent },
				[
					`Deleted the run history of ${formatCount(deleted)} task(s). ${CONTROL_DB_FILE} keeps its size; new records reuse the space.`,
					...(keptNote && values.yes ? [keptNote] : [])
				].join('\n')
			);
			return ExitCode.Ok;
		} finally {
			db.close();
		}
	}
};

export const tasks: Command = {
	name: 'tasks',
	summary: "Manage this host's task run history",
	usage: '<command>',
	description:
		"This host keeps a record of every task it ran (control.db, '3minapi paths'): when it ran,\n" +
		"retries, cancellations and why it failed. Nothing deletes it automatically — use 'tasks prune'.",
	options: {},
	args: { min: 0, max: 0 },
	subcommands: [tasksPrune],
	async run() {
		return ExitCode.Usage;
	}
};
