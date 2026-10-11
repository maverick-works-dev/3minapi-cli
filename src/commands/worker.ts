/**
 * `worker` group — commands on a worker (= one file in the workers/ folder). The target noun comes first
 * (like gh `pr create`) so names don't collide as the CLI grows. See docs/design/15_cli.md §4.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
	BIN,
	CliError,
	ExitCode,
	REPORT_ENVELOPE_RESERVE,
	REPORT_MAX_BYTES,
	RESULT_RESERVED_KEY,
	UsageError,
	WORKER_DESCRIPTION_MAX_CHARS,
	type Command,
	type CommandContext
} from '../core/domain/index.ts';
import { assertWorkerName } from '../core/names.ts';
import { formatCount } from '../core/text.ts';
import { workerEnv } from '../modules/workers/runtime/env.ts';
import { Executor } from '../modules/workers/runtime/executor.ts';
import { collectWorkers, descriptionTooLong } from '../modules/workers/workers.ts';
import { requireProject, requireWorkersDir, workersPath } from './common.ts';
import { workerDelete } from './delete.ts';
import { workerLogs } from './logs.ts';
import { workerNew } from './new.ts';
import { workerResults } from './results.ts';

interface ListedWorker {
	name: string;
	files: string[];
	ok: boolean;
	problem: string | null;
	description: string | null;
	timeoutMs: number | null;
	hasInputSchema: boolean;
	warnings: string[];
}

export const workerList: Command = {
	name: 'worker list',
	summary: 'List the workers in this project and check that each one can load',
	usage: '',
	description:
		'Loads every worker file (without running the handler) and reports its description,\n' +
		'timeout and whether it has an inputSchema. Makes no API calls.\n' +
		"Loading runs the file's top-level code, as a real run would.",
	options: {},
	args: { min: 0, max: 0 },
	async run(ctx) {
		const { out } = ctx;
		const { root, dir } = requireWorkersDir(ctx.loadConfig());
		const workers: ListedWorker[] = (await collectWorkers(dir, workerEnv(root, ctx.env))).map(
			(w) => {
				const warnings: string[] = [];
				const description = w.meta?.description ?? null;
				if (w.meta && description === null) {
					warnings.push('no description — the AI will not know what it does');
				} else if (description !== null && descriptionTooLong(description)) {
					warnings.push(
						`description is over ${WORKER_DESCRIPTION_MAX_CHARS} characters — the server will not register this worker`
					);
				}
				return {
					name: w.name,
					files: w.files,
					ok: w.meta !== null,
					problem: w.message,
					description,
					timeoutMs: w.meta?.timeoutMs ?? null,
					hasInputSchema: w.meta?.hasInputSchema ?? false,
					warnings
				};
			}
		);

		const text =
			workers.length === 0
				? `No workers in ${dir}. Create one with '${BIN} worker new <name>'.`
				: [
						`workers  ${dir}`,
						'',
						...workers.flatMap((w) => [
							`${w.ok ? out.out.green('ok   ') : out.out.red('error')}  ${w.name}  ${out.out.dim(w.files.join(', '))}`,
							...(w.ok
								? [
										`       ${w.description ?? out.out.dim('(no description)')}`,
										`       ${out.out.dim(`timeout ${(w.timeoutMs ?? 60_000) / 1000}s · ${w.hasInputSchema ? 'inputSchema' : 'no inputSchema (any input)'}`)}`
									]
								: [`       ${w.problem}`]),
							...w.warnings.map((m) => `       ${out.out.yellow('warn')} ${m}`)
						])
					].join('\n');
		out.result({ workersDir: dir, workers }, text);
		return ExitCode.Ok;
	}
};

export const workerRun: Command = {
	name: 'worker run',
	summary: 'Run one worker once with the given input — no task, no API calls',
	usage: '<worker> [--input <json> | --input-file <file>]',
	description:
		'Runs the worker file once on this machine, without a task: same thread, timeout and\n' +
		'inputSchema check as start, so if it works here it works as a real task.\n' +
		'Makes no API calls (no quota, no login needed). Input defaults to {}.\n' +
		'ctx.log lines go to stderr; the result goes to stdout (--json).',
	options: {
		input: { type: 'string', valueName: 'json', description: 'Input as a JSON string' },
		'input-file': { type: 'string', valueName: 'file', description: 'Read input JSON from a file' }
	},
	args: { min: 1, max: 1 },
	async run(ctx) {
		const { out, values } = ctx;
		const name = ctx.positionals[0];
		assertWorkerName(name);
		if (values.input !== undefined && values['input-file'] !== undefined) {
			throw new UsageError('use either --input or --input-file, not both');
		}
		// --input-file is relative to the invoking folder — read it before chdir
		const input = parseInput(ctx);
		const config = ctx.loadConfig();
		const root = requireProject(config);
		// Same cwd as start (the project folder) — if it works here, it works as a task (#1403)
		ctx.chdir(root);

		const executor = new Executor({
			workersDir: workersPath(root, config),
			concurrency: 1,
			env: workerEnv(root, ctx.env)
		});
		ctx.claimInterrupt();
		const id = 'local-run';
		const onAbort = () => executor.cancel(id, 'interrupted');
		ctx.signal.addEventListener('abort', onAbort, { once: true });
		try {
			const outcome = await executor.run(
				{ id, worker: name, input },
				{
					onLog: (message) => out.info(`${out.err.dim('log')}     ${message}`),
					onReport: async (message) => out.info(`${out.err.dim('report')}  ${message}`)
				}
			);
			await executor.idle();
			if (outcome.status === 'completed') {
				const result = JSON.parse(outcome.resultJson);
				warnReplyLimits(ctx, result, Buffer.byteLength(outcome.resultJson));
				out.result({ status: 'completed', result }, JSON.stringify(result, null, 2));
				return ExitCode.Ok;
			}
			if (outcome.status === 'cancelled') {
				out.result({ status: 'cancelled' }, 'Cancelled.');
				return ExitCode.Interrupted;
			}
			if (out.json)
				out.result({ status: 'failed', reason: outcome.reason, message: outcome.message });
			throw new CliError(`${name} failed (${outcome.reason}): ${outcome.message}`);
		} finally {
			ctx.signal.removeEventListener('abort', onAbort);
		}
	}
};

export const worker: Command = {
	name: 'worker',
	summary: 'Create, test and inspect local workers',
	usage: '<command>',
	description:
		'A worker is one file in the workers folder; its file name is the worker name. ' +
		"'start' registers it as a local worker; with 'start --serve --public' a name registered as a " +
		'public worker on the dashboard is served as that public worker instead. ' +
		"Removing the file does not remove the local worker from 3Min API — use 'worker delete'.",
	options: {},
	args: { min: 0, max: 0 },
	subcommands: [workerNew, workerRun, workerList, workerLogs, workerDelete, workerResults],
	async run() {
		// The dispatcher prints the group help — never reached
		return ExitCode.Usage;
	}
};

/**
 * `worker run` doesn't reply, so size and reserved-key limits don't apply — report what would happen in a real task
 * (15_cli.md §8-5, #1397)
 */
function warnReplyLimits(ctx: CommandContext, result: unknown, bytes: number): void {
	if (
		result !== null &&
		typeof result === 'object' &&
		!Array.isArray(result) &&
		Object.hasOwn(result, RESULT_RESERVED_KEY)
	) {
		ctx.out.warn(
			`the result has a top-level "${RESULT_RESERVED_KEY}" key, which 3minapi reserves — as a task it fails ` +
				'(reserved_result_key). Rename the key.'
		);
	}
	if (bytes > REPORT_MAX_BYTES - REPORT_ENVELOPE_RESERVE) {
		ctx.out.warn(
			`the result is ${formatCount(bytes)} bytes, over the 100 KiB reply limit. As a task, a local worker ` +
				"saves it in data.db and sends the AI a summary instead; a public worker's task fails."
		);
	}
}

function parseInput(ctx: CommandContext): unknown {
	const { values } = ctx;
	let text: string;
	let from: string;
	if (typeof values['input-file'] === 'string') {
		from = values['input-file'];
		try {
			text = readFileSync(path.resolve(ctx.cwd, from), 'utf8');
		} catch (err) {
			throw new UsageError(`cannot read ${from}: ${(err as Error).message}`);
		}
	} else if (typeof values.input === 'string') {
		from = '--input';
		text = values.input;
	} else {
		return {};
	}
	try {
		return JSON.parse(text);
	} catch (err) {
		throw new UsageError(`${from} is not valid JSON: ${(err as Error).message}`);
	}
}
