/**
 * `worker results` group — views worker results stored in data.db (docs/design/15_cli.md §4, §8-5).
 *
 * No API involved (no size limit, no call cost) — for humans and AIs on the same PC. Remote AIs read through the built-in
 * read worker, which uses the same code (modules/workers/results/).
 */
import { existsSync } from 'node:fs';
import {
	BIN,
	CliError,
	ExitCode,
	RESULTS_LIST_DEFAULT,
	RESULTS_QUERY_TIMEOUT_MS,
	UsageError,
	type Command,
	type CommandContext
} from '../core/domain/index.ts';
import { assertWorkerName } from '../core/names.ts';
import { confirm } from '../core/prompt.ts';
import { formatBytes, formatCount, stripControl } from '../core/text.ts';
import { formatLocal, parseDateArg, toIsoUtc } from '../core/time.ts';
import { describeTask, describeWorker, runQuery } from '../modules/workers/results/query.ts';
import type { PathStat, Shape } from '../modules/workers/results/shape.ts';
import {
	ResultStore,
	resultsDbPath,
	type ResultFilter,
	type ResultRow
} from '../modules/workers/results/store.ts';
import { requireProject } from './common.ts';

const workerOption = {
	type: 'string',
	valueName: 'name',
	description: 'Only this worker'
} as const;
const runOption = {
	type: 'string',
	valueName: 'n',
	description: 'A run of a repeating task (default: the latest run)'
} as const;
const sinceOption = {
	type: 'string',
	valueName: 'date',
	description: 'From this time — YYYY-MM-DD (local midnight) or ISO 8601'
} as const;

export const resultsList: Command = {
	name: 'worker results list',
	summary: 'List the worker results saved in data.db, newest first',
	usage: '[--worker <name>] [--since <date>] [-n <count>]',
	description:
		'Every task result this machine ran is saved in the project data.db (table _3minapi_results),\n' +
		'including results too large to send. Shows time, task id, worker, status, what was sent and size.',
	options: {
		worker: workerOption,
		since: sinceOption,
		lines: {
			type: 'string',
			short: 'n',
			valueName: 'count',
			description: `How many (default ${RESULTS_LIST_DEFAULT})`
		}
	},
	args: { min: 0, max: 0 },
	async run(ctx) {
		const { out } = ctx;
		const filter = filterFrom(ctx);
		const limit = positiveInt(ctx.values.lines, '-n', RESULTS_LIST_DEFAULT);
		const store = openStore(ctx);
		if (!store) {
			out.result({ results: [] }, noResults(ctx));
			return ExitCode.Ok;
		}
		try {
			const rows = store.list(filter, limit);
			const total = store.usage(filter);
			out.result(
				{ results: rows, total: total.count },
				rows.length === 0
					? 'No saved results match.'
					: [
							...rows.map(rowLine),
							...(total.count > rows.length
								? [
										out.out.dim(
											`… ${formatCount(total.count - rows.length)} more (-n to show more)`
										)
									]
								: [])
						].join('\n')
			);
			return ExitCode.Ok;
		} finally {
			store.close();
		}
	}
};

export const resultsShow: Command = {
	name: 'worker results show',
	summary: 'Print one saved result as it was returned (completed result or failed error)',
	usage: '<task_id> [--run <n>]',
	description:
		'Prints the original JSON — also for results too large to send, whose task the AI saw as a\n' +
		'summary. The task id can be shortened to its first characters if that matches only one.\n' +
		"A repeating task saves every run: this shows the latest, --run another ('worker results runs' lists them).",
	options: { run: runOption },
	args: { min: 1, max: 1 },
	async run(ctx) {
		const { out } = ctx;
		const store = requireStore(ctx);
		try {
			const r = findOne(store, ctx.positionals[0], runArg(ctx));
			const payload: unknown = JSON.parse(r.payload);
			const { payload: _raw, shape: _shape, ...row } = r;
			if (!out.json) {
				out.info(out.err.dim(rowLine(row)));
				const runs = runsNote(store, r);
				if (runs) out.info(out.err.dim(runs));
			}
			// Results hold whatever the AI or a fetched page sent — no control sequences reach the terminal (docs/design/17_cli_security_review.md S10)
			out.result({ ...row, payload }, stripControl(JSON.stringify(payload, null, 2)));
			return ExitCode.Ok;
		} finally {
			store.close();
		}
	}
};

export const resultsDescribe: Command = {
	name: 'worker results describe',
	summary: "Summarize a saved result's structure, or group a worker's results by structure",
	usage: '<task_id> [--run <n>] | --worker <name> [--since <date>]',
	description:
		'With a task id: the paths in the result with their types, counts, ranges and sample values.\n' +
		'A path counted fewer times than its array has items is an optional field.\n' +
		"With --worker: the worker's completed results grouped by structure (shape hash), with how each\n" +
		'structure differs from the current one (that of the latest result). The current structure is\n' +
		'summarized over its latest 1,000 results; for values and ranges over all of them, use query.',
	options: { worker: workerOption, since: sinceOption, run: runOption },
	args: { min: 0, max: 1 },
	async run(ctx) {
		const { out, values } = ctx;
		const id = ctx.positionals[0];
		if ((id === undefined) === (values.worker === undefined)) {
			throw new UsageError(
				`give a task id or --worker <name>, not both.\nusage: ${BIN} worker results describe <task_id> | --worker <name>`
			);
		}
		if (id !== undefined && values.since !== undefined) {
			throw new UsageError('--since goes with --worker');
		}
		if (id === undefined && values.run !== undefined) {
			throw new UsageError('--run goes with a task id');
		}
		const store = requireStore(ctx);
		try {
			if (id !== undefined) {
				const r = findOne(store, id, runArg(ctx));
				if (!r.shape) {
					throw new CliError(
						`${r.task_id} is a ${r.status} result — only completed results have a structure. See it with '${BIN} worker results show ${r.task_id}'.`
					);
				}
				// Same budget as the remote read worker — over it, deeper levels are trimmed first. Use show or query for everything
				const described = describeTask({ ...r, shape: r.shape });
				const runs = runsNote(store, r);
				out.result(
					runs ? { run_no: r.run_no, ...described } : described,
					[
						out.out.dim(rowLine(r)),
						...(runs ? [out.out.dim(runs)] : []),
						...shapeLines(described.shape)
					].join('\n')
				);
				return ExitCode.Ok;
			}
			const shapes = describeWorker(store, filterFrom(ctx));
			if (shapes.total === 0) {
				out.result(shapes, `No completed results saved for ${values.worker as string}.`);
				return ExitCode.Ok;
			}
			const lines = [
				`${shapes.worker}: ${formatCount(shapes.total)} completed results, ` +
					`${formatCount(shapes.groups.length + (shapes.others?.groups ?? 0))} structure(s)`
			];
			for (const g of shapes.groups) {
				lines.push(
					'',
					`${g.shape_hash}  ${formatCount(g.count)} result(s)  ${formatLocal(Date.parse(g.first))} → ${formatLocal(Date.parse(g.last))}` +
						(g.shape_hash === shapes.baseline ? '  (current)' : ''),
					`  latest: ${g.task_ids.join(', ')}`
				);
				if (g.added.length > 0)
					lines.push(`  only here: ${stripControl(g.added.join(', '))}${more(g.added_more)}`);
				if (g.removed.length > 0)
					lines.push(
						`  missing here: ${stripControl(g.removed.join(', '))}${more(g.removed_more)}`
					);
			}
			if (shapes.others) {
				lines.push(
					'',
					out.out.dim(
						`… ${formatCount(shapes.others.groups)} less common structure(s) with ${formatCount(shapes.others.count)} result(s) not shown`
					)
				);
			}
			if (shapes.shape) {
				lines.push(
					'',
					`Current structure — values and ranges across the latest ${formatCount(shapes.shape_results)} result(s) ` +
						`since ${formatLocal(Date.parse(shapes.shape_since!))}:`,
					...shapeLines(shapes.shape)
				);
				if (shapes.note) lines.push(out.out.dim(shapes.note));
			}
			out.result(shapes, lines.join('\n'));
			return ExitCode.Ok;
		} finally {
			store.close();
		}
	}
};

export const resultsQuery: Command = {
	name: 'worker results query',
	summary: 'Run a read-only SQL query on data.db',
	usage: '"<SQL>" [--timeout <seconds>]',
	description:
		'For pulling only what you need out of large results, e.g.\n' +
		`  ${BIN} worker results query "SELECT j.value ->> '$.id' FROM _3minapi_results r,\n` +
		"    json_each(r.payload, '$.items') j WHERE r.task_id = '…'\"\n" +
		'Only reading is allowed: writes, ATTACH, PRAGMA and transactions are refused (exit 2).\n' +
		'It runs in a separate process and is stopped after the timeout (default ' +
		`${RESULTS_QUERY_TIMEOUT_MS / 1000}s).`,
	options: {
		timeout: {
			type: 'string',
			valueName: 'seconds',
			description: `Stop the query after this many seconds (default ${RESULTS_QUERY_TIMEOUT_MS / 1000})`
		}
	},
	args: { min: 1, max: 1 },
	async run(ctx) {
		const { out } = ctx;
		const root = requireProject(ctx.loadConfig());
		// User tables can be queried without the results table — the file is enough
		if (!existsSync(resultsDbPath(root))) {
			throw new CliError(`${resultsDbPath(root)} does not exist. '${BIN} init' creates it.`);
		}
		const timeoutMs =
			positiveInt(ctx.values.timeout, '--timeout', RESULTS_QUERY_TIMEOUT_MS / 1000) * 1000;
		ctx.claimInterrupt();
		const r = await runQuery(root, ctx.positionals[0], timeoutMs, ctx.signal);
		if (!r.ok) {
			if (ctx.signal.aborted) throw new CliError('cancelled.', ExitCode.Interrupted);
			if (r.kind === 'denied') {
				throw new UsageError(
					'only reading is allowed — this query writes, attaches a database or uses a PRAGMA or transaction.'
				);
			}
			if (r.kind === 'syntax') throw new UsageError(r.message);
			throw new CliError(r.message);
		}
		out.result(
			{ columns: r.columns, rows: r.rows },
			[r.columns.map(cell).join('\t'), ...r.rows.map((row) => row.map(cell).join('\t'))].join('\n')
		);
		return ExitCode.Ok;
	}
};

export const resultsPrune: Command = {
	name: 'worker results prune',
	summary: 'Delete saved results older than a date',
	usage: '--before <date> [--worker <name>] [--yes]',
	description:
		'Deletes saved results from data.db — nothing is deleted automatically otherwise. Shows how\n' +
		'many and how large first, and asks to confirm. The file does not shrink: the freed space is\n' +
		'reused for new results (3minapi does not VACUUM data.db, which would renumber rows in your\n' +
		'own tables).',
	options: {
		before: {
			type: 'string',
			valueName: 'date',
			description: 'Delete results saved before this time — YYYY-MM-DD (local midnight) or ISO 8601'
		},
		worker: workerOption,
		yes: { type: 'boolean', description: 'Delete without asking for confirmation' }
	},
	args: { min: 0, max: 0 },
	async run(ctx) {
		const { out, values } = ctx;
		if (typeof values.before !== 'string') {
			throw new UsageError(
				`--before is required.\nusage: ${BIN} worker results prune --before <date>`
			);
		}
		const filter = filterFrom(ctx);
		const root = requireProject(ctx.loadConfig());
		const reader = ResultStore.openReadOnly(root);
		const target = reader ? reader.usage(filter) : { count: 0, bytes: 0 };
		reader?.close();
		if (target.count === 0) {
			out.result({ deleted: 0, bytes: 0 }, 'Nothing to delete.');
			return ExitCode.Ok;
		}
		const what = `${formatCount(target.count)} saved result(s) (${formatBytes(target.bytes)})${
			filter.worker ? ` of ${filter.worker}` : ''
		} from before ${formatLocal(Date.parse(filter.before!))}`;
		if (!values.yes) {
			if (out.json || !ctx.stdin.isTTY) {
				throw new UsageError(
					`this deletes ${what} and cannot be undone. Nothing was deleted. Once the user has agreed, run it again with --yes.`
				);
			}
			if (!(await confirm(ctx.stdin, out, `Delete ${what}? This cannot be undone.`))) {
				throw new CliError('cancelled — nothing was deleted.');
			}
		}
		const { store, warnings } = ResultStore.open(root);
		for (const w of warnings) out.warn(w);
		try {
			const deleted = store.prune(filter);
			out.result(
				{ deleted, bytes: target.bytes },
				`Deleted ${formatCount(deleted)} result(s). data.db keeps its size; new results reuse the space.`
			);
			return ExitCode.Ok;
		} finally {
			store.close();
		}
	}
};

export const resultsRuns: Command = {
	name: 'worker results runs',
	summary: 'List the saved runs of a repeating task, newest first',
	usage: '<task_id> [-n <count>]',
	description:
		'A repeating task saves every run as its own result (run 1, 2, …). Shows each run with its time,\n' +
		"status and size. See one with 'worker results show <task_id> --run <n>'. A single task has one run.",
	options: {
		lines: {
			type: 'string',
			short: 'n',
			valueName: 'count',
			description: `How many (default ${RESULTS_LIST_DEFAULT})`
		}
	},
	args: { min: 1, max: 1 },
	async run(ctx) {
		const { out } = ctx;
		const limit = positiveInt(ctx.values.lines, '-n', RESULTS_LIST_DEFAULT);
		const store = requireStore(ctx);
		try {
			const taskId = findOne(store, ctx.positionals[0]).task_id;
			const rows = store.runs(taskId, limit);
			const total = store.runCounts([taskId]).get(taskId)?.runs ?? rows.length;
			out.result(
				{ task_id: taskId, runs: rows, total },
				[
					...rows.map(
						(r) =>
							`run ${r.run_no ?? 1}  ${formatLocal(Date.parse(r.created_at))}  ${r.status}  ${formatBytes(r.bytes)}`
					),
					...(total > rows.length
						? [out.out.dim(`… ${formatCount(total - rows.length)} older run(s) (-n to show more)`)]
						: [])
				].join('\n')
			);
			return ExitCode.Ok;
		} finally {
			store.close();
		}
	}
};

export const workerResults: Command = {
	name: 'worker results',
	summary: 'See the worker results saved in data.db',
	usage: '<command>',
	description:
		'Every result this machine ran is saved in the project data.db (table _3minapi_results),\n' +
		'so nothing is lost when a result is too large to send: a local worker then sends the AI a\n' +
		'summary of it instead. A repeating task saves every run. Results may contain personal data and\n' +
		"are never deleted automatically — use 'worker results prune'.",
	options: {},
	args: { min: 0, max: 0 },
	subcommands: [resultsList, resultsShow, resultsRuns, resultsDescribe, resultsQuery, resultsPrune],
	async run() {
		return ExitCode.Usage;
	}
};

// ── Shared ─────────────────────────────────────────────────────

function openStore(ctx: CommandContext): ResultStore | null {
	const root = requireProject(ctx.loadConfig());
	try {
		return ResultStore.openReadOnly(root);
	} catch (err) {
		throw new CliError(`cannot read ${resultsDbPath(root)}: ${(err as Error).message}`);
	}
}

function requireStore(ctx: CommandContext): ResultStore {
	const store = openStore(ctx);
	if (!store) throw new CliError(noResults(ctx));
	return store;
}

function noResults(ctx: CommandContext): string {
	const root = requireProject(ctx.loadConfig());
	return `No results saved yet in ${resultsDbPath(root)} — '${BIN} start' saves every task result there.`;
}

/** task id (or a prefix) — that run when runNo is given, otherwise the last run */
function findOne(store: ResultStore, id: string, runNo?: number) {
	const r = store.find(id);
	if ('found' in r) {
		if (runNo === undefined || r.found.run_no === runNo) return r.found;
		const run = store.get(r.found.task_id, runNo);
		if (run) return run;
		const saved = store.runCounts([r.found.task_id]).get(r.found.task_id);
		throw new CliError(
			`no saved run ${runNo} for task ${r.found.task_id}` +
				(saved
					? ` — ${formatCount(saved.runs)} run(s) saved, the latest is run ${saved.lastRunNo}`
					: '') +
				`. '${BIN} worker results runs ${r.found.task_id}' lists them.`
		);
	}
	if (r.candidates.length === 0) {
		throw new CliError(
			`no saved result for task "${id}". '${BIN} worker results list' shows them.`
		);
	}
	throw new CliError(
		`"${id}" matches more than one result: ${r.candidates.slice(0, 5).join(', ')}${r.candidates.length > 5 ? ', …' : ''}. Give more of the task id.`
	);
}

function filterFrom(ctx: CommandContext): ResultFilter {
	const { values } = ctx;
	const filter: ResultFilter = {};
	if (typeof values.worker === 'string') {
		assertWorkerName(values.worker);
		filter.worker = values.worker;
	}
	for (const key of ['since', 'before'] as const) {
		const v = values[key];
		if (typeof v !== 'string') continue;
		const ms = parseDateArg(v);
		if (ms === null) {
			throw new UsageError(
				`--${key} "${v}" is not a date. Use YYYY-MM-DD (local midnight) or ISO 8601 like 2026-10-01T09:00.`
			);
		}
		filter[key] = toIsoUtc(ms);
	}
	return filter;
}

function positiveInt(value: unknown, flag: string, fallback: number): number {
	if (value === undefined) return fallback;
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1)
		throw new UsageError(`${flag} must be a positive whole number`);
	return n;
}

function runArg(ctx: CommandContext): number | undefined {
	return ctx.values.run === undefined ? undefined : positiveInt(ctx.values.run, '--run', 1);
}

/** "run N of M saved" hint for recurring tasks — null for one-off tasks (run 1 only) */
function runsNote(store: ResultStore, r: ResultRow): string | null {
	const saved = store.runCounts([r.task_id]).get(r.task_id);
	if (!saved || (saved.lastRunNo <= 1 && (r.run_no ?? 1) <= 1)) return null;
	return (
		`run ${r.run_no ?? 1} — ${formatCount(saved.runs)} run(s) saved, the latest is run ${saved.lastRunNo} ` +
		`(--run <n> for another · '${BIN} worker results runs ${r.task_id}' lists them)`
	);
}

function rowLine(r: ResultRow): string {
	return [
		formatLocal(Date.parse(r.created_at)),
		// Recurring runs get a run number — run 1 is told apart by a pulled row with no reply (reply none; --serve rows are serve)
		(r.run_no ?? 1) > 1 || (r.reply === 'none' && r.source !== 'serve')
			? `${r.task_id} run ${r.run_no ?? 1}`
			: r.task_id,
		r.worker,
		r.status,
		`sent: ${r.reply}`,
		formatBytes(r.bytes)
	].join('  ');
}

function shapeLines(shape: Shape): string[] {
	const lines = Object.entries(shape.paths).map(
		([p, stat]) => `  ${stripControl(p)}  ${stripControl(statText(stat))}`
	);
	const { samples_from_depth: samples, paths_from_depth: paths } = shape.omitted ?? {};
	if (paths !== undefined) lines.push(`  … paths at depth ${paths} and deeper left out`);
	if (samples !== undefined && samples !== paths) {
		lines.push(`  … sample values at depth ${samples} and deeper left out`);
	}
	if (shape.truncated && shape.omitted === undefined) {
		lines.push('  … (summary cut short: too deep or too many paths)');
	}
	return lines;
}

function more(n: number | undefined): string {
	return n ? ` … and ${formatCount(n)} more` : '';
}

function statText(s: PathStat): string {
	const types = Object.entries(s.types)
		.map(([t, n]) => (Object.keys(s.types).length > 1 ? `${t}×${n}` : t))
		.join('|');
	const parts = [types, `×${formatCount(s.count)}`];
	if (s.length) parts.push(`length ${s.length.min}–${s.length.max}`);
	if (s.min !== undefined) parts.push(`${s.min}–${s.max}`);
	if (s.values) parts.push(`values: ${s.values.map((v) => JSON.stringify(v)).join(', ')}`);
	else if (s.sample !== undefined) parts.push(`e.g. ${JSON.stringify(s.sample)}`);
	return parts.join('  ');
}

/** One query cell for the terminal — tabs and newlines become spaces, other control characters are dropped */
function cell(v: unknown): string {
	if (v === null) return 'NULL';
	if (typeof v === 'object') return stripControl(JSON.stringify(v));
	return stripControl(String(v).replace(/[\t\n]/g, ' '));
}
