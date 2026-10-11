/**
 * Preconditions shared by several commands with the same message and exit code — login, project, workers folder.
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import { ApiClient, userAgent } from '../core/api.ts';
import { resolveHostToken, type HostToken } from '../core/credentials.ts';
import {
	BIN,
	CliError,
	ConfigError,
	PROJECT_CONFIG_FILE,
	type CommandContext,
	type ResolvedConfig
} from '../core/domain/index.ts';
import type { Session } from '../core/host/session.ts';
import { initHint } from '../core/project.ts';
import {
	claimUpdateNotice,
	readLatest,
	rememberLatest,
	updateInfo,
	updateNoticeLine,
	type UpdateInfo
} from '../core/update-notice.ts';

/** Client for the API address in this session's config */
export function client(ctx: CommandContext, session: Session, token: string): ApiClient {
	return new ApiClient({
		apiUrl: session.config.values.apiUrl,
		token,
		userAgent: userAgent(ctx.version, ctx.platform),
		signal: ctx.signal,
		onServerCli: (cli) =>
			rememberLatest(session.db, cli, ctx.now(), (m, a) => session.logger.debug(m, a))
	});
}

/**
 * Update notice — compares with the last received recommended version and, when due, prints to stderr (once per 24h).
 * Returns the result for `--json`. Makes no server call — the client records the recommended version from every response.
 * `running` = whether `start` is running on this host; if so, the notice adds "stop it first" (#1425)
 */
export function noticeUpdate(ctx: CommandContext, session: Session, running: boolean): UpdateInfo {
	const log = (m: string, a?: Record<string, unknown>) => session.logger.debug(m, a);
	const info = updateInfo(ctx.version, readLatest(session.db, log), running);
	if (claimUpdateNotice(session.db, info, ctx.now(), ctx.env, log)) {
		ctx.out.warn(updateNoticeLine(info));
	}
	return info;
}

export function requireToken(ctx: CommandContext): HostToken {
	const token = resolveHostToken(ctx.dirs.config, ctx.env);
	if (!token) throw new CliError(`Not logged in. Run '${BIN} login' first.`);
	return token;
}

/**
 * This host's project folder (where 3minapi.json lives, core/project.ts). Missing → config error (exit code 3)
 */
export function requireProject(config: ResolvedConfig): string {
	if (!config.projectRoot) {
		throw new ConfigError(
			`this host has no project (no ${PROJECT_CONFIG_FILE} recorded or found in this folder or above). ` +
				initHint()
		);
	}
	return config.projectRoot;
}

/** Absolute path of the workers folder — the config value may be relative to the project folder */
export function workersPath(root: string, config: ResolvedConfig): string {
	return path.resolve(root, config.values.workersDir);
}

/** For commands that need both the project and the workers folder */
export function requireWorkersDir(config: ResolvedConfig): { root: string; dir: string } {
	const root = requireProject(config);
	const dir = workersPath(root, config);
	if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
		throw new CliError(`workers folder ${dir} does not exist. Run '${BIN} init' to create it.`);
	}
	return { root, dir };
}
