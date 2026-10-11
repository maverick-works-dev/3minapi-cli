/**
 * `paths` — absolute paths of the files and folders users and AIs need to find. No API call; works before login.
 * Paths differ per OS (docs/design/15_cli.md §5) — AIs should call this instead of guessing.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
	APP_LOG_DIR,
	CONTROL_DB_FILE,
	CREDENTIALS_FILE,
	ConfigError,
	ExitCode,
	LOCAL_SERVER_TOKEN_FILE,
	RUNNER_OUT_FILE,
	USER_CONFIG_FILE,
	USER_DB_FILE,
	type Command
} from '../core/domain/index.ts';
import { initHint, projectRecordPath } from '../core/project.ts';
import { DOTENV_FILE } from '../modules/workers/runtime/env.ts';
import { workersPath } from './common.ts';

interface PathEntry {
	path: string | null;
	exists: boolean;
	/** One line for humans and AIs */
	note: string;
}

export const paths: Command = {
	name: 'paths',
	summary: 'Show absolute paths of project files and CLI folders',
	usage: '',
	description:
		'No API calls. Edit the project files (workers, .env, 3minapi.json); use commands for the\n' +
		'rest — the CLI folders hold the host token and internal state.',
	options: {},
	args: { min: 0, max: 0 },
	async run(ctx) {
		const { out, dirs } = ctx;
		let projectRoot: string | null = null;
		let workersDir: string | null = null;
		let projectConfig: string | null = null;
		try {
			const config = ctx.loadConfig();
			projectRoot = config.projectRoot;
			projectConfig = config.projectFile;
			if (projectRoot) workersDir = workersPath(projectRoot, config);
		} catch (err) {
			// Show the CLI folder paths even with a broken config — needed to go fix it
			if (!(err instanceof ConfigError)) throw err;
			out.warn(err.message);
		}

		const entry = (p: string | null, note: string): PathEntry => ({
			path: p,
			exists: p !== null && existsSync(p),
			note
		});
		const data: Record<string, PathEntry> = {
			projectRoot: entry(
				projectRoot,
				projectRoot
					? "this host's project — commands use it from any folder. To move it, see '3minapi help init'"
					: `this host has no project. ${initHint(ctx.home)}`
			),
			projectConfig: entry(projectConfig, 'project settings — edit'),
			workersDir: entry(workersDir, 'worker files — edit'),
			env: entry(
				projectRoot && path.join(projectRoot, DOTENV_FILE),
				'secrets for workers — edit, do not print values'
			),
			db: entry(
				projectRoot && path.join(projectRoot, USER_DB_FILE),
				"SQLite file — saved task results (_3minapi_ tables, '3minapi worker results') and workers' own data"
			),
			userConfig: entry(
				path.join(dirs.config, USER_CONFIG_FILE),
				'user settings (project settings win)'
			),
			logs: entry(dirs.logs, "read with '3minapi logs' / '3minapi worker logs <name>'"),
			runnerOut: entry(
				path.join(dirs.logs, APP_LOG_DIR, RUNNER_OUT_FILE),
				"output of 'start --detach'"
			),
			localServerToken: entry(
				path.join(dirs.config, LOCAL_SERVER_TOKEN_FILE),
				"read only to call 'start --serve' from a local script"
			),
			controlDb: entry(
				path.join(dirs.data, CONTROL_DB_FILE),
				"task run history and internal state — do not edit ('3minapi tasks prune')"
			),
			projectRecord: entry(
				projectRecordPath(dirs.data),
				"which folder is this host's project — change with '3minapi init <folder> --move'"
			),
			credentials: entry(
				path.join(dirs.config, CREDENTIALS_FILE),
				'host token — do not read or share'
			)
		};

		const width = Math.max(...Object.keys(data).map((k) => k.length)) + 2;
		const text = Object.entries(data)
			.map(([key, e]) => {
				const value = e.path ?? '-';
				const missing = e.path !== null && !e.exists ? out.out.dim(' (not created yet)') : '';
				return `${key.padEnd(width)}${value}${missing}\n${' '.repeat(width)}${out.out.dim(e.note)}`;
			})
			.join('\n');
		out.result(data, text);
		return ExitCode.Ok;
	}
};
