/**
 * Environment variables seen by workers, and the project `.env`.
 *
 * - `ctx.env` = a copy of the system environment with the project `.env` layered on top. The Worker `env` option
 *   **replaces the whole environment** (PATH etc. would vanish), so the two are always merged. The parent's
 *   process.env is never modified
 * - Every `THREEMINAPI_*` variable is removed regardless of source (shell or .env), so worker code and the npm
 *   packages it imports cannot read the host token (THREEMINAPI_TOKEN) or public-mode keys
 *   (THREEMINAPI_WORKER_<NAME>_SECRET/_KEY)
 * - Public-mode keys are looked up in the process environment, then the project `.env` (`publicKeyEnv`). Servers
 *   can set them via deployment tooling, dev PCs via `.env` (init adds it to .gitignore)
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { CLI_ENV_PREFIX, ConfigError } from '../../../core/domain/index.ts';
import { readUserText } from '../../../core/text-file.ts';

export const DOTENV_FILE = '.env';

/**
 * Parsed `.env`, re-read only when the file changed (mtime, size). Public mode reads it per request, the executor per
 * task; it still stats every time, so edits apply without a restart.
 */
const cache = new Map<string, { mtimeMs: number; size: number; values: Record<string, string> }>();

/** Project `.env`; an empty object when absent */
export function readDotEnv(projectRoot: string): Record<string, string> {
	const file = path.join(projectRoot, DOTENV_FILE);
	let text: string;
	try {
		const stat = statSync(file, { throwIfNoEntry: false });
		if (!stat) {
			cache.delete(file);
			return {};
		}
		const hit = cache.get(file);
		if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return { ...hit.values };
		text = readUserText(file);
		const values = parseEnv(text) as Record<string, string>;
		cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, values });
		return { ...values };
	} catch (err) {
		if (err instanceof ConfigError) throw err; // UTF-16
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
		throw new ConfigError(`cannot read ${file}: ${(err as Error).message}`);
	}
}

/** The worker thread's full process.env (= ctx.env) */
export function workerEnv(
	projectRoot: string,
	base: NodeJS.ProcessEnv
): Record<string, string | undefined> {
	const merged: Record<string, string | undefined> = { ...base, ...readDotEnv(projectRoot) };
	for (const key of Object.keys(merged)) {
		if (key.startsWith(CLI_ENV_PREFIX)) delete merged[key];
	}
	return merged;
}

/** Environment public mode reads keys from — the process environment wins over `.env` */
export function publicKeyEnv(projectRoot: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return { ...readDotEnv(projectRoot), ...base };
}
