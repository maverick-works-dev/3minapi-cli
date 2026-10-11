import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
	BIN,
	CliError,
	ExitCode,
	StopError,
	TEMPLATE_EXTENSION,
	WORKER_EXTENSIONS,
	type Command,
	type CommandContext
} from '../core/domain/index.ts';
import { assertWorkerName } from '../core/names.ts';
import { failReload, reloadRunner } from '../core/host/reload.ts';
import { readRunner } from '../core/host/runner-lock.ts';
import { reloadLines, type WorkersReloaded } from '../modules/workers/reload-result.ts';
import { DOTENV_FILE } from '../modules/workers/runtime/env.ts';
import { jsTemplate, tsTemplate } from '../modules/workers/template.ts';
import { requireWorkersDir } from './common.ts';

export const workerNew: Command = {
	name: 'worker new',
	summary: 'Create a worker file from a template',
	usage: '<name> [--ts] [--no-reload]',
	description:
		'The name becomes the file name (workers/<name>.mjs) and the task route (/task/<name>).\n' +
		'Allowed: 1-50 lowercase letters, digits, "_" and "-", not starting with "_" (reserved for\n' +
		'built-in workers).\n' +
		'Prints absolute paths of the new file, the workers folder and the project .env.\n' +
		"If 'start' is running on this folder, the worker is registered right away (3minapi reload).",
	options: {
		ts: { type: 'boolean', description: 'Write a TypeScript worker (runs without a build step)' },
		reload: {
			type: 'boolean',
			negated: true,
			description: "Do not register it with the running 'start' now (run '3minapi reload' later)"
		}
	},
	args: { min: 1, max: 1 },
	async run(ctx) {
		const { positionals, values, out, loadConfig } = ctx;
		const name = positionals[0];
		assertWorkerName(name);
		const { root, dir } = requireWorkersDir(loadConfig());

		const existing = WORKER_EXTENSIONS.map((ext) => path.join(dir, name + ext)).find((f) =>
			existsSync(f)
		);
		if (existing) throw new CliError(`worker "${name}" already exists: ${existing}`);

		const file = path.join(dir, name + (values.ts ? TEMPLATE_EXTENSION.ts : TEMPLATE_EXTENSION.js));
		writeFileSync(file, values.ts ? tsTemplate(name) : jsTemplate(name), { flag: 'wx' });

		// Absolute path — correct when run from a subfolder and when an AI opens it as is
		const env = path.join(root, DOTENV_FILE);
		const envExists = existsSync(env);
		const lines = [
			`${out.out.green('created')}  ${file}`,
			`workers  ${dir}`,
			`env      ${env}${envExists ? '' : out.out.dim(' (not created yet)')}`,
			''
		];
		const reload = await registerNow(ctx, dir, values.reload === false);
		lines.push(
			...reload.lines,
			'',
			`Next: edit the handler, then test it with '${BIN} worker run ${name}'`
		);
		out.result(
			{ name, file, workersDir: dir, env, envExists, reload: reload.json },
			lines.join('\n')
		);
		return ExitCode.Ok;
	}
};

type NewReload =
	| { status: 'done'; result: WorkersReloaded }
	| { status: 'failed'; error: string }
	| { status: 'skipped'; reason: 'not_running' | 'other_folder' | 'unsupported' | 'disabled' };

/**
 * Registers with a running start right away — no prompt, one line of output. Safeguards:
 * - Only when start reads this folder — for another folder a reload wouldn't register this file
 * - Waits for and shows the result (registered, rejected, load failed) — name conflicts must surface here
 * - --no-reload turns it off (when creating many files at once)
 * The file already exists, so a reload failure is only a warning (exit 0). Only stop codes (4, 5) pass through
 */
async function registerNow(
	ctx: CommandContext,
	dir: string,
	disabled: boolean
): Promise<{ lines: string[]; json: NewReload }> {
	const runner = readRunner(ctx.dirs.data);
	if (runner.state !== 'running') {
		return {
			lines: [`The next '${BIN} start' registers it with 3Min API.`],
			json: { status: 'skipped', reason: 'not_running' }
		};
	}
	const { info } = runner;
	if (disabled) {
		return {
			lines: [`'${BIN} start' is running — run '${BIN} reload' to register it.`],
			json: { status: 'skipped', reason: 'disabled' }
		};
	}
	if (!info.reload || !info.workersDir) {
		return {
			lines: [
				`'${BIN} start' (pid ${info.pid}) is from an older 3minapi and cannot reload — restart it to register this worker.`
			],
			json: { status: 'skipped', reason: 'unsupported' }
		};
	}
	if (!sameDir(info.workersDir, dir)) {
		return {
			lines: [
				`'${BIN} start' is running on ${info.workersDir}, not this folder — this worker is not registered.`
			],
			json: { status: 'skipped', reason: 'other_folder' }
		};
	}
	ctx.out.info(`'${BIN} start' is running — registering it now (${BIN} reload)...`);
	try {
		const result = await reloadRunner<WorkersReloaded>(ctx, info);
		if (!result.ok) failReload(result);
		return { lines: reloadLines(result), json: { status: 'done', result } };
	} catch (err) {
		if (err instanceof StopError || !(err instanceof CliError)) throw err;
		ctx.out.warn(`${err.message}\nThe file was created; run '${BIN} reload' to register it.`);
		return { lines: [], json: { status: 'failed', error: err.message } };
	}
}

/**
 * Same folder — compared by real path, not string. If a symlinked path or a Windows case difference (shells differ on drive
 * letter `C:` vs `c:`) looked like another folder, the auto reload would be skipped with a wrong "not this folder" message
 */
export function sameDir(
	a: string,
	b: string,
	platform: NodeJS.Platform = process.platform
): boolean {
	const real = (p: string) => {
		try {
			return realpathSync.native(p);
		} catch {
			return path.resolve(p);
		}
	};
	const [x, y] = [real(a), real(b)];
	return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}
