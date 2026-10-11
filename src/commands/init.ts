import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
	AGENTS_FILE,
	BIN,
	CLAUDE_FILE,
	CliError,
	ConfigError,
	DEFAULT_WORKERS_DIR,
	ExitCode,
	GITIGNORE_ENTRIES,
	PROJECT_CONFIG_FILE,
	USER_DB_FILE,
	UsageError,
	type Command,
	type CommandContext
} from '../core/domain/index.ts';
import { readRunner } from '../core/host/runner-lock.ts';
import { findProjectFile } from '../core/config.ts';
import { confirm } from '../core/prompt.ts';
import { readUserText } from '../core/text-file.ts';
import { shellArg } from '../core/text.ts';
import {
	defaultProjectRoot,
	projectAlive,
	readProjectRecord,
	samePath,
	writeProjectRecord
} from '../core/project.ts';
import { ResultStore } from '../modules/workers/results/store.ts';
import { DOTENV_FILE } from '../modules/workers/runtime/env.ts';
import { agentsFileText, CLAUDE_FILE_TEXT, GENERATED_MARKER } from './guide.ts';

export const init: Command = {
	name: 'init',
	summary: `Create the host's project (default ~/3minapi): ${PROJECT_CONFIG_FILE}, a workers/ folder, ${USER_DB_FILE} and ${AGENTS_FILE}`,
	usage: '[folder] [--move] [--yes]',
	description:
		'A host has one project. Other commands use it from any folder — no need to cd into it.\n' +
		'  3minapi init           ~/3minapi (Windows: %USERPROFILE%\\3minapi). Asks first; without a terminal pass --yes\n' +
		'  3minapi init <folder>  that folder, created if missing\n' +
		'  3minapi init .         the current folder\n' +
		'Inside the project (or once the host has one) plain init repairs it. Making your home folder or /\n' +
		'the project asks first.\n' +
		'Safe to run again: existing files are left untouched and only missing parts are added.\n' +
		`${AGENTS_FILE} tells AI coding agents how to work here (the '${BIN} guide' text); ${CLAUDE_FILE} imports it\n` +
		`for Claude Code. init refreshes ${AGENTS_FILE} to this version while its first line is the generated marker.\n` +
		'AI agents and scripts: name the folder or pass --yes, and read the absolute paths from --json (root).\n' +
		'\n' +
		'Moving the project:\n' +
		"  with its files     '3minapi stop', move the folder, then run any command inside it ('3minapi status')\n" +
		'                     — the new place is picked up automatically\n' +
		"  to another folder  '3minapi init <folder> --move' — nothing is copied: the old folder keeps its\n" +
		'                     data.db, workers and .env\n' +
		'\n' +
		`${USER_DB_FILE} is a SQLite file. 'start' saves every task result in it (tables starting with\n` +
		"_3minapi_), and your workers can keep their own data there — see the note in 'worker new' files.\n" +
		'Saved results may contain personal data; nothing deletes them automatically.',
	options: {
		move: {
			type: 'boolean',
			description: "Make the folder the host's project instead of the current one"
		},
		yes: {
			type: 'boolean',
			description: 'Create the project without asking (~/3minapi, your home folder or /)'
		}
	},
	args: { min: 0, max: 1 },
	async run(ctx) {
		const { out, dirs, platform, values, now } = ctx;
		const record = readProjectRecord(dirs.data);
		const recordAlive = record !== null && projectAlive(record.root);
		const target = initTarget(ctx, recordAlive ? record.root : null);
		const root = target.root;

		const stat = statSync(root, { throwIfNoEntry: false });
		if (stat && !stat.isDirectory()) {
			throw new ConfigError(`${root} is a file, not a folder. Run '${BIN} init <folder>'.`);
		}
		const isProject = projectAlive(root);
		// The default path holds non-project content — it may be someone else's folder. An explicit folder (an existing repo etc.) is allowed
		if (target.kind === 'default' && stat && !isProject && hasUserFiles(root)) {
			throw new ConfigError(
				`${root} already exists and is not a 3minapi project. ` +
					`Run '${BIN} init <folder>' to use another folder, or '${BIN} init ${shellArg(root)}' to use it anyway.`
			);
		}

		// One project per host (docs/design/15_cli.md §5) — refuse without --move when another live project is recorded
		const other = recordAlive && !samePath(record.root, root, platform) ? record.root : null;
		if (other !== null && !values.move) {
			throw new ConfigError(
				`this host's project is ${other} — a host has one project.\n` +
					`To make ${root} the project instead, run '${BIN} init ${shellArg(root)} --move' ` +
					`(nothing is copied: ${other} keeps its ${USER_DB_FILE}, workers and .env).`
			);
		}
		if (other !== null && readRunner(dirs.data).state !== 'stopped') {
			throw new CliError(
				`'${BIN} start' is running with the project ${other}. Run '${BIN} stop' first, then '${BIN} init ${shellArg(root)} --move'.`
			);
		}

		// After a move, init elsewhere would record an empty project and ignore the moved one — warn before creating
		if (target.kind === 'default' && record !== null && !recordAlive && !isProject) {
			out.warn(
				`this host's project ${record.root} no longer exists. If you moved it, run '${BIN} status' ` +
					'inside the new folder instead of creating a new project.'
			);
		}
		if (!isProject && needsConfirm(ctx, target.kind, root)) {
			await agree(ctx, target.kind, root);
		}
		if (!stat) mkdirSync(root, { recursive: true });

		const created: string[] = stat ? [] : [root + path.sep];
		const kept: string[] = [];

		const configFile = path.join(root, PROJECT_CONFIG_FILE);
		let workersDir = DEFAULT_WORKERS_DIR;
		if (existsSync(configFile)) {
			kept.push(configFile);
			// Respect workersDir from an existing config — if the file is broken, continue with the default (doctor reports it)
			try {
				const dir = JSON.parse(readUserText(configFile)).workersDir;
				if (typeof dir === 'string' && dir.trim() !== '' && !path.isAbsolute(dir)) workersDir = dir;
			} catch (err) {
				out.warn(
					err instanceof ConfigError
						? err.message
						: `${PROJECT_CONFIG_FILE} is not valid JSON — run '3minapi doctor'`
				);
			}
		} else {
			writeFileSync(configFile, JSON.stringify({ workersDir }, null, '\t') + '\n', { flag: 'wx' });
			created.push(configFile);
		}

		const workersPath = path.resolve(root, workersDir);
		if (existsSync(workersPath)) {
			kept.push(workersPath + path.sep);
		} else {
			mkdirSync(workersPath, { recursive: true });
			created.push(workersPath + path.sep);
		}

		// 0600 + results table only when newly created (docs/design/15_cli.md §7-7). An existing file isn't opened — it may not be SQLite
		const db = path.join(root, USER_DB_FILE);
		let dbCreated = false;
		if (existsSync(db)) {
			kept.push(db);
		} else {
			ResultStore.open(root).store.close();
			created.push(db);
			dbCreated = true;
		}

		const gitignore = path.join(root, '.gitignore');
		const current = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : null;
		const lines = new Set((current ?? '').split(/\r?\n/).map((l) => l.trim()));
		const missing = GITIGNORE_ENTRIES.filter((entry) => !lines.has(entry));
		if (missing.length === 0) {
			kept.push(gitignore);
		} else {
			const prefix = current === null || current === '' || current.endsWith('\n') ? '' : '\n';
			writeFileSync(gitignore, `${current ?? ''}${prefix}${missing.join('\n')}\n`);
			created.push(current === null ? gitignore : `${gitignore} (added ${missing.join(', ')})`);
		}

		const agents = writeAgentFiles(root, ctx.version);
		created.push(...agents.created);
		kept.push(...agents.kept);

		const recorded = record === null || !samePath(record.root, root, platform);
		if (recorded) writeProjectRecord(dirs.data, root, now());

		// Absolute paths — correct even when an AI opens them as is (docs/design/15_cli.md §4)
		const env = path.join(root, DOTENV_FILE);
		const output = [
			...(other !== null
				? [
						`${out.out.green('moved')}    this host's project is now ${root}`,
						out.out.dim(
							`         ${other} was left as is — its ${USER_DB_FILE} (saved results), workers and .env were not moved.`
						)
					]
				: []),
			...created.map((f) => `${out.out.green('created')}  ${f}`),
			...agents.updated.map((f) => `${out.out.green('updated')}  ${f}`),
			...kept.map((f) => `${out.out.dim('exists')}   ${f}`),
			`${out.out.dim('env')}      ${env}${existsSync(env) ? '' : out.out.dim(' (create it when a worker needs secrets)')}`
		];
		if (agents.claudeWithoutImport) {
			output.push(
				'',
				`${CLAUDE_FILE} exists without '@${AGENTS_FILE}' — Claude Code reads ${AGENTS_FILE} only through it. Add that line to use the guide.`
			);
		}
		if (dbCreated) {
			output.push(
				'',
				`${USER_DB_FILE} keeps every task result this machine runs — they may contain personal data and`,
				`are never deleted automatically ('${BIN} worker results prune'). It is in .gitignore.`
			);
		}
		// Only when the project itself is new — not when a re-run just adds AGENTS.md or CLAUDE.md
		if (created.includes(configFile) || created.includes(workersPath + path.sep)) {
			// No cd (a child process can't change the shell's cwd) — say that commands work from any folder
			output.push(
				'',
				`Next: ${BIN} worker new <name>   ${out.out.dim('(works from any folder)')}`,
				`      edit workers in ${workersPath}`
			);
		}
		out.result(
			{
				root,
				workersDir: workersPath,
				configFile,
				env,
				db,
				agentsFile: path.join(root, AGENTS_FILE),
				created,
				updated: agents.updated,
				kept,
				moved: other !== null,
				previousRoot: other
			},
			output.join('\n')
		);
		return ExitCode.Ok;
	}
};

type TargetKind = 'explicit' | 'existing' | 'default';

/** Files the OS creates just by opening a folder (Finder, Explorer) — treated as empty */
const OS_METADATA_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/** Whether anything other than OS metadata is present */
function hasUserFiles(dir: string): boolean {
	return readdirSync(dir).some((name) => !OS_METADATA_FILES.has(name));
}

/**
 * Which folder becomes the project.
 * - A given path: that folder
 * - Otherwise: the project at cwd (or a parent) → the live record (unless --move) → `~/3minapi`
 *   — init run inside a project repairs it in place instead of creating `~/3minapi/3minapi`
 */
function initTarget(
	ctx: CommandContext,
	recorded: string | null
): { root: string; kind: TargetKind } {
	const arg = ctx.positionals[0];
	if (arg !== undefined) return { root: path.resolve(ctx.cwd, arg), kind: 'explicit' };
	const found = findProjectFile(ctx.cwd);
	if (found) return { root: path.dirname(found), kind: 'existing' };
	if (recorded !== null && !ctx.values.move) return { root: recorded, kind: 'existing' };
	return { root: defaultProjectRoot(ctx.home), kind: 'default' };
}

/** Asks only when creating — for the default path, and for home or the filesystem root (five files would land there) */
function needsConfirm(ctx: CommandContext, kind: TargetKind, root: string): boolean {
	if (kind === 'default') return true;
	return samePath(root, ctx.home, ctx.platform) || path.parse(root).root === root;
}

async function agree(ctx: CommandContext, kind: TargetKind, root: string): Promise<void> {
	const { out } = ctx;
	if (ctx.values.yes) return;
	const rerun = kind === 'default' ? `${BIN} init --yes` : `${BIN} init ${shellArg(root)} --yes`;
	if (out.json || !ctx.stdin.isTTY) {
		throw new UsageError(
			`init creates the project in ${root} and needs agreement. Nothing was created. ` +
				`Once the user has agreed, run: ${rerun} — or name another folder: ${BIN} init <folder>`
		);
	}
	const where =
		kind === 'default'
			? root
			: `${root} (${path.parse(root).root === root ? 'the filesystem root' : 'your home folder'})`;
	const yes = await confirm(
		ctx.stdin,
		out,
		`Create the 3minapi project in ${where}? It adds ${PROJECT_CONFIG_FILE}, workers/, ${USER_DB_FILE}, .gitignore, ${AGENTS_FILE} and ${CLAUDE_FILE}.`
	);
	if (!yes) {
		throw new CliError(
			`cancelled — nothing was created. To use another folder: ${BIN} init <folder>`
		);
	}
}

/**
 * AGENTS.md and CLAUDE.md. A generated AGENTS.md (marker on line 1) is refreshed to this version; one without the marker
 * is the user's and stays. CLAUDE.md is only created — an existing one is reported when it lacks the import.
 */
function writeAgentFiles(
	root: string,
	version: string
): { created: string[]; updated: string[]; kept: string[]; claudeWithoutImport: boolean } {
	const result = {
		created: [] as string[],
		updated: [] as string[],
		kept: [] as string[],
		claudeWithoutImport: false
	};

	const agents = path.join(root, AGENTS_FILE);
	const text = agentsFileText(version);
	// Compared without BOM and CRLF — a checkout with git autocrlf or an editor save must not count as a change
	const current = existsSync(agents)
		? readFileSync(agents, 'utf8')
				.replace(/^\uFEFF/, '')
				.replace(/\r\n/g, '\n')
		: null;
	if (current === null) {
		writeFileSync(agents, text, { flag: 'wx' });
		result.created.push(agents);
	} else if (current.startsWith(GENERATED_MARKER) && current !== text) {
		writeFileSync(agents, text);
		result.updated.push(agents);
	} else {
		result.kept.push(agents);
	}

	const claude = path.join(root, CLAUDE_FILE);
	if (!existsSync(claude)) {
		writeFileSync(claude, CLAUDE_FILE_TEXT, { flag: 'wx' });
		result.created.push(claude);
	} else {
		result.kept.push(claude);
		result.claudeWithoutImport = !/^\s*@AGENTS\.md\s*$/m.test(readFileSync(claude, 'utf8'));
	}
	return result;
}
