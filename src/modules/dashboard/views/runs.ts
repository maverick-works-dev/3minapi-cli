import { BIN } from '../../../core/domain/index.ts';
import { formatBytes } from '../../../core/text.ts';
import { readPayloadSlice } from '../../workers/results/reader.ts';
import { childPath } from '../../workers/results/shape.ts';
import type { StoredResult } from '../../workers/results/store.ts';
import {
	RUN_RANGES,
	RUN_STATES,
	encodeCursor,
	isRepeat,
	type RepeatRuns,
	type Run,
	type RunCursor,
	type RunDetail,
	type RunFilter,
	type RunOfTask,
	type TaskLog
} from '../data.ts';
import {
	badge,
	command,
	copyButton,
	duration,
	html,
	qs,
	shortTaskId,
	tag,
	time,
	workerName,
	workerText,
	type Html,
	type ViewContext
} from './html.ts';
import { logTable } from './logs.ts';
import { rangeTabs } from './overview.ts';

/** Up to this size the whole result is pretty-printed. Larger ones are shown in slices (the read worker's rules) */
export const INLINE_RESULT_BYTES = 64 * 1024;
/** Elements or keys per screen in slice view */
export const ENTRIES_PER_PAGE = 100;

const REPLY_LABEL: Record<string, string> = {
	pending: 'not sent yet',
	result: 'result',
	substitute: 'summary (too large)',
	failed: 'error',
	rejected: 'rejected by server',
	none: 'not sent (local)'
};

/** Reply cell — recurring run rows (reply none) send no result, only progress. `none` otherwise means local `--serve` */
function replyLabel(reply: string, repeat: boolean): string {
	if (repeat && reply === 'none') return 'progress only';
	return REPLY_LABEL[reply] ?? reply;
}

/** Run count of a recurring task — finished runs from history, or saved run rows without history */
function runCountText(r: Run): string {
	const n = r.runs ?? r.saved_runs ?? 0;
	const max = r.repeat ? (r.repeat.max_runs ?? '∞') : null;
	return max === null ? `↻ ${n} runs` : `↻ ${n}/${max} runs`;
}

export function runsPage(
	/** firstNo — row number of this page's first row (1-based). Paging is keyset, so it is carried in the URL */
	page: { runs: Run[]; next: RunCursor | null; paged: boolean; firstNo: number },
	filter: RunFilter,
	workers: string[],
	ctx: ViewContext
): Html {
	const { runs, next, paged, firstNo } = page;
	const keep = { worker: filter.worker, state: filter.state };
	const here = { ...keep, range: filter.range };
	return html`
		<div class="head">
			<h1>Runs</h1>
			${rangeTabs('/runs', filter.range, keep, RUN_RANGES)}
		</div>
		<form class="filters" method="get" action="/runs" data-autosubmit>
			<input type="hidden" name="range" value="${filter.range}" />
			<label
				>Worker
				<select name="worker">
					<option value="">All</option>
					${workers.map(
						(w) =>
							html`<option value="${w}" ${w === filter.worker ? html` selected` : ''}>
								${workerText(w)}
							</option>`
					)}
				</select>
			</label>
			<label
				>Status
				<select name="state">
					<option value="">All</option>
					${RUN_STATES.map(
						(s) =>
							html`<option value="${s}" ${s === filter.state ? html` selected` : ''}>${s}</option>`
					)}
				</select>
			</label>
			<noscript><button type="submit">Apply</button></noscript>
		</form>
		${runs.length === 0
			? html`<p class="muted">No runs match.</p>`
			: html`<div class="scroll">
						<table class="table runs">
							<thead>
								<tr>
									<th class="num">No</th>
									<th>Task</th>
									<th>Worker</th>
									<th>Status</th>
									<th class="num">Duration</th>
									<th class="num">Size</th>
									<th>Reply</th>
									<th>Time</th>
								</tr>
							</thead>
							<tbody>
								${runs.map(
									(r, i) =>
										html`<tr>
											<td class="num muted">${firstNo + i}</td>
											<td class="task">
												<a href="/runs/${encodeURIComponent(r.task_id)}" title="${r.task_id}"
													><code>${shortTaskId(r.task_id)}</code></a
												>${isRepeat(r)
													? html` ${tag(
															runCountText(r),
															'A repeating task — every run is saved; open it to see the runs'
														)}`
													: ''}${r.in === 'results'
													? html` ${tag(
															'result only',
															`No run history on host ${ctx.host} (pruned with tasks prune, or never recorded here); the saved result remains`
														)}`
													: ''}
											</td>
											<td>${workerName(r.worker)}</td>
											<td>${badge(r.state)}</td>
											<td class="num">${duration(r.duration_ms)}</td>
											<td class="num">${r.bytes === null ? '—' : formatBytes(r.bytes)}</td>
											<td>
												${r.reply === null
													? html`<span class="muted">—</span>`
													: replyLabel(r.reply, isRepeat(r))}
											</td>
											<td>
												${time(r.at)}${r.last_run_at !== null
													? html`<br /><span class="muted">last run ${time(r.last_run_at)}</span>`
													: ''}
											</td>
										</tr>`
								)}
							</tbody>
						</table>
					</div>
					${paged || next
						? html`<nav class="pager pager-runs" aria-label="Pages">
								<span>${paged ? html`<a href="/runs${qs(here)}">← Newest</a>` : ''}</span>
								<span
									>${next
										? html`<a
												href="/runs${qs({
													...here,
													after: encodeCursor(next),
													no: firstNo + runs.length
												})}"
												>Older →</a
											>`
										: html`<span class="muted">No older runs</span>`}</span
								>
							</nav>`
						: ''}`}
	`;
}

/** One-off task detail — recurring tasks use repeatPage/runOfTaskPage */
export function runPage(
	d: RunDetail,
	view: { path: string; offset: number },
	log: TaskLog,
	ctx: ViewContext
): Html {
	const r = d.run;
	const base = `/runs/${encodeURIComponent(r.task_id)}`;
	return html`
		<p class="crumbs"><a href="/runs">Runs</a> / <code>${r.task_id}</code></p>
		<div class="head"><h1>${workerName(r.worker)} ${badge(r.state)}</h1></div>
		<div class="grid">
			<section class="panel">
				<h2>Run</h2>
				<dl class="kv">
					<dt>Task</dt>
					<dd><code>${r.task_id}</code> ${copyButton(r.task_id)}</dd>
					<dt>Received</dt>
					<dd>${received(r, ctx)}</dd>
					<dt>Started</dt>
					<dd>${time(r.started_at)}</dd>
					<dt>Finished</dt>
					<dd>${time(r.finished_at)}</dd>
					<dt>Duration</dt>
					<dd>${duration(r.duration_ms)}</dd>
					${r.delivery_attempt !== null
						? html`<dt>Delivery</dt>
								<dd>attempt ${r.delivery_attempt} · ran ${r.run_count} time(s)</dd>`
						: ''}
					${lastError(r)}
				</dl>
			</section>
			<section class="panel">
				<h2>Saved result</h2>
				${d.result
					? html`${savedKv(d.result, false)}
							<p>${command(`${BIN} worker results show ${r.task_id}`, ctx)}</p>`
					: html`<p class="muted">
							${r.state === 'running'
								? 'Not finished yet.'
								: 'No result saved for this task (cancelled, failed before running, a built-in reader task, or pruned from data.db).'}
						</p>`}
			</section>
		</div>
		${d.result ? resultViewer(base, d.result.payload, d.result.bytes, d.result.status, view) : ''}
		${logPanel('Log for this task', log)}
	`;
}

/** Recurring task detail — one summary + run list (with previews). Clicking a run opens its detail */
export function repeatPage(
	run: Run,
	page: RepeatRuns,
	/** Whether this is an older page (runs_before) */
	paged: boolean,
	ctx: ViewContext
): Html {
	const base = `/runs/${encodeURIComponent(run.task_id)}`;
	const { runs, runsNext, total } = page;
	const newest = runs[0]?.run_no;
	const oldest = runs.at(-1)?.run_no;
	return html`
		<p class="crumbs"><a href="/runs">Runs</a> / <code>${run.task_id}</code></p>
		<div class="head"><h1>${workerName(run.worker)} ${badge(run.state)}</h1></div>
		<section class="panel">
			<h2>Repeat</h2>
			<dl class="kv">
				<dt>Task</dt>
				<dd><code>${run.task_id}</code> ${copyButton(run.task_id)}</dd>
				${run.repeat
					? html`<dt>Every</dt>
							<dd>${run.repeat.interval_seconds}s</dd>
							<dt>Runs</dt>
							<dd>
								${run.runs ?? 0}/${run.repeat.max_runs ?? '∞'}${run.failed
									? ` · ${run.failed} failed`
									: ''}
							</dd>`
					: html`<dt>Runs</dt>
							<dd>${total} saved</dd>`}
				<dt>Received</dt>
				<dd>${received(run, ctx)}</dd>
				${run.repeat
					? html`<dt>Last run</dt>
							<dd>${time(run.last_run_at)}</dd>
							${run.state === 'running'
								? html`<dt>Next run</dt>
										<dd>${time(run.next_at)}</dd>`
								: ''}`
					: ''}
				${lastError(run)}
			</dl>
			<p>${command(`${BIN} worker results show ${run.task_id} --run <n>`, ctx)}</p>
		</section>
		<section class="panel">
			<h2>
				Runs${newest !== undefined
					? html` <span class="muted"
							>— run ${oldest}–${newest} of ${total} saved, newest first</span
						>`
					: ''}
			</h2>
			${runs.length === 0
				? html`<p class="muted">No run saved yet.</p>`
				: html`<div class="scroll">
						<table class="table runs-of-task">
							<thead>
								<tr>
									<th class="num">Run</th>
									<th>Status</th>
									<th>Saved</th>
									<th class="num">Size</th>
									<th>Preview</th>
								</tr>
							</thead>
							<tbody>
								${runs.map((x) => {
									const href = `${base}/${x.run_no}`;
									return html`<tr>
										<td class="num"><a href="${href}">${x.run_no}</a></td>
										<td>${badge(x.status)}</td>
										<td>${time(Date.parse(x.created_at))}</td>
										<td class="num">${formatBytes(x.bytes)}</td>
										<td class="preview">
											<a href="${href}" tabindex="-1"
												>${x.large
													? html`<span class="muted">large result — open to read it in parts</span>`
													: html`<code${x.status === 'failed' ? html` class="failed"` : ''}
															>${x.preview}</code
														>`}</a
											>
										</td>
									</tr>`;
								})}
							</tbody>
						</table>
					</div>`}
			${paged || runsNext !== null
				? html`<nav class="pager pager-runs" aria-label="Pages">
						<span>${paged ? html`<a href="${base}">← Newest</a>` : ''}</span>
						<span
							>${runsNext !== null
								? html`<a href="${base}${qs({ runs_before: runsNext })}">Older →</a>`
								: html`<span class="muted">No older runs</span>`}</span
						>
					</nav>`
				: ''}
		</section>
	`;
}

/** One run of a recurring task — run card + result viewer + that run's logs, with previous/next navigation */
export function runOfTaskPage(
	run: Run,
	runNo: number,
	d: RunOfTask,
	view: { path: string; offset: number },
	log: TaskLog | null,
	ctx: ViewContext
): Html {
	const task = `/runs/${encodeURIComponent(run.task_id)}`;
	const base = `${task}/${runNo}`;
	const nav = html`<nav class="pager run-nav" aria-label="Runs">
		<span>${d.prev !== null ? html`<a href="${task}/${d.prev}">← run ${d.prev}</a>` : ''}</span>
		<span><a href="${task}">All runs</a></span>
		<span>${d.next !== null ? html`<a href="${task}/${d.next}">run ${d.next} →</a>` : ''}</span>
	</nav>`;
	return html`
		<p class="crumbs">
			<a href="/runs">Runs</a> /
			<a href="${task}" title="${run.task_id}"><code>${shortTaskId(run.task_id)}</code></a> / run
			${runNo}
		</p>
		<div class="head">
			<h1>${workerName(run.worker)} · run ${runNo} ${d.result ? badge(d.result.status) : ''}</h1>
		</div>
		${nav}
		${d.result
			? html`<section class="panel">
						<h2>Run ${runNo}</h2>
						${savedKv(d.result, true)}
						<p>${command(`${BIN} worker results show ${run.task_id} --run ${runNo}`, ctx)}</p>
					</section>
					${resultViewer(base, d.result.payload, d.result.bytes, d.result.status, view)}
					${log ? logPanel(`Log for run ${runNo}`, log) : ''}`
			: html`<section class="panel">
					<p class="error">No saved run ${runNo} for this task.</p>
					<p class="muted">
						It has not run yet, it stopped before saving a result, or it was pruned from data.db.
						${d.prev !== null || d.next !== null ? 'The nearest saved runs are linked above.' : ''}
					</p>
				</section>`}
	`;
}

function received(r: Run, ctx: ViewContext): Html | string {
	return r.in === 'results'
		? html`<span class="muted">no run history on host ${ctx.host}</span>`
		: time(r.at);
}

function lastError(r: Run): Html | string {
	return r.last_error
		? html`<dt>Error</dt>
				<dd class="error">${r.last_error}</dd>`
		: '';
}

/** One saved result row — the reply cell of a run row (repeat) reads progress only */
function savedKv(result: StoredResult, repeat: boolean): Html {
	return html`<dl class="kv">
		<dt>Status</dt>
		<dd>${result.status}</dd>
		<dt>Saved</dt>
		<dd>${time(Date.parse(result.created_at))}</dd>
		<dt>Size</dt>
		<dd>${formatBytes(result.bytes)}</dd>
		<dt>Reply</dt>
		<dd>${replyLabel(result.reply, repeat)}</dd>
		<dt>Received via</dt>
		<dd>${result.source}</dd>
		${result.shape_hash
			? html`<dt>Shape</dt>
					<dd><code>${result.shape_hash}</code></dd>`
			: ''}
	</dl>`;
}

function logPanel(title: string, log: TaskLog): Html {
	return html`<section class="panel">
		<h2>${title}</h2>
		${log.error
			? html`<p class="error">Could not read the log: ${log.error}</p>`
			: log.lines.length > 0
				? logTable(log.lines, { channel: true, task: false })
				: log.deleted
					? html`<p class="muted">
							No log files from this run's dates remain — most likely deleted after
							<code>logRetentionDays</code> (default 30) or when the logs passed
							<code>logMaxBytes</code>.
						</p>`
					: html`<p class="muted">
							No log lines for this run (older parts of that day's log may have been deleted).
						</p>`}
	</section>`;
}

function resultViewer(
	/** This view's URL — slice links are appended (one-off `/runs/<id>`, run `/runs/<id>/<n>`) */
	base: string,
	payload: string,
	bytes: number,
	status: string,
	view: { path: string; offset: number }
): Html {
	const title = status === 'failed' ? 'Error' : 'Result';
	if (bytes <= INLINE_RESULT_BYTES && view.path === '$' && view.offset === 0) {
		let pretty: string;
		let broken: string | null = null;
		try {
			pretty = JSON.stringify(JSON.parse(payload), null, 2);
		} catch (err) {
			// Stored as JSON by the CLI — unparsable means corrupted. Show the raw text, don't hide it (as with slice reads of large results)
			pretty = payload;
			broken = (err as Error).message;
		}
		return html`<section class="panel">
			<h2>${title}</h2>
			${broken
				? html`<p class="error">
						The saved result is not valid JSON (it may be corrupted): ${broken}
					</p>`
				: ''}
			<pre class="code json">${pretty}</pre>
		</section>`;
	}
	// Arrays and objects: up to ENTRIES_PER_PAGE per screen. For strings limit is a character count, so re-read by budget (READ_MAX_BYTES) only
	let read = readPayloadSlice(payload, { ...view, limit: ENTRIES_PER_PAGE, summarize });
	if (read.ok && read.result.kind === 'text') read = readPayloadSlice(payload, view);
	const crumbs = pathCrumbs(view.path, base);
	if (!read.ok) {
		return html`<section class="panel">
			<h2>${title}</h2>
			${crumbs}
			<p class="error">${read.message}</p>
		</section>`;
	}
	const res = read.result as {
		kind: 'array' | 'object' | 'text' | 'value';
		total: number;
		offset: number;
		count: number;
		next: number | null;
		items?: unknown;
		text?: string;
		value?: unknown;
	};
	const pager = html`<p class="pager">
		${res.offset > 0
			? html`<a
					href="${base}${qs({
						path: view.path,
						offset: Math.max(0, res.offset - (res.kind === 'text' ? res.count : ENTRIES_PER_PAGE))
					})}"
					>← Previous</a
				>`
			: ''}
		<span class="muted">${res.kind} · ${res.offset}–${res.offset + res.count} of ${res.total}</span>
		${res.next !== null
			? html`<a href="${base}${qs({ path: view.path, offset: res.next })}">Next →</a>`
			: ''}
	</p>`;
	let body: Html;
	if (res.kind === 'array' || res.kind === 'object') {
		const entries: [string, string, unknown][] =
			res.kind === 'array'
				? (res.items as unknown[]).map((v, i) => [
						String(res.offset + i),
						`${view.path}[${res.offset + i}]`,
						v
					])
				: Object.entries(res.items as Record<string, unknown>).map(([k, v]) => [
						k,
						childPath(view.path, k),
						v
					]);
		body = html`<div class="scroll">
			<table class="table entries">
				<tbody>
					${entries.map(
						([key, p, v]) =>
							html`<tr>
								<th scope="row">
									${v instanceof Folded || (v !== null && typeof v === 'object')
										? html`<a href="${base}${qs({ path: p })}">${key}</a>`
										: key}
								</th>
								<td><pre class="code">${preview(v)}</pre></td>
							</tr>`
					)}
				</tbody>
			</table>
		</div>`;
	} else if (res.kind === 'text') {
		body = html`<pre class="code">${res.text ?? ''}</pre>`;
	} else {
		body = html`<pre class="code">${JSON.stringify(res.value)}</pre>`;
	}
	return html`<section class="panel">
		<h2>${title} <span class="muted">${formatBytes(bytes)} — shown in parts</span></h2>
		${crumbs}${pager}${body}${pager}
	</section>`;
}

/** Unexpanded large child value — shows only its size. The link opens that path */
class Folded {
	readonly text: string;
	constructor(text: string) {
		this.text = text;
	}
	toJSON(): string {
		return this.text;
	}
}

const FOLD_CHARS = 600;
const TEXT_PREVIEW_CHARS = 2000;

/** Shrinks a value to fit one cell — small objects/arrays as is, large ones by size, long strings by their start */
function summarize(v: unknown): unknown {
	if (Array.isArray(v)) {
		return JSON.stringify(v).length <= FOLD_CHARS ? v : new Folded(`[ ${v.length} items ]`);
	}
	if (v !== null && typeof v === 'object') {
		return JSON.stringify(v).length <= FOLD_CHARS
			? v
			: new Folded(`{ ${Object.keys(v).length} keys }`);
	}
	if (typeof v === 'string' && v.length > TEXT_PREVIEW_CHARS) {
		return new Folded(
			`${JSON.stringify(v.slice(0, TEXT_PREVIEW_CHARS))}… (${v.length} characters)`
		);
	}
	return v;
}

function preview(v: unknown): string {
	if (v instanceof Folded) return v.text;
	return v !== null && typeof v === 'object' ? JSON.stringify(v, null, 2) : JSON.stringify(v);
}

function pathCrumbs(path: string, base: string): Html {
	// Ancestor paths of `$.a.b[3]` — same notation rules as parsePath, but only splits prefixes for navigation
	const cuts: string[] = ['$'];
	let i = 1;
	while (i < path.length) {
		if (path[i] === '[') i = path.indexOf(']', i) + 1;
		else if (path[i] === '.' && path[i + 1] === '"') {
			let j = i + 2;
			while (j < path.length && path[j] !== '"') j += path[j] === '\\' ? 2 : 1;
			i = j + 1;
		} else {
			i++;
			while (i < path.length && path[i] !== '.' && path[i] !== '[') i++;
		}
		if (i <= 0) break;
		cuts.push(path.slice(0, i));
	}
	return html`<p class="crumbs path">
		${cuts.map((c, n) =>
			n === cuts.length - 1
				? html`<code>${c}</code>`
				: html`<a href="${base}${qs({ path: c })}"><code>${c}</code></a> › `
		)}
	</p>`;
}
