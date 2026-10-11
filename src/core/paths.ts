/**
 * Per-OS directories — docs/design/15_cli.md §5.
 *
 * | OS      | config                                | data (control DB)       | logs                         |
 * |---------|---------------------------------------|-------------------------|------------------------------|
 * | macOS   | ~/Library/Application Support/3minapi | (same as config)        | ~/Library/Logs/3minapi       |
 * | Linux   | $XDG_CONFIG_HOME/3minapi              | $XDG_STATE_HOME/3minapi | $XDG_STATE_HOME/3minapi/logs |
 * | Windows | %APPDATA%\3minapi (Roaming)           | %LOCALAPPDATA%\3minapi  | %LOCALAPPDATA%\3minapi\logs  |
 *
 * The control DB and logs are "state and history kept across restarts", so under XDG they are state, not data.
 * If `THREEMINAPI_HOME` is set, all three live under it (tests, isolation, portable installs).
 */
import path from 'node:path';
import { APP_DIR_NAME, ENV, type Dirs } from './domain/index.ts';

export interface DirsInput {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	home: string;
}

export function resolveDirs({ platform, env, home }: DirsInput): Dirs {
	const p = platform === 'win32' ? path.win32 : path.posix;

	const override = absolute(p, env[ENV.home]);
	if (override) {
		return { config: override, data: override, logs: p.join(override, 'logs') };
	}

	if (platform === 'win32') {
		const roaming = absolute(p, env.APPDATA) ?? p.join(home, 'AppData', 'Roaming');
		const local = absolute(p, env.LOCALAPPDATA) ?? p.join(home, 'AppData', 'Local');
		const data = p.join(local, APP_DIR_NAME);
		return { config: p.join(roaming, APP_DIR_NAME), data, logs: p.join(data, 'logs') };
	}

	if (platform === 'darwin') {
		const support = p.join(home, 'Library', 'Application Support', APP_DIR_NAME);
		return { config: support, data: support, logs: p.join(home, 'Library', 'Logs', APP_DIR_NAME) };
	}

	// Linux and other Unix — XDG Base Directory. Relative values are ignored, per the spec.
	const configHome = absolute(p, env.XDG_CONFIG_HOME) ?? p.join(home, '.config');
	const stateHome = absolute(p, env.XDG_STATE_HOME) ?? p.join(home, '.local', 'state');
	const data = p.join(stateHome, APP_DIR_NAME);
	return { config: p.join(configHome, APP_DIR_NAME), data, logs: p.join(data, 'logs') };
}

function absolute(p: path.PlatformPath, value: string | undefined): string | undefined {
	return value && p.isAbsolute(value) ? value : undefined;
}
