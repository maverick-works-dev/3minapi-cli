/**
 * CLI domain types. Uses `import type` only within the domain folder (erased at runtime).
 */
import type { ReceiveMode, StopCode } from './contract.ts';
import type { ExitCode } from './errors.ts';

// ── Config (docs/design/15_cli.md §5) ─────────────────────────────────────

export interface Config {
	apiUrl: string;
	/** Relative to the project root */
	workersDir: string;
	pollIntervalMs: number;
	/** Log retention days (the control DB is never pruned automatically) */
	logRetentionDays: number;
	/** Total log size cap */
	logMaxBytes: number;
	/** Max concurrent runs */
	concurrency: number;
	/** Local server port (`start --serve`) */
	localServerPort: number;
	/**
	 * Receive mode (docs/design/14_cli_host.md §13) — when to pull. live pulls on signals; poll pulls every
	 * `pollIntervalMs`. No automatic switching. live silently ignores `pollIntervalMs`
	 */
	receiveMode: ReceiveMode;
}

export type ConfigKey = keyof Config;
export type ConfigSource = 'flag' | 'env' | 'project' | 'user' | 'default';

export interface ResolvedConfig {
	values: Config;
	sources: Record<ConfigKey, ConfigSource>;
	/** Directory containing 3minapi.json. null if none (before init) */
	projectRoot: string | null;
	projectFile: string | null;
	userFile: string;
	/** Unknown keys and the like — not failures, but worth reporting */
	warnings: string[];
}

/**
 * Live connection state (docs/design/15_cli.md §7-2) — stored as JSON in control DB `meta.live_state`, read by
 * `status` and the dashboard. Written only on change, not on every signal
 */
export interface LiveState {
	connected: boolean;
	/** When the current state began (ISO) — connect time if connected, disconnect time if not. null before any attempt */
	since: string | null;
	/** Reconnect attempts in this run (excluding the first connect) */
	reconnects: number;
	/** Connected at least once in this run — if not, suggest `--mode poll` and `doctor` */
	everConnected: boolean;
	/** Reason for the last disconnect or failure (human-readable). Most failures have no visible cause — WebSocket hides the status code */
	lastError: string | null;
}

export interface Dirs {
	config: string;
	/** Control DB */
	data: string;
	logs: string;
}

// ── Commands ────────────────────────────────────────────────────

/** util.parseArgs options plus help fields */
export interface OptionSpec {
	type: 'string' | 'boolean';
	short?: string;
	multiple?: boolean;
	default?: string | boolean | string[] | boolean[];
	description: string;
	/** Value name shown in help — `--input <json>` */
	valueName?: string;
	/** Off-only boolean — shown as `--no-<name>` in help, value arrives as false (parseArgs allowNegative) */
	negated?: boolean;
}

export type OptionValues = Record<string, string | boolean | (string | boolean)[] | undefined>;

export interface Command {
	name: string;
	/** One-line summary — used in the command list */
	summary: string;
	/** Usage after the command name — `<name> [--ts]` */
	usage: string;
	/** Description shown only by `help <cmd>` */
	description?: string;
	options: Record<string, OptionSpec>;
	args: { min: number; max: number };
	/** Stub command — the issue that will implement it */
	pendingIssue?: string;
	/**
	 * Subcommand group (`worker new` etc.). If set, this command is a group and run prints the group help.
	 * Subcommand names are full names (`worker new`) — used as is in help and error text
	 */
	subcommands?: Command[];
	run(ctx: CommandContext): Promise<ExitCode>;
}

export interface InputStream extends AsyncIterable<string | Uint8Array> {
	isTTY?: boolean;
	setRawMode?(mode: boolean): unknown;
	// any — needed to accept every per-event overload of process.stdin and Readable
	on?(event: string, listener: (...args: any[]) => void): unknown;
	off?(event: string, listener: (...args: any[]) => void): unknown;
	resume?(): unknown;
	pause?(): unknown;
	setEncoding?(encoding: 'utf8'): unknown;
}

export interface CommandContext {
	positionals: string[];
	values: OptionValues;
	out: OutputPort;
	stdin: InputStream;
	env: NodeJS.ProcessEnv;
	cwd: string;
	/** User home — base of the default `init` project path (`~/3minapi`). Tests pass a temp folder */
	home: string;
	platform: NodeJS.Platform;
	dirs: Dirs;
	version: string;
	/** Current time (epoch ms) — tests advance it */
	now(): number;
	/** Stops long-running commands (`start`, `dashboard` etc. — those that called claimInterrupt) on Ctrl+C and the like */
	signal: AbortSignal;
	/** Only commands that use config read it — help and doctor must run even with a broken config file */
	loadConfig(): ResolvedConfig;
	/**
	 * Declares that the command handles Ctrl+C (SIGINT, SIGTERM) itself. The first signal then aborts `signal` instead
	 * of exiting; the second forces exit. Other commands exit with 130 on the first signal.
	 */
	claimInterrupt(): void;
	/**
	 * Changes the process working directory — `start` and `worker run` point worker threads' cwd at the project folder
	 * (worker threads share the process cwd). Tests pass a no-op
	 */
	chdir(dir: string): void;
}

// ── Output (docs/design/15_cli.md §4) ─────────────────────────────────────

export type Paint = (text: string) => string;

export interface Style {
	bold: Paint;
	dim: Paint;
	red: Paint;
	yellow: Paint;
	green: Paint;
}

/** Implemented by Output in core/output.ts */
export interface OutputPort {
	readonly json: boolean;
	/** Style for stdout */
	readonly out: Style;
	/** Style for stderr */
	readonly err: Style;
	result(data: unknown, text?: string): void;
	print(text: string): void;
	/** stderr without a newline (prompt) */
	prompt(text: string): void;
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

// ── Stop and task state (control DB) ─────────────────────────────

/** Stop reason stored in the control DB. Currently the same as the server stop code (docs/design/14_cli_host.md §6-3) */
export type StopReason = StopCode;

/**
 * Task state as seen locally. Differs from the server state (TaskStatus) — its purpose is preventing duplicate runs.
 *   received   received, not yet run
 *   running    running
 *   completed · failed · cancelled · superseded   finished (never run again)
 */
export type LocalTaskState =
	| 'received'
	| 'running'
	| 'completed'
	| 'failed'
	| 'cancelled'
	| 'superseded';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
