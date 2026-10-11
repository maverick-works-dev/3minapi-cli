/**
 * Host API client — docs/design/14_cli_host.md §3, §6.
 *
 * Stop rule (docs/design/14_cli_host.md §6-2): throw StopError **only when the body JSON's `code` is a stop code**.
 * 401/403/429/5xx without `code` (e.g. HTML from an edge or WAF) and network errors are ordinary failures — stopping on them
 * would permanently stop all of a user's CLIs on a single transient error during a deploy.
 *
 * **Stop gate**: once a stop code arrives, the client closes itself (`halted`). From then on every method throws the same
 * StopError without touching the network — guaranteeing "zero calls after stop" in one place, whether the code came from a poll, reply or status call.
 * No automatic resume; only a new client (= the next `start`) calls again (#1362).
 */
import {
	API_TIMEOUT_MS,
	BIN,
	CliError,
	ENV,
	StopError,
	isStopCode,
	type DeleteWorkerResponse,
	type HostCli,
	type HostResponse,
	type PullResponse,
	type ReportAccepted,
	type ReportBody,
	type ServerErrorCode,
	type SyncWorkersRequest,
	type SyncWorkersResponse
} from './domain/index.ts';
import { stripControl } from './text.ts';

/** A server rejection other than a stop — carries code if present */
export class ApiError extends CliError {
	readonly status: number | null;
	readonly code: ServerErrorCode | null;
	/** Retry-After header (seconds) → ms. null if absent */
	readonly retryAfterMs: number | null;

	constructor(
		message: string,
		status: number | null,
		code: ServerErrorCode | null,
		retryAfterMs: number | null = null
	) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
		this.retryAfterMs = retryAfterMs;
	}
}

/** `3minapi/<version> node/<version> <platform>` */
export function userAgent(version: string, platform: string): string {
	return `${BIN}/${version} node/${process.versions.node} ${platform}`;
}

export interface ApiClientOptions {
	apiUrl: string;
	token: string;
	userAgent: string;
	fetch?: typeof fetch;
	signal?: AbortSignal;
	/**
	 * Receives the response's `cli` (recommended version, docs/design/14_cli_host.md §6-5) on every successful `GET /host`, pull and sync — `undefined` if the key is absent.
	 * Pull is frequent, so the receiver writes only on change (`LatestWatch`).
	 * Lives on the client so it is recorded in one place whichever command made the call (core/update-notice.ts)
	 */
	onServerCli?: (cli: HostCli | undefined) => void;
}

export class ApiClient {
	private readonly opts: ApiClientOptions;
	private stop: StopError | null = null;

	constructor(opts: ApiClientOptions) {
		this.opts = opts;
	}

	/** The stop reason, once stopped. Every later call ends with this error */
	get halted(): StopError | null {
		return this.stop;
	}

	/** Recommended version callback — a throw does not discard the response (fetched tasks must not be stranded) */
	private notifyCli(cli: HostCli | undefined): void {
		try {
			this.opts.onServerCli?.(cli);
		} catch {
			// The notice is secondary
		}
	}

	/** Stops from outside — when another client (a worker key in public mode) received a stop code */
	halt(err: StopError): void {
		this.stop ??= err;
	}

	/** GET /api/v1/host — token check. No side effects, counts as 1 call (docs/design/14_cli_host.md §3-1) */
	async getHost(): Promise<HostResponse> {
		const res = await this.request<HostResponse>('GET', this.opts.apiUrl + '/api/v1/host');
		this.notifyCli(res.cli);
		return res;
	}

	/** GET /api/v1/host/tasks — an empty response also counts as 1 call (docs/design/14_cli_host.md §3-2) */
	async pullTasks(max: number): Promise<PullResponse> {
		const res = await this.request<PullResponse>(
			'GET',
			`${this.opts.apiUrl}/api/v1/host/tasks?max=${max}`
		);
		this.notifyCli(res.cli);
		return res;
	}

	/** PUT /api/v1/host/workers — worker metadata sync. 200 and 1 call even with per-item rejections (docs/design/14_cli_host.md §3-4) */
	async syncWorkers(body: SyncWorkersRequest): Promise<SyncWorkersResponse> {
		const res = await this.request<SyncWorkersResponse>(
			'PUT',
			this.opts.apiUrl + '/api/v1/host/workers',
			body
		);
		this.notifyCli(res.cli);
		return res;
	}

	/**
	 * DELETE /api/v1/host/workers/{name} — deletes this host's local worker and its task history (docs/design/14_cli_host.md §3-5).
	 * If `complete: false`, send the same request again. 404 `worker_not_found` arrives as ApiError(code).
	 */
	deleteWorker(name: string): Promise<DeleteWorkerResponse> {
		return this.request<DeleteWorkerResponse>(
			'DELETE',
			`${this.opts.apiUrl}/api/v1/host/workers/${encodeURIComponent(name)}`
		);
	}

	/**
	 * POST {callback_url} — reply (docs/design/14_cli_host.md §3-3). Not blocked by quota but counts as 1 call.
	 * callback_url comes from the server, but the request carries the token, so it is followed only when its origin matches the API address.
	 */
	report(callbackUrl: string, body: ReportBody): Promise<ReportAccepted> {
		let target: URL;
		try {
			target = new URL(callbackUrl);
		} catch {
			throw new ApiError(`invalid callback_url: ${callbackUrl}`, null, null);
		}
		if (target.origin !== new URL(this.opts.apiUrl).origin) {
			throw new ApiError(
				`refusing to send the token to ${target.origin}: callback_url must be on ${this.opts.apiUrl}`,
				null,
				null
			);
		}
		return this.request<ReportAccepted>('POST', target.href, body);
	}

	private async request<T>(method: string, url: string, payload?: unknown): Promise<T> {
		if (this.stop) throw this.stop;
		const signals = [AbortSignal.timeout(API_TIMEOUT_MS)];
		if (this.opts.signal) signals.push(this.opts.signal);
		const headers: Record<string, string> = {
			authorization: `Bearer ${this.opts.token}`,
			accept: 'application/json',
			'user-agent': this.opts.userAgent
		};
		if (payload !== undefined) headers['content-type'] = 'application/json';
		let res: Response;
		let text: string;
		try {
			res = await (this.opts.fetch ?? fetch)(url, {
				method,
				headers,
				body: payload === undefined ? undefined : JSON.stringify(payload),
				signal: AbortSignal.any(signals)
			});
			// Timeouts and disconnects can also happen while reading the body — treated as the same network error
			text = await res.text();
		} catch (err) {
			throw new ApiError(`cannot reach ${this.opts.apiUrl}: ${networkReason(err)}`, null, null);
		}
		const body = parseJson(text);

		if (res.ok && body !== null && (body as { success?: unknown }).success === true) {
			return body as T;
		}

		const code = (body as { code?: unknown } | null)?.code;
		const message = (body as { error?: unknown } | null)?.error;
		// Server-provided message — printed to the terminal as is, so control characters are stripped (#1410)
		const sentence =
			typeof message === 'string' && message !== '' ? stripControl(message) : `HTTP ${res.status}`;
		if (isStopCode(code)) {
			// The quota_exhausted body has no quota object (the reset time is only in the message). The caller fills resetAt
			// from the last successful response's quota.reset_at (poller)
			this.stop ??= new StopError(code, sentence);
			throw this.stop;
		}
		// 404 without code = that server has no host routes — usually the API address points at the wrong place
		const hint =
			res.status === 404 && typeof code !== 'string'
				? `\nThis server has no host API. Check the API URL (--api-url or ${ENV.apiUrl}).`
				: '';
		throw new ApiError(
			`${method} ${url} failed: ${sentence}${hint}`,
			res.status,
			typeof code === 'string' ? (code as ServerErrorCode) : null,
			retryAfterMs(res.headers.get('retry-after'))
		);
	}
}

/** Retry-After accepts integer seconds only. The HTTP-date form is not in the contract */
function retryAfterMs(value: string | null): number | null {
	if (value === null || !/^\d+$/.test(value.trim())) return null;
	return Number(value.trim()) * 1000;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function networkReason(err: unknown): string {
	const e = err as Error & { cause?: { code?: string; message?: string } };
	if (e?.name === 'TimeoutError') return `no response within ${API_TIMEOUT_MS / 1000}s`;
	if (e?.name === 'AbortError') return 'aborted';
	return e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(err);
}
