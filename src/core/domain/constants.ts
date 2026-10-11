/**
 * CLI constants — names, files, env vars, ranges, timeouts. Server contract constants live in contract.ts.
 *
 * ⚠️ bin.ts loads this file (directly and via version.ts) before the Node version check. Values only, no imports.
 */

export const BIN = '3minapi';

/** Minimum Node — the version where type stripping became stable (docs/design/15_cli.md §2) */
export const MIN_NODE_VERSION = '24.12.0';

// ── Directories and files (docs/design/15_cli.md §5, §7) ─────────────────────────

export const APP_DIR_NAME = '3minapi';
export const PROJECT_CONFIG_FILE = '3minapi.json';
/** Guide for AI coding agents written by init — the 'guide' text (Codex, Cursor, Gemini CLI and others read it) */
export const AGENTS_FILE = 'AGENTS.md';
/** Claude Code reads AGENTS.md only when there is no CLAUDE.md, so init adds one that imports it */
export const CLAUDE_FILE = 'CLAUDE.md';
/** Under home. Project folder `init` creates without a path — always `~/3minapi`, regardless of cwd */
export const DEFAULT_PROJECT_DIR = '3minapi';
/** Under <config>/ */
export const USER_CONFIG_FILE = 'config.json';
/** Under <config>/. Host token — 0600 */
export const CREDENTIALS_FILE = 'credentials.json';
/** Under <config>/. Local server token — kept in a separate file from the host token */
export const LOCAL_SERVER_TOKEN_FILE = 'local-server-token';
/** Under <data>/ */
export const CONTROL_DB_FILE = 'control.db';
/** Under <data>/. This host's project path — one project per host. Machine-specific, so not in config (Roaming) */
export const PROJECT_RECORD_FILE = 'project.json';
/** Under <data>/. pid and nonce of the running start — only one runs per host */
export const RUNNER_LOCK_FILE = 'runner.json';
/** Under <data>/. Created by `stop`; the running start sees it and exits on its own — Windows cannot receive SIGTERM */
export const RUNNER_STOP_FILE = 'runner.stop';
/** Under <data>/. Created by `reload`; the running start consumes it and resyncs — same approach as the stop file */
export const RUNNER_RELOAD_FILE = 'runner.reload';
/** Under <data>/. Resync progress and result — `reload` reads it to print the result */
export const RUNNER_RELOADED_FILE = 'runner.reloaded';
/**
 * Under <data>/. Worker names removed by `worker delete` — the running start consumes it and turns them off at once.
 * No server call; live pulls are rare, so the server list would be slow. Back-to-back deletes merge names (no overwrite)
 */
export const RUNNER_DELETED_FILE = 'runner.deleted';
/** Under <logs>/app/. stdout and stderr of `start --detach` */
export const RUNNER_OUT_FILE = 'runner.out';
/** Under <data>/. pid, nonce and address (no token) of the running dashboard — one per host. status shows it as is */
export const DASHBOARD_LOCK_FILE = 'dashboard.json';
/** Under <data>/. Created by `dashboard stop`; the running dashboard sees it and exits — same as runner.stop */
export const DASHBOARD_STOP_FILE = 'dashboard.stop';
/** Under <data>/. Access link with token (0600) — shown again by `dashboard url`. Separate from the lock file so status output never includes it */
export const DASHBOARD_LINK_FILE = 'dashboard.link';
/** Under <logs>/app/. stdout and stderr of `dashboard --detach` */
export const DASHBOARD_OUT_FILE = 'dashboard.out';
/** Cap for runner.out and dashboard.out — past it when a detached run opens it, keep one `.1` (#1410) */
export const OUT_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** Subfolders under <logs>/ */
export const APP_LOG_DIR = 'app';
export const WORKER_LOG_DIR = 'workers';
export const LOG_FILE_EXTENSION = '.jsonl';

/** Permissions for files and folders holding secrets (POSIX). Windows relies on the user profile ACL */
export const SECRET_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;

// ── Environment variables ────────────────────────────────────────────────
// The prefix is not `3MINAPI_` because POSIX shell variable names cannot start with a digit.

export const ENV = {
	home: 'THREEMINAPI_HOME',
	token: 'THREEMINAPI_TOKEN',
	apiUrl: 'THREEMINAPI_API_URL',
	pollIntervalMs: 'THREEMINAPI_POLL_INTERVAL_MS',
	logRetentionDays: 'THREEMINAPI_LOG_RETENTION_DAYS',
	logMaxBytes: 'THREEMINAPI_LOG_MAX_BYTES',
	concurrency: 'THREEMINAPI_CONCURRENCY',
	localServerPort: 'THREEMINAPI_LOCAL_SERVER_PORT',
	receiveMode: 'THREEMINAPI_RECEIVE_MODE',
	/** Marks a child started by `start --detach` or `dashboard --detach` — it does not detach again */
	detached: 'THREEMINAPI_DETACHED',
	/** Turns off the update notice. `NO_UPDATE_NOTIFIER` and `CI` do too (core/update-notice.ts) */
	noUpdateNotice: 'THREEMINAPI_NO_UPDATE_NOTICE'
} as const;

/** Per-worker signing secret and report key in public mode (`start --serve --public`). `<NAME>` = uppercased worker name, `-` → `_` */
export const WORKER_SECRET_ENV = (name: string) => `THREEMINAPI_WORKER_${envName(name)}_SECRET`;
export const WORKER_KEY_ENV = (name: string) => `THREEMINAPI_WORKER_${envName(name)}_KEY`;

function envName(name: string): string {
	return name.toUpperCase().replace(/-/g, '_');
}

/** Proxy variables doctor checks — Node fetch honors them only with NODE_USE_ENV_PROXY=1 */
export const PROXY_ENV_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const;

// ── Config defaults and ranges ─────────────────────────────────────────

export const DEFAULT_API_URL = 'https://api.3minapi.com';
export const DEFAULT_WORKERS_DIR = 'workers';

/**
 * Poll interval. The server minimum (docs/design/14_cli_host.md §3-2 poll.min_interval_ms) applies separately.
 * The floor matches the server floor of 5 s — shorter settings would get poll_too_soon anyway
 */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;
export const POLL_INTERVAL_MIN_MS = 5_000;
export const POLL_INTERVAL_MAX_MS = 3_600_000;

/**
 * Max wait for a live connection to open — if not open by then, abandon and retry. undici emits close for most
 * failures; this covers cases like an unresponsive proxy. Not a contract value (CLI internal)
 */
export const LIVE_CONNECT_TIMEOUT_MS = 30_000;

/** How long to wait for leftover handles after a command ends — then bin.ts exits (enough to flush output) */
export const EXIT_GRACE_MS = 3_000;

/**
 * Max concurrent worker runs. A pull takes only as many as free slots, so the cap must not exceed what one pull can
 * return (contract.ts `PULL_MAX_LIMIT` = 50) or the extra slots never fill. This file has no imports, so the number is
 * duplicated and a test checks they match
 */
export const DEFAULT_CONCURRENCY = 4;
export const CONCURRENCY_MIN = 1;
export const CONCURRENCY_MAX = 50;

/**
 * Local server (`start --serve`) port. 3180 = "3 minutes = 180 seconds". Its IANA registration (Millicent Broker) is a
 * defunct service; it avoids OS ephemeral ranges (Linux 32768+, macOS and Windows 49152+) and dev tool defaults
 * (3000, 3001, 3306, 3389). Ports below 1024 need admin rights and are rejected
 */
export const DEFAULT_LOCAL_SERVER_PORT = 3180;
export const LOCAL_SERVER_PORT_MIN = 1024;
export const LOCAL_SERVER_PORT_MAX = 65535;

/**
 * Log retention days — bounds disk use. The control DB is not pruned by this value (see `tasks prune`).
 * The 1-day floor applies to logs only
 */
export const DEFAULT_LOG_RETENTION_DAYS = 30;
export const LOG_RETENTION_MIN_DAYS = 1;
export const LOG_RETENTION_MAX_DAYS = 365;

/** Total log size cap. Oldest files are deleted first when exceeded */
export const MIB = 1024 * 1024;
export const DEFAULT_LOG_MAX_BYTES = 300 * MIB;
export const LOG_MAX_BYTES_MIN = 10 * MIB;
export const LOG_MAX_BYTES_MAX = 1024 * MIB;
/** Per-file cap — split into `YYYY-MM-DD.N.jsonl` so one day's burst can't eat the whole budget */
export const LOG_FILE_MAX_BYTES = 10 * MIB;

/** Cap for log string fields and `last_error` (truncated **after** redaction) */
export const LOG_STRING_MAX_CHARS = 4_000;
export const LAST_ERROR_MAX_CHARS = 256;
/**
 * Cap for error.message in a failed report — truncated after redaction. HTTP libraries often put the whole response
 * body in the message, which would exceed the report cap (100 KiB). Stacks never go to the server, only to the local worker log
 */
export const ERROR_MESSAGE_MAX_CHARS = 4_000;
/** Cap for a failure message on one terminal line (start's progress display) */
export const EVENT_MESSAGE_MAX_CHARS = 200;
// ── Repeating tasks (docs/design/15_cli.md §8-7) ──────────────────────

/** After this many consecutive failed runs, the whole repeat closes as `failed` (repeat_failed) */
export const REPEAT_FAIL_STREAK_MAX = 5;
/**
 * How often the scheduler checks due times. It checks every second instead of arming a timer for the earliest due
 * time — no re-arming code, and after sleep or clock changes it is at most 1 s late (Node timers use a monotonic
 * clock; due times are wall-clock)
 */
export const REPEAT_TICK_MS = 1_000;

/** Prefix removed from a worker's ctx.env — CLI secrets such as the host token and public mode keys */
export const CLI_ENV_PREFIX = 'THREEMINAPI_';

// ── Worker files ───────────────────────────────────────────────

/** Extensions recognized as worker files — two files with the same name would make it ambiguous which to run */
export const WORKER_EXTENSIONS = ['.js', '.mjs', '.ts', '.mts'] as const;

/**
 * Templates are created as .mjs / .mts. The module format of .js and .ts follows the nearest package.json "type", and
 * `npm init -y` (npm 11) writes "type": "commonjs", which turns the template's `export` into a SyntaxError.
 * .mjs and .mts are always ESM regardless of package.json.
 */
export const TEMPLATE_EXTENSION = { js: '.mjs', ts: '.mts' } as const;

/**
 * SQLite file in the project folder — workers keep their own data in it, and the CLI stores worker results in
 * `_3minapi_`-prefixed tables (docs/design/15_cli.md §7-7, §8-5). init creates it with 0600 and the result tables
 */
export const USER_DB_FILE = 'data.db';

// ── Result storage (docs/design/15_cli.md §8-5) ─────────────────

/** Prefix of CLI-owned tables — reserved. Workers only read them */
export const RESULT_TABLE_PREFIX = '_3minapi_';
export const RESULTS_TABLE = `${RESULT_TABLE_PREFIX}results`;
export const RESULTS_META_TABLE = `${RESULT_TABLE_PREFIX}meta`;
/** Result table schema version (schema in `_3minapi_meta`) — the user's `PRAGMA user_version` is left alone */
export const RESULTS_SCHEMA_VERSION = 1;
/** Key of the substitute result. Reserved at the top level of user results — present means failed (reserved_result_key) */
export const RESULT_RESERVED_KEY = '_3minapi';
/** Room in the report body for fields other than result (status, lease_id, etc.) — generous */
export const REPORT_ENVELOPE_RESERVE = 1024;
/** Cap for failure messages stored in data.db — unlike reports (ERROR_MESSAGE_MAX_CHARS) the aim is not to truncate; this only stops runaways */
export const STORED_ERROR_MAX_CHARS = 1_000_000;
/** `shape` caps — keep the substitute result within the report cap */
export const SHAPE_MAX_DEPTH = 8;
export const SHAPE_MAX_PATHS = 200;
/** `values` for text paths — included in full when there are at most this many short distinct values */
export const SHAPE_MAX_VALUES = 10;
export const SHAPE_VALUE_MAX_CHARS = 40;
/** Path string cap — so long keys don't bloat the summary. Longer paths are dropped and marked truncated */
export const SHAPE_PATH_MAX_CHARS = 200;
/**
 * Cap for the whole substitute result (`_3minapi` value) — it enters AI context automatically, so an outline only.
 * Over the cap, deepest levels are trimmed first (fitShape). Full shape via `describe` (up to the report budget)
 */
export const SUBSTITUTE_MAX_BYTES = 8 * 1024;
/** Shape groups `describe --worker` includes (largest count first) — the rest merge into others */
export const DESCRIBE_MAX_GROUPS = 20;
/** Cap for each group's path diff list (added, missing) — over it, only counts */
export const DESCRIBE_MAX_DIFF_PATHS = 50;
/**
 * Recent results `describe --worker` merges into the base shape — a few ms for typical shapes, and within the remote
 * time limit even for worst-case shapes (~174 KB). Older results are not scanned — use query for full values and ranges
 */
export const DESCRIBE_MAX_MERGE = 1000;
/** Default count for `worker results list` */
export const RESULTS_LIST_DEFAULT = 20;
/** Default time limit for `worker results query` — kills the child process. Built-in read worker ops use the same limit */
export const RESULTS_QUERY_TIMEOUT_MS = 30_000;

// ── Built-in read worker (docs/design/15_cli.md §8-6) ─────────────

/** Cap for one `read` chunk — stays within the report budget (99 KiB) with the envelope (task_id, path, total…) */
export const READ_MAX_BYTES = 90 * 1024;
/** Cap for `read` limit — the byte budget usually hits first; this bounds iteration over millions of tiny elements */
export const READ_LIMIT_MAX = 10_000;
/** Cap for `query` task_ids — keeps the view definition (IN list) small */
export const BUILTIN_TASK_IDS_MAX = 100;

/**
 * Lines init adds to .gitignore — secrets workers read (.env) and the user DB (stored results may hold personal data).
 * `data.db*` also covers WAL mode's -wal and -shm files
 */
export const GITIGNORE_ENTRIES = ['.env', `${USER_DB_FILE}*`] as const;

// ── Timeouts ────────────────────────────────────────────────

/** doctor's API reachability check */
export const DOCTOR_API_TIMEOUT_MS = 5_000;
/** Host API calls (login, status) */
export const API_TIMEOUT_MS = 15_000;
/**
 * Per-address attempt time for Happy Eyeballs (IPv6/IPv4 autoselection). Node 24 defaults to 250 ms and **aborts**
 * the attempt after it (RFC 8305 only starts the next attempt and keeps the previous one). So on a PC without an
 * IPv6 route and RTT over 250 ms, worker fetches end in `fetch failed` (observed on Windows, Korea → Germany server).
 * Node raised it to 500 in v25.2 (nodejs/node#60334, not backported to 24). The cost: on networks that silently drop
 * IPv6, new connections may be this much slower — better than failing.
 * Left alone if the user passed `--network-family-autoselection-attempt-timeout` (core/network.ts)
 */
export const NETWORK_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;
/**
 * Recent period `tasks prune` keeps — finished task_ids record that they must not run again (docs/design/15_cli.md
 * §7-2). Redeliveries come only within minutes before ack, so 1 day is enough
 */
export const TASKS_PRUNE_MIN_AGE_MS = 24 * 60 * 60 * 1000;
/** Rows `tasks prune` deletes per transaction — lets a running start get the lock within its busy timeout (5 s) */
export const TASKS_PRUNE_BATCH = 5_000;
/** Control DB lock wait — SQLite busy timeout */
export const DB_BUSY_TIMEOUT_MS = 5_000;
/** `logs -f` poll interval — fs.watch reliability varies by platform, so it is not used */
export const LOG_FOLLOW_INTERVAL_MS = 500;
/** When a worker file sets no timeoutMs. The max stays below the server task deadline (24 hours) */
export const DEFAULT_WORKER_TIMEOUT_MS = 60_000;
export const WORKER_TIMEOUT_MAX_MS = 23 * 60 * 60 * 1000;
/** Wait after the cancel signal (ctx.signal) before force-terminating the thread */
export const CANCEL_GRACE_MS = 2_000;
/** If terminate() doesn't finish within this (native code, sync block), give up and free the slot */
export const TERMINATE_WAIT_MS = 5_000;
/** How often the running start checks the stop file */
export const STOP_CHECK_INTERVAL_MS = 1_000;
/** How long `stop` waits for a clean exit before forcing it */
export const STOP_WAIT_MS = 15_000;
/**
 * Max wait for a `reload` result. Like startup, a resync imports every worker file (up to 10 s each, 4 at a time) —
 * many workers can take tens of seconds. Ends earlier if the runner dies
 */
export const RELOAD_WAIT_MS = 120_000;
/** How long `start --detach` waits for the child to take the lock */
export const DETACH_READY_MS = 10_000;
/**
 * Lock heartbeat — the owner refreshes the lock file mtime at this interval. `stop` won't kill the pid of a lock whose
 * refresh stalled longer than HEARTBEAT_STALE_MS — another program may have that pid within the same boot (#1410)
 */
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const HEARTBEAT_STALE_MS = 60_000;
/** Basis for the estimated monthly call count — 30 days */
export const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
/** Public mode signature timestamp tolerance (seconds) — the official Standard Webhooks library default */
export const PUSH_TIMESTAMP_TOLERANCE_S = 300;

/** Default line count for `logs` */
export const DEFAULT_LOG_LINES = 100;
