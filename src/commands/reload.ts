/**
 * reload — makes a running start re-read and register the worker files (docs/design/15_cli.md §4).
 *
 * Same result as stop → start without ending the process — running tasks continue (stop fails them with host_stopped),
 * and a foreground start in another terminal picks it up in place. One sync call.
 */
import { BIN, ExitCode, type Command } from '../core/domain/index.ts';
import { failReload, reloadRunner } from '../core/host/reload.ts';
import { readRunnerSettled } from '../core/host/runner-lock.ts';
import { reloadLines, type WorkersReloaded } from '../modules/workers/reload-result.ts';

export const reload: Command = {
	name: 'reload',
	summary: "Apply added, renamed or re-described worker files to the running 'start'",
	usage: '',
	description:
		'Asks the running start (the host process) to read the worker files again and register\n' +
		'them with 3Min API (one API call), without stopping it: running tasks keep going.\n' +
		'Use it after adding or renaming a worker file or changing its description —\n' +
		"'worker new' does it by itself.\n" +
		'Handler code and .env changes need no reload; they apply to the next task.\n' +
		'Like start, it imports every worker file, so top-level code in them runs again.\n' +
		'Without a running start there is nothing to reload: the next start registers the files.',
	options: {},
	args: { min: 0, max: 0 },
	async run(ctx) {
		const { out } = ctx;
		const current = await readRunnerSettled(ctx.dirs.data);
		if (current.state !== 'running') {
			out.result(
				{ reloaded: false, running: false },
				`No '${BIN} start' is running — the next '${BIN} start' registers the worker files.`
			);
			return ExitCode.Ok;
		}
		out.info(`reloading pid ${current.info.pid}...`);
		const result = await reloadRunner<WorkersReloaded>(ctx, current.info);
		if (!result.ok) failReload(result);
		out.result({ reloaded: true, ...result }, reloadLines(result).join('\n'));
		return ExitCode.Ok;
	}
};
