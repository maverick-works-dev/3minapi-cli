/**
 * Constants and wire types of the CLI host contract — 1:1 with docs/design/14_cli_host.md, which every bare §N in
 * this file refers to. **This file is the single code source of the contract**; the CLI and its test mock server
 * both import it.
 *
 * ⚠️ Change the contract in order: the doc → this file → mock and CLI. Changing only this file lets the CLI pass
 * against the mock and break against the real server.
 */

// ── Error codes (§6-3) ──────────────────────────────────────────

/**
 * Codes on which the CLI must stop all calls. A stop is decided only by these codes (§6-2).
 * `cli_outdated` means this CLI is below the server's minimum supported version — only an update clears it (§6-5).
 */
export const STOP_CODES = [
	'host_token_invalid',
	'no_subscription',
	'quota_exhausted',
	'cli_outdated'
] as const;

/** Codes where only that task (or that run) is dropped. */
export const TASK_CODES = ['task_not_found', 'task_terminal', 'lease_superseded'] as const;

export const OTHER_CODES = [
	'poll_too_soon',
	'invalid_request',
	/** Only from delete (§3-5) — this host has no local worker by that name. Distinct from a 404 without `code` */
	'worker_not_found',
	'payload_too_large',
	'unsupported_media_type',
	'service_unavailable'
] as const;

export type StopCode = (typeof STOP_CODES)[number];
export type TaskCode = (typeof TASK_CODES)[number];
export type ServerErrorCode = StopCode | TaskCode | (typeof OTHER_CODES)[number];

export function isStopCode(code: unknown): code is StopCode {
	return typeof code === 'string' && (STOP_CODES as readonly string[]).includes(code);
}

/** Sync response `rejected[].code` (§6-4). Neither an HTTP error nor a stop code — only that worker is disabled. */
export const SYNC_REJECT_CODES = [
	'invalid_worker_name',
	'description_too_long',
	'worker_name_taken'
] as const;
export type SyncRejectCode = (typeof SYNC_REJECT_CODES)[number];

// ── Numbers (§3, §4) ─────────────────────────────────────────────

export const HOST_TOKEN_PREFIX = 'tm_host_';
/** pull `max` — server default and range 0–50. 0 returns cancellations only, with no lease. The CLI sends its free slots, not the default */
export const PULL_MAX_DEFAULT = 10;
export const PULL_MAX_LIMIT = 50;
/** Minimum poll interval the server enforces. Each response's `poll.min_interval_ms` is authoritative (§3-2) */
export const POLL_MIN_INTERVAL_MS = 5_000;
export const LEASE_MS = 60_000;
/** Production value; 4 on staging — the same as the push retry count (§4). */
export const MAX_DELIVERIES = 6;
/** Total report body cap — docs/design/13_task.md §7 */
export const REPORT_MAX_BYTES = 100 * 1024;
/** status_message cap — docs/design/13_task.md §5; longer values are truncated */
export const STATUS_MESSAGE_MAX_CHARS = 256;
export const LEASE_EXPIRED_REASON = 'lease expired without acknowledgement';
/**
 * error.code of a `failed` report. docs/design/13_task.md fixes only the JSON-RPC shape `{code: integer, message, data?}`
 * and uses a single value, -32000 (24-hour expiry, delivery failure). The CLI uses it too and tells kinds apart by data.reason.
 */
export const TASK_ERROR_CODE = -32000;

// ── Live channel — live receive (§13) ─────────────────────────

/**
 * Receive mode — **when** the CLI pulls. Separate from the delivery path (push/pull); in live mode tasks still arrive
 * by pull (§13). Default is live; no automatic switching.
 */
export const RECEIVE_MODES = ['live', 'poll'] as const;
export type ReceiveMode = (typeof RECEIVE_MODES)[number];

/** Topics the server sends (§13-3). `workers` → pull, `host` → `GET /host` */
export const LIVE_TOPICS = ['workers', 'host'] as const;
/** Reserved topics — the server does not send them; the CLI ignores them like unknown topics (§13-3) */
export const LIVE_RESERVED_TOPICS = ['update', 'config'] as const;
export type LiveTopic = (typeof LIVE_TOPICS)[number];

export function isLiveTopic(topic: unknown): topic is LiveTopic {
	return typeof topic === 'string' && (LIVE_TOPICS as readonly string[]).includes(topic);
}

/** The CLI's app-level keepalive. A fixed string, not JSON — the server answers it only on an exact match (§13-2) */
export const LIVE_PING = 'ping';
export const LIVE_PONG = 'pong';
/** Ping interval and pong wait. Past the wait, disconnect and reconnect — detects buffering proxies and half-open connections (§13-5) */
export const LIVE_PING_INTERVAL_MS = 30_000;
export const LIVE_PONG_TIMEOUT_MS = 10_000;

/**
 * Close codes the server uses (§13-5). ⚠️ **None is a stop signal** — a stop is decided only by the HTTP body `code` (§6-2).
 * Any other code (deploys, network — deploy codes are undocumented) means a jittered reconnect.
 */
export const LIVE_CLOSE = {
	/** Replaced by a newer connection for the same host — wait the backoff cap instead of reconnecting at once */
	REPLACED: 4000,
	/** Rejected for a stop reason — decide by the body `code` of `GET /host` */
	CHECK_HOST: 4001
} as const;
export type LiveCloseCode = (typeof LIVE_CLOSE)[keyof typeof LIVE_CLOSE];

/** Close reason the server sends (§13-5). **Never used for decisions** (logs only) — keeps server and mock strings identical */
export const LIVE_CLOSE_REASON: Record<LiveCloseCode, string> = {
	[LIVE_CLOSE.REPLACED]: 'replaced',
	[LIVE_CLOSE.CHECK_HOST]: 'check_host'
};

/**
 * Upper bound of the first reconnect's uniform jitter (0 to this). Server deploys and network events drop many hosts
 * at once; reconnects bunched near 1 s cause 503s and a retry storm (§13-5)
 */
export const LIVE_RECONNECT_FIRST_JITTER_MS = 30_000;
/** Reconnect backoff cap — at most 12 per hour in the worst case (§7) */
export const LIVE_RECONNECT_MAX_MS = 300_000;
/** Backoff resets only after a connection lasts this long — so a flapping connection isn't charged every second */
export const LIVE_RECONNECT_STABLE_MS = 60_000;
/**
 * Live has no configured interval — this is the interval for retrying a pull or startup sync that failed without
 * `code`, and for resending pending terminal reports (§13-6, §13-9). No backoff
 */
export const LIVE_RETRY_MS = 60_000;
/** After this long of non-101 failures on a once-connected host, refetch `live.url` via `GET /host` — it may have moved (§13-5) */
export const LIVE_URL_REFRESH_AFTER_MS = 30 * 60_000;

const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'];

/**
 * Whether the host token may be sent to a server-provided `live.url` (§13-1). Same rule as the `callback_url` origin
 * check — a single server response must never send the token to another host. `wss:` only (`ws:` only when `apiUrl`
 * is loopback http); hostname and port must equal `apiUrl`'s.
 */
export function isTrustedLiveUrl(liveUrl: string, apiUrl: string): boolean {
	let live: URL;
	let api: URL;
	try {
		live = new URL(liveUrl);
		api = new URL(apiUrl);
	} catch {
		return false;
	}
	const secure = api.protocol === 'https:' && live.protocol === 'wss:';
	const loopback =
		api.protocol === 'http:' &&
		live.protocol === 'ws:' &&
		LOOPBACK_HOSTNAMES.includes(api.hostname);
	if (!secure && !loopback) return false;
	// URL.port is '' for default ports — https 443 ↔ wss 443 and http 80 ↔ ws 80, so a direct compare works
	return (
		live.hostname === api.hostname &&
		live.port === api.port &&
		live.username === '' &&
		live.password === ''
	);
}

// ── Worker sync (§3-4) ───────────────────────────────────────

/** Max workers per request — guards request size. The worker count itself is unlimited */
export const SYNC_WORKERS_MAX = 200;
/** Server limit on worker descriptions (docs/design/13_task.md §7) */
export const WORKER_DESCRIPTION_MAX_CHARS = 500;

// ── Worker names (§8) ───────────────────────────────────────────

/** Kept narrow because the name is both a file name (`workers/<name>`) and a local path (`/task/<name>`) */
export const PULL_WORKER_NAME = /^[a-z0-9_-]{1,50}$/;
/** Windows reserved device names — cannot be created as files */
export const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

export function isPullWorkerName(name: unknown): name is string {
	return (
		typeof name === 'string' && PULL_WORKER_NAME.test(name) && !WINDOWS_RESERVED_NAME.test(name)
	);
}

/**
 * Local worker names starting with `_` are reserved for built-in workers. Sync accepts only this host's built-in
 * name and rejects the rest with `invalid_worker_name`. The character rule (`PULL_WORKER_NAME`) is unchanged — `_` is
 * already allowed. Public worker names are not reserved
 */
export const RESERVED_NAME_PREFIX = '_';
export const BUILTIN_RESULTS_PREFIX = '_results_';
/** Characters taken from the host id — the head of a UUIDv7 is a timestamp and collides for hosts made together, so use the random tail */
export const BUILTIN_HOST_SUFFIX_CHARS = 8;

/** This host's built-in read worker name — `_results_` + last 8 chars of the host id (hyphens removed). The server derives it the same way */
export function builtinResultsName(hostId: string): string {
	return (
		BUILTIN_RESULTS_PREFIX +
		hostId.replace(/-/g, '').toLowerCase().slice(-BUILTIN_HOST_SUFFIX_CHARS)
	);
}

export function isReservedWorkerName(name: string): boolean {
	return name.startsWith(RESERVED_NAME_PREFIX);
}

/** Whether sync accepts the name — this host's built-in name, or a valid name not starting with `_` */
export function isSyncableWorkerName(name: unknown, hostId: string): name is string {
	if (!isPullWorkerName(name)) return false;
	return !isReservedWorkerName(name) || name === builtinResultsName(hostId);
}

// ── Wire types ────────────────────────────────────────────────

export type TaskStatus = 'working' | 'completed' | 'failed' | 'cancelled';

export interface Quota {
	limit: number;
	used: number;
	remaining: number;
	/** ISO 8601 UTC. The CLI uses this, not the X-RateLimit-Reset header (§6-3). */
	reset_at: string;
}

export interface Poll {
	min_interval_ms: number;
}

/** Push envelope (docs/design/13_task.md §4) plus four pull fields (§3-2) */
export interface PulledTask {
	type: 'task.created';
	timestamp: string;
	worker: string;
	delivery_attempt: number;
	lease_id: string;
	lease_expires_at: string;
	data: {
		task_id: string;
		input: unknown;
		callback_url: string;
		/** Repeating tasks only (docs/design/13_task.md §13). Absent for one-off tasks */
		repeat?: RepeatSettings;
	};
}

/** Repeat interval bounds in seconds (§3-2) — the CLI rejects a repeat outside them */
export const REPEAT_INTERVAL_MIN_S = 10;
export const REPEAT_INTERVAL_MAX_S = 604_800;

/** Repeat settings (§3-2). Without `max_runs`, runs until cancelled */
export interface RepeatSettings {
	/** REPEAT_INTERVAL_MIN_S ~ REPEAT_INTERVAL_MAX_S */
	interval_seconds: number;
	max_runs?: number;
}

/**
 * Repeat run progress (§3-3) — sent with `working` (message required) each run, and in the final terminal report. The
 * server merges only when `runs` ≥ its stored value, so late stale reports don't overwrite. Only these keys; unknown keys get 400.
 */
export interface RepeatProgress {
	runs: number;
	failed: number;
	/** RFC 3339 */
	last_run_at: string;
}

export interface PullResponse {
	success: true;
	tasks: PulledTask[];
	cancelled: string[];
	has_more: boolean;
	/** All pull workers registered on the server for this host — detects server-side deletes (§10) */
	workers: ServerWorker[];
	quota: Quota;
	poll: Poll;
	cli?: HostCli;
}

export interface ServerWorker {
	name: string;
}

/** Live channel URL (§3-1, §13-1). Absent if the server does not support live */
export interface HostLive {
	url: string;
}

/** CLI version the server recommends (§3-1, §3-2, §6-5). Sent on `GET /host`, pull and sync. Absent → no recommendation, no notice */
export interface HostCli {
	latest: string;
}

/** Server → CLI signal (§13-2). The envelope has a single key, `topic` — no payload. Unknown topics and keys are ignored */
export interface LiveSignal {
	topic: string;
}

export interface HostResponse {
	success: true;
	host: { id: string; name: string; created_at: string };
	workers: ServerWorker[];
	quota: Quota;
	poll: Poll;
	live?: HostLive;
	cli?: HostCli;
}

/**
 * Worker sync body (§3-4). The other top-level fields are **facts** about this host, shown by the dashboard and AI
 * clients ("last checked N s ago · every M s"). The server does not validate them; invalid values are stored as unset
 * rather than rejected, so display-only facts never stop `start`.
 */
export interface SyncWorkersRequest {
	workers: { name: string; description: string | null }[];
	/** Receive mode — a live host shows connection facts rather than a last poll time (§13-9) */
	receive_mode?: ReceiveMode;
	/** Configured check interval (ms). The server raises it to at least the minimum interval; that is the real interval. `null` for live */
	poll_interval_ms?: number | null;
	concurrency?: number;
	cli_version?: string;
	/** `<os>-<arch>` — e.g. `linux-arm64` */
	platform?: string;
}

export interface SyncRejected {
	name: string;
	code: SyncRejectCode;
	error: string;
	/** Only for worker_name_taken — what it collided with */
	conflict?: { kind: 'push' } | { kind: 'host'; host_name: string };
}

export interface SyncWorkersResponse {
	success: true;
	workers: { name: string; result: 'created' | 'updated' | 'unchanged' }[];
	rejected: SyncRejected[];
	quota: Quota;
	poll: Poll;
	live?: HostLive;
	cli?: HostCli;
}

/**
 * `DELETE /api/v1/host/workers/{name}` (§3-5). `complete: false` means history is still being deleted — resend the
 * same request. `quota` is present only when charged (complete with quota left); `null` when exhausted, unsubscribed
 * or in progress. `poll` comes only on completion.
 */
export interface DeleteWorkerResponse {
	success: true;
	deleted: { name: string };
	complete: boolean;
	quota: Quota | null;
	poll?: Poll;
}

/** Report body — docs/design/13_task.md §5 plus the pull worker's lease_id (§3-3) */
export interface ReportBody {
	status: 'working' | 'completed' | 'failed';
	lease_id?: string;
	status_message?: string;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
	/** Run progress of a repeating task. 400 if sent for a one-off task */
	repeat?: RepeatProgress;
}

export interface ReportAccepted {
	success: true;
	task_id: string;
	status: string;
	queued_at: string;
}

export interface ErrorBody {
	success: false;
	error: string;
	code: ServerErrorCode;
	/** `cli_outdated` only (§6-5) — the server's minimum supported version */
	min_version?: string;
	/** `cli_outdated` only, when the server has a recommended version */
	latest_version?: string;
}
