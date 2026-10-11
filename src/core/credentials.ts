/**
 * Host token and local server token storage — docs/design/15_cli.md §7-1.
 *
 * - Host token: `THREEMINAPI_TOKEN` env var > `<config>/credentials.json` (0600). An env var token is never written to disk
 * - Local server token: `<config>/local-server-token` (0600). Separate file and code path from the host token, so a leak
 *   from the local server does not take the server credential with it
 * - No OS keychain (zero runtime dependencies). Kept in this one file so a backend can be added here later
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
	CREDENTIALS_FILE,
	ConfigError,
	ENV,
	HOST_TOKEN_PREFIX,
	LOCAL_SERVER_TOKEN_FILE
} from './domain/index.ts';
import { writeSecretFile } from './secure-fs.ts';

const HOST_TOKEN = new RegExp(`^${HOST_TOKEN_PREFIX}[0-9a-f]{48}$`);

export type TokenSource = 'env' | 'file';

export interface HostToken {
	token: string;
	source: TokenSource;
	/** Storage path when source is file; variable name when env */
	location: string;
}

interface CredentialsFile {
	hostToken: string;
	savedAt: string;
}

export function isHostToken(value: string): boolean {
	return HOST_TOKEN.test(value);
}

export function credentialsPath(configDir: string): string {
	return path.join(configDir, CREDENTIALS_FILE);
}

/** The host token to use, or null. A malformed token throws ConfigError saying where to fix it */
export function resolveHostToken(configDir: string, env: NodeJS.ProcessEnv): HostToken | null {
	const fromEnv = env[ENV.token];
	if (fromEnv !== undefined && fromEnv !== '') {
		const token = fromEnv.trim();
		if (!isHostToken(token)) {
			throw new ConfigError(`${ENV.token} is not a host token (expected ${HOST_TOKEN_PREFIX}...)`);
		}
		return { token, source: 'env', location: ENV.token };
	}
	const file = credentialsPath(configDir);
	const saved = readCredentials(file);
	return saved ? { token: saved.hostToken, source: 'file', location: file } : null;
}

export function saveHostToken(configDir: string, token: string, now: number): string {
	if (!isHostToken(token))
		throw new ConfigError(`not a host token (expected ${HOST_TOKEN_PREFIX}...)`);
	const file = credentialsPath(configDir);
	const body: CredentialsFile = { hostToken: token, savedAt: new Date(now).toISOString() };
	writeSecretFile(file, JSON.stringify(body, null, '\t') + '\n');
	return file;
}

/** Deletes the stored token. true if one was deleted */
export function deleteHostToken(configDir: string): boolean {
	const file = credentialsPath(configDir);
	if (!existsSync(file)) return false;
	rmSync(file);
	return true;
}

/** Token for the local server; created if missing */
export function getOrCreateLocalServerToken(configDir: string): string {
	const file = path.join(configDir, LOCAL_SERVER_TOKEN_FILE);
	if (existsSync(file)) {
		const token = readFileSync(file, 'utf8').trim();
		if (/^[0-9a-f]{64}$/.test(token)) return token;
	}
	const token = randomBytes(32).toString('hex');
	writeSecretFile(file, token + '\n');
	return token;
}

function readCredentials(file: string): CredentialsFile | null {
	let text: string;
	try {
		text = readFileSync(file, 'utf8');
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') return null;
		throw new ConfigError(`cannot read ${file} (${code ?? (err as Error).message})`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ConfigError(`${file} is corrupted. Run '3minapi login' again.`);
	}
	const token = (parsed as Partial<CredentialsFile> | null)?.hostToken;
	if (typeof token !== 'string' || !isHostToken(token)) {
		throw new ConfigError(`${file} does not hold a valid host token. Run '3minapi login' again.`);
	}
	return parsed as CredentialsFile;
}
