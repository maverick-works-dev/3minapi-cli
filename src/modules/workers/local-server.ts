/**
 * Local server — `start --serve` (docs/design/15_cli.md §8-4). Off by default: pull doesn't need it.
 *
 *   GET  /health        → 200 { ok, version }
 *   POST /task/<name>   → 202 { success, task_id }, then runs from the queue (same handler as pull)
 *
 * Local mode (default, bound to 127.0.0.1 only) — for scripts on the same PC:
 *   - Rejects a Host header other than 127.0.0.1, localhost or [::1]:<port> (DNS rebinding)
 *   - Rejects any Origin header or a Sec-Fetch-Site other than `none` (browser CSRF — simple requests carry no Origin)
 *   - Requires `Authorization: Bearer <local-server-token>`. Compared with timingSafeEqual over SHA-256 of both sides (length-independent)
 *   - Results are not replied — read them with `3minapi worker logs <name>`
 *
 * In both modes, workers inactive in this run (sync rejection, server-side deletion,
 * docs/design/14_cli_host.md §10) get 409
 *
 * Public mode (`--public`, 0.0.0.0) — 3Min API calls it directly under the push worker contract (docs/design/13_task.md §4):
 *   - Standard Webhooks signature check (±5 min); 2xx within 15 s — responds 202 on receipt
 *   - Pre-auth rejections run cheapest first and the body is read last: path/name → signature headers/time → configured → body → HMAC.
 *     A pre-auth 401 is a single word (`unauthorized`) — it never reveals which workers are configured or env names.
 *     Details go only to onRejected, locally (#1413)
 *   - Secret and reply key per worker from env THREEMINAPI_WORKER_<NAME>_SECRET / _KEY (no secrets in files)
 *   - Long-running Node servers only. Serverless (Vercel, Lambda) freezes execution after the response, so it is unsupported
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
	PUSH_TIMESTAMP_TOLERANCE_S,
	REPORT_MAX_BYTES,
	WORKER_KEY_ENV,
	WORKER_SECRET_ENV,
	isPullWorkerName
} from '../../core/domain/index.ts';
import { resolveWorkerFile } from './runtime/resolve.ts';
import type { Reporter, TaskEnvelope } from './task-runner.ts';

const TASK_PATH = /^\/task\/([^/]+)$/;

export interface LocalServerOptions {
	port: number;
	/** true = public mode */
	public: boolean;
	/** Local mode token (credentials.ts getOrCreateLocalServerToken) */
	token: string;
	workersDir: string;
	/** Reads per-worker secret and key for public mode. If a function, called per request (.env edits apply at once) */
	env: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);
	version: string;
	/**
	 * Whether this run accepts the worker — a reason sentence if inactive from sync rejection or server-side deletion
	 * (docs/design/14_cli_host.md §10). If omitted, all workers are accepted
	 */
	inactive?(name: string): string | null;
	/** Current time in seconds — for the signature time check. Tests shift it */
	nowSeconds?(): number;
	onTask(task: TaskEnvelope, reporter: Reporter | null): void;
	/** Public mode — Reporter that replies with that worker's tm_task_ key */
	reporterFor(key: string): Reporter;
	/**
	 * Public mode rejected a request that had signature headers before auth — the reason (not configured, env name,
	 * signature mismatch, time out of window) is not put in the response, only passed here (local log). Requests with no
	 * signature headers at all are not passed (internet scanners)
	 */
	onRejected?(worker: string, reason: string): void;
	/** Exception while handling a request — the response says only `internal error`; the original goes here */
	onError?(err: unknown): void;
}

/** Pre-auth 401 — public mode never reveals the reason */
const UNAUTHORIZED: Reply = { status: 401, body: { success: false, error: 'unauthorized' } };

export interface LocalServer {
	url: string;
	port: number;
	close(): Promise<void>;
}

interface Reply {
	status: number;
	body: unknown;
}

export async function startLocalServer(opts: LocalServerOptions): Promise<LocalServer> {
	const tokenDigest = sha256(opts.token);
	const server = createServer((req, res) => {
		handle(opts, tokenDigest, req, actualPort)
			.then((reply) => send(res, reply))
			.catch((err: unknown) => {
				// Original only locally — anyone can call public mode (#1413)
				opts.onError?.(err);
				send(res, { status: 500, body: error('internal error') });
			});
	});
	const host = opts.public ? '0.0.0.0' : '127.0.0.1';
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(opts.port, host, () => {
			server.off('error', reject);
			resolve();
		});
	}).catch((err: NodeJS.ErrnoException) => {
		if (err.code === 'EADDRINUSE') {
			throw Object.assign(
				new Error(`port ${opts.port} is already in use — pick another with --port`),
				{
					code: err.code
				}
			);
		}
		throw err;
	});
	const actualPort = (server.address() as AddressInfo).port;
	return {
		url: `http://${opts.public ? '0.0.0.0' : '127.0.0.1'}:${actualPort}`,
		port: actualPort,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			})
	};
}

async function handle(
	opts: LocalServerOptions,
	tokenDigest: Buffer,
	req: IncomingMessage,
	port: number
): Promise<Reply> {
	const url = new URL(req.url ?? '/', 'http://localhost');

	if (!opts.public) {
		const denied = localGuard(req, port);
		if (denied) return denied;
	}

	if (url.pathname === '/health') {
		if (req.method !== 'GET') return { status: 405, body: error('use GET') };
		return { status: 200, body: { ok: true, version: opts.version } };
	}

	const match = TASK_PATH.exec(url.pathname);
	if (!match) return { status: 404, body: error('not found. Use POST /task/<worker>') };
	if (req.method !== 'POST') return { status: 405, body: error('use POST') };
	let name: string;
	try {
		name = decodeURIComponent(match[1]);
	} catch {
		// Malformed % encoding — no such worker
		return { status: 404, body: error('not found. Use POST /task/<worker>') };
	}

	let secrets: { secret: string; key: string } | null = null;
	if (opts.public) {
		if (!isPullWorkerName(name)) return { status: 404, body: error(`unknown worker "${name}"`) };
		// Before reading the body — don't spend memory or disk on requests rejectable by signature headers and time alone
		const now = opts.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
		const headers = signatureHeaders(req, now);
		if (headers === 'missing') return UNAUTHORIZED; // scanner — not logged
		if (headers !== null) {
			opts.onRejected?.(name, headers);
			return UNAUTHORIZED;
		}
		const env = typeof opts.env === 'function' ? opts.env() : opts.env;
		const secret = env[WORKER_SECRET_ENV(name)];
		const key = env[WORKER_KEY_ENV(name)];
		if (!secret || !key) {
			opts.onRejected?.(
				name,
				`not configured as a public worker (${WORKER_SECRET_ENV(name)} / ${WORKER_KEY_ENV(name)})`
			);
			return UNAUTHORIZED;
		}
		secrets = { secret, key };
	}

	if (!opts.public && !bearerMatches(req.headers.authorization, tokenDigest)) {
		return {
			status: 401,
			body: error('missing or wrong local server token (Authorization: Bearer <token>)')
		};
	}
	if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
		return { status: 415, body: error('Content-Type must be application/json') };
	}
	const raw = await readBody(req, REPORT_MAX_BYTES);
	if (raw === null) return { status: 413, body: error(`body exceeds ${REPORT_MAX_BYTES} bytes`) };

	let reporter: Reporter | null = null;
	if (secrets) {
		const now = opts.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
		const invalid = verifySignature(secrets.secret, req, raw, now);
		if (invalid) {
			opts.onRejected?.(name, invalid);
			return UNAUTHORIZED;
		}
		reporter = opts.reporterFor(secrets.key);
	}

	let body: unknown;
	try {
		body = JSON.parse(raw.toString('utf8'));
	} catch {
		return { status: 400, body: error('body is not valid JSON') };
	}
	const task = toEnvelope(body, name, req, opts.public);
	if (typeof task === 'string') return { status: 400, body: error(task) };

	const found = resolveWorkerFile(opts.workersDir, name);
	if (!found.ok && found.reason === 'worker_not_found')
		return { status: 404, body: error(found.message) };
	const inactive = opts.inactive?.(name) ?? null;
	if (inactive !== null) return { status: 409, body: error(inactive) };

	opts.onTask(task, reporter);
	return { status: 202, body: { success: true, task_id: task.task_id } };
}

function localGuard(req: IncomingMessage, port: number): Reply | null {
	const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
	const host = (req.headers.host ?? '').toLowerCase();
	if (!allowed.includes(host)) {
		return { status: 403, body: error('Host header must be 127.0.0.1 or localhost') };
	}
	if (req.headers.origin !== undefined) {
		return { status: 403, body: error('requests from web pages are not accepted') };
	}
	const site = req.headers['sec-fetch-site'];
	if (site !== undefined && site !== 'none') {
		return { status: 403, body: error('requests from web pages are not accepted') };
	}
	return null;
}

function toEnvelope(
	body: unknown,
	worker: string,
	req: IncomingMessage,
	isPublic: boolean
): TaskEnvelope | string {
	if (typeof body !== 'object' || body === null || Array.isArray(body))
		return 'body must be a JSON object';
	const b = body as Record<string, unknown>;
	const attempt = Number(req.headers['x-3minapi-delivery-attempt'] ?? 1);
	const delivery_attempt = Number.isInteger(attempt) && attempt > 0 ? attempt : 1;

	if (b.type === 'task.created' && typeof b.data === 'object' && b.data !== null) {
		const d = b.data as Record<string, unknown>;
		if (isPublic) {
			if (typeof d.task_id !== 'string' || d.task_id !== req.headers['webhook-id']) {
				return 'data.task_id must match the webhook-id header';
			}
			if (typeof d.callback_url !== 'string') return 'data.callback_url is required';
		}
		return {
			// Local mode ignores the caller's task_id — an id equal to a real pull task would cut off that running task
			// (superseded) or make the later real delivery be dropped as "already done"
			task_id: isPublic ? (d.task_id as string) : randomUUID(),
			worker,
			input: d.input ?? {},
			// Local mode doesn't reply — the host token is never sent to an address chosen by the local caller
			callback_url: isPublic ? (d.callback_url as string) : null,
			lease_id: null,
			delivery_attempt,
			source: isPublic ? 'public' : 'serve'
		};
	}
	if (isPublic) return 'expected a task.created envelope';
	if (!('input' in b)) return 'expected {"input": ...} or a task.created envelope';
	return {
		task_id: randomUUID(),
		worker,
		input: b.input,
		callback_url: null,
		lease_id: null,
		delivery_attempt,
		source: 'serve'
	};
}

/**
 * Signature conditions checkable without the body — the 3 headers and the time. null if satisfied, 'missing' if
 * headers are absent (scanner — not logged), otherwise the reason when the time is out of window
 */
function signatureHeaders(
	req: Pick<IncomingMessage, 'headers'>,
	nowSeconds: number
): string | null {
	const { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': sig } = req.headers;
	if (typeof id !== 'string' || typeof ts !== 'string' || typeof sig !== 'string') return 'missing';
	const t = Number(ts);
	if (!Number.isInteger(t) || Math.abs(nowSeconds - t) > PUSH_TIMESTAMP_TOLERANCE_S) {
		return 'webhook-timestamp is outside the allowed window';
	}
	return null;
}

/** Standard Webhooks — HMAC-SHA256 of `{id}.{timestamp}.{body}`, base64. null if it matches, otherwise the reason */
export function verifySignature(
	secret: string,
	req: Pick<IncomingMessage, 'headers'>,
	raw: Buffer,
	nowSeconds: number
): string | null {
	const id = req.headers['webhook-id'];
	const ts = req.headers['webhook-timestamp'];
	const sig = req.headers['webhook-signature'];
	if (typeof id !== 'string' || typeof ts !== 'string' || typeof sig !== 'string') {
		return 'missing webhook-id / webhook-timestamp / webhook-signature headers';
	}
	const t = Number(ts);
	if (!Number.isInteger(t) || Math.abs(nowSeconds - t) > PUSH_TIMESTAMP_TOLERANCE_S) {
		return 'webhook-timestamp is outside the allowed window';
	}
	const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
	const expected = createHmac('sha256', key).update(`${id}.${ts}.`).update(raw).digest();
	for (const part of sig.split(' ')) {
		const [version, value] = part.split(',', 2);
		if (version !== 'v1' || !value) continue;
		const given = Buffer.from(value, 'base64');
		if (given.length === expected.length && timingSafeEqual(given, expected)) return null;
	}
	return 'webhook-signature does not match';
}

function bearerMatches(header: string | undefined, digest: Buffer): boolean {
	const m = header?.match(/^Bearer\s+(\S+)$/i);
	return m !== null && m !== undefined && timingSafeEqual(sha256(m[1]), digest);
}

function sha256(value: string): Buffer {
	return createHash('sha256').update(value).digest();
}

/**
 * null if over the limit. Keeps reading a little past it so the 413 response arrives, and drops the connection if far too large
 */
async function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > max * 4) {
			req.destroy();
			return null;
		}
		if (size <= max) chunks.push(chunk as Buffer);
	}
	return size > max ? null : Buffer.concat(chunks);
}

function send(res: ServerResponse, reply: Reply): void {
	if (res.headersSent || res.destroyed) return;
	res.writeHead(reply.status, { 'content-type': 'application/json; charset=utf-8' });
	res.end(JSON.stringify(reply.body));
}

function error(message: string) {
	return { success: false, error: message };
}
