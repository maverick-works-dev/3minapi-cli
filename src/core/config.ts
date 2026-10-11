/**
 * Config layer merge — docs/design/15_cli.md §5.
 *
 *   flags > env vars (THREEMINAPI_*) > project config (3minapi.json) > user config (<config>/config.json) > defaults
 *
 * The project is the one recorded for this host (core/project.ts) — cwd is used only when nothing is recorded.
 *
 * The env var prefix is not `3MINAPI_` because POSIX shell variable names cannot start with a digit.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
	BIN,
	CONCURRENCY_MAX,
	CONCURRENCY_MIN,
	ConfigError,
	DEFAULT_API_URL,
	DEFAULT_CONCURRENCY,
	DEFAULT_LOCAL_SERVER_PORT,
	DEFAULT_LOG_MAX_BYTES,
	DEFAULT_LOG_RETENTION_DAYS,
	DEFAULT_POLL_INTERVAL_MS,
	DEFAULT_WORKERS_DIR,
	ENV,
	LOG_MAX_BYTES_MAX,
	LOG_MAX_BYTES_MIN,
	LOG_RETENTION_MAX_DAYS,
	LOG_RETENTION_MIN_DAYS,
	LOCAL_SERVER_PORT_MAX,
	LOCAL_SERVER_PORT_MIN,
	POLL_INTERVAL_MAX_MS,
	POLL_INTERVAL_MIN_MS,
	PROJECT_CONFIG_FILE,
	RECEIVE_MODES,
	USER_CONFIG_FILE,
	type Config,
	type ConfigKey,
	type ConfigSource,
	type ResolvedConfig
} from './domain/index.ts';
import { readUserText } from './text-file.ts';

export const DEFAULTS: Config = {
	apiUrl: DEFAULT_API_URL,
	workersDir: DEFAULT_WORKERS_DIR,
	pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
	logRetentionDays: DEFAULT_LOG_RETENTION_DAYS,
	logMaxBytes: DEFAULT_LOG_MAX_BYTES,
	concurrency: DEFAULT_CONCURRENCY,
	localServerPort: DEFAULT_LOCAL_SERVER_PORT,
	receiveMode: 'live'
};

const ENV_KEYS: Partial<Record<ConfigKey, string>> = {
	apiUrl: ENV.apiUrl,
	pollIntervalMs: ENV.pollIntervalMs,
	logRetentionDays: ENV.logRetentionDays,
	logMaxBytes: ENV.logMaxBytes,
	concurrency: ENV.concurrency,
	localServerPort: ENV.localServerPort,
	receiveMode: ENV.receiveMode
};

/** Flags whose names differ from their config keys */
const FLAG_NAMES: Partial<Record<ConfigKey, string>> = {
	localServerPort: '--port',
	receiveMode: '--mode'
};

/** Allowed ranges for integer settings */
const INTEGER_RANGES: Partial<Record<ConfigKey, [number, number]>> = {
	pollIntervalMs: [POLL_INTERVAL_MIN_MS, POLL_INTERVAL_MAX_MS],
	logRetentionDays: [LOG_RETENTION_MIN_DAYS, LOG_RETENTION_MAX_DAYS],
	logMaxBytes: [LOG_MAX_BYTES_MIN, LOG_MAX_BYTES_MAX],
	concurrency: [CONCURRENCY_MIN, CONCURRENCY_MAX],
	localServerPort: [LOCAL_SERVER_PORT_MIN, LOCAL_SERVER_PORT_MAX]
};

export interface LoadConfigInput {
	cwd: string;
	env: NodeJS.ProcessEnv;
	configDir: string;
	/** Project config file given with --config. When set, no upward search */
	configFile?: string;
	/**
	 * This host's project file (as resolved by core/project.ts; null = none). When set, cwd is not searched — one project per
	 * host. When omitted, searches upward from cwd (config unit tests)
	 */
	projectFile?: string | null;
	flags?: Partial<Record<ConfigKey, string>>;
}

export function loadConfig(input: LoadConfigInput): ResolvedConfig {
	const warnings: string[] = [];
	const userFile = path.join(input.configDir, USER_CONFIG_FILE);

	let projectFile: string | null;
	if (input.configFile !== undefined) {
		projectFile = path.resolve(input.cwd, input.configFile);
		if (!existsSync(projectFile)) throw new ConfigError(`config file not found: ${projectFile}`);
	} else if (input.projectFile !== undefined) {
		projectFile = input.projectFile;
	} else {
		projectFile = findProjectFile(input.cwd);
	}

	const layers: [ConfigSource, Partial<Record<ConfigKey, unknown>>][] = [
		['flag', input.flags ?? {}],
		['env', fromEnv(input.env)],
		['project', projectFile ? projectLayer(projectFile, warnings) : {}],
		['user', existsSync(userFile) ? readJsonObject(userFile, warnings) : {}]
	];

	const values = { ...DEFAULTS };
	const sources = Object.fromEntries(
		Object.keys(DEFAULTS).map((k) => [k, 'default' as ConfigSource])
	) as Record<ConfigKey, ConfigSource>;

	for (const key of Object.keys(DEFAULTS) as ConfigKey[]) {
		for (const [source, layer] of layers) {
			const raw = layer[key];
			if (raw === undefined) continue;
			setValue(values, key, raw, source);
			sources[key] = source;
			break;
		}
	}

	return {
		values,
		sources,
		projectRoot: projectFile ? path.dirname(projectFile) : null,
		projectFile,
		userFile,
		warnings
	};
}

/**
 * Project config layer. **`apiUrl` is not accepted** — project files are committed to repositories and may be recorded from a folder
 * someone else made (a cloned example). Following an address there would send the host token to it. Only flags, env vars and user config set the API address (docs/design/15_cli.md §7-1 "token destination")
 */
function projectLayer(file: string, warnings: string[]): Partial<Record<ConfigKey, unknown>> {
	const layer = readJsonObject(file, warnings);
	if (layer.apiUrl !== undefined) {
		delete layer.apiUrl;
		warnings.push(
			`apiUrl in ${file} is ignored — a project file must not decide where your host token is sent. ` +
				`Set it with --api-url, ${ENV.apiUrl} or ${USER_CONFIG_FILE} in the CLI config folder ('${BIN} paths'), and remove it from ${file}.`
		);
	}
	return layer;
}

/** Searches upward from cwd for 3minapi.json (the way git finds .git) */
export function findProjectFile(cwd: string): string | null {
	let dir = path.resolve(cwd);
	for (;;) {
		const candidate = path.join(dir, PROJECT_CONFIG_FILE);
		if (existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function fromEnv(env: NodeJS.ProcessEnv): Partial<Record<ConfigKey, string>> {
	const out: Partial<Record<ConfigKey, string>> = {};
	for (const [key, name] of Object.entries(ENV_KEYS) as [ConfigKey, string][]) {
		const v = env[name];
		if (v !== undefined && v !== '') out[key] = v;
	}
	return out;
}

function readJsonObject(file: string, warnings: string[]): Partial<Record<ConfigKey, unknown>> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readUserText(file));
	} catch (err) {
		if (err instanceof ConfigError) throw err; // UTF-16 — already a message with the path and fix
		throw new ConfigError(`cannot read ${file}: ${(err as Error).message}`);
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new ConfigError(`${file} must contain a JSON object`);
	}
	for (const key of Object.keys(parsed)) {
		if (!(key in DEFAULTS)) warnings.push(`unknown key "${key}" in ${file} (ignored)`);
	}
	return parsed as Partial<Record<ConfigKey, unknown>>;
}

function setValue(values: Config, key: ConfigKey, raw: unknown, source: ConfigSource): void {
	const where =
		source === 'env'
			? ENV_KEYS[key]
			: source === 'flag'
				? (FLAG_NAMES[key] ?? `--${kebab(key)}`)
				: key;
	switch (key) {
		case 'apiUrl': {
			if (typeof raw !== 'string' || !isApiUrl(raw)) {
				throw new ConfigError(
					`${where} must be an https URL (http only for 127.0.0.1, localhost or [::1])`
				);
			}
			values.apiUrl = raw.replace(/\/+$/, '');
			return;
		}
		case 'workersDir': {
			if (typeof raw !== 'string' || raw.trim() === '' || path.isAbsolute(raw)) {
				throw new ConfigError(`${where} must be a relative directory path`);
			}
			// Pointing outside the project would make worker delete/init delete or create files outside it (#1410)
			const normalized = path.normalize(raw);
			if (
				normalized === '..' ||
				normalized.startsWith(`..${path.sep}`) ||
				normalized.startsWith('../')
			) {
				throw new ConfigError(`${where} must be inside the project folder`);
			}
			values.workersDir = raw;
			return;
		}
		case 'pollIntervalMs':
		case 'logRetentionDays':
		case 'logMaxBytes':
		case 'concurrency':
		case 'localServerPort': {
			const [min, max] = INTEGER_RANGES[key]!;
			const n = typeof raw === 'string' ? Number(raw) : raw;
			if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
				throw new ConfigError(`${where} must be an integer between ${min} and ${max}`);
			}
			values[key] = n;
			return;
		}
		case 'receiveMode': {
			if (typeof raw !== 'string' || !(RECEIVE_MODES as readonly string[]).includes(raw)) {
				throw new ConfigError(`${where} must be one of: ${RECEIVE_MODES.join(', ')}`);
			}
			values.receiveMode = raw as Config['receiveMode'];
			return;
		}
	}
}

/** https, or http only for this PC (loopback) — never send the host token over the network in plaintext (#1410) */
function isApiUrl(value: string): boolean {
	try {
		const u = new URL(value);
		if (u.protocol === 'https:') return true;
		return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
	} catch {
		return false;
	}
}

function kebab(key: string): string {
	return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}
