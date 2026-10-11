/**
 * Server-rendered HTML — every interpolated value is escaped. Only already-built fragments (Html) go in as is.
 * Worker names, errors, results and logs are user/external data — never concatenate raw strings.
 */
import { BUILTIN_RESULTS_PREFIX } from '../../../core/domain/index.ts';
import { formatLocal } from '../../../core/time.ts';

export class Html {
	readonly value: string;
	constructor(value: string) {
		this.value = value;
	}
	toString(): string {
		return this.value;
	}
}

export type Part = Html | string | number | boolean | null | undefined | readonly Part[];

export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function render(part: Part): string {
	if (part instanceof Html) return part.value;
	if (Array.isArray(part)) return part.map(render).join('');
	if (part === null || part === undefined || part === false) return '';
	return escapeHtml(String(part));
}

export function html(strings: TemplateStringsArray, ...values: Part[]): Html {
	let out = strings[0];
	for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
	return new Html(out);
}

/** Query string — empty values are dropped */
export function qs(params: Record<string, string | number | undefined | null>): string {
	const p = new URLSearchParams();
	for (const [k, v] of Object.entries(params))
		if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
	const s = p.toString();
	return s ? `?${s}` : '';
}

export function time(ms: number | null | undefined): Html {
	if (ms === null || ms === undefined || Number.isNaN(ms))
		return html`<span class="muted">—</span>`;
	const text = formatLocal(ms);
	return html`<time datetime="${new Date(ms).toISOString()}" title="${text}"
		>${text.slice(0, 19)}</time
	>`;
}

export function duration(ms: number | null): string {
	if (ms === null) return '—';
	if (ms < 1000) return `${ms} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
	const m = Math.floor(ms / 60_000);
	return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Badge tone — the only thing that sets color (assets.ts .badge-<tone>) */
export type Tone = 'ok' | 'fail' | 'muted' | 'progress';

/** State → tone. Words used by run and runner states are mapped here in one place */
export function stateTone(state: string): Tone {
	switch (state) {
		case 'completed':
			return 'ok';
		case 'failed':
			return 'fail';
		case 'running':
		case 'received':
			return 'progress';
		default:
			return 'muted'; // cancelled·superseded·stopped
	}
}

/** Badge — every badge is built here. Without tone, text is treated as a state and mapped via stateTone */
export function badge(text: string, tone: Tone = stateTone(text)): Html {
	return html`<span class="badge badge-${tone}">${text}</span>`;
}

/** Tag — secondary marker (built-in, result only, changed). Every tag is built here */
export function tag(text: string, title?: string): Html {
	return title
		? html`<span class="tag" title="${title}">${text}</span>`
		: html`<span class="tag">${text}</span>`;
}

/** Small button — Copy, Show all, etc. Behavior classes (js) go in extra */
export function smallButton(label: string, extra: string, attrs: Html = html``): Html {
	return html`<button type="button" class="btn-sm ${extra}" ${attrs}>${label}</button>`;
}

/** Copy button — the dashboard is read-only, so changes are made by copying and running CLI commands */
export function copyButton(text: string, label = 'Copy'): Html {
	return smallButton(label, 'copy', html`data-copy="${text}"`);
}

/**
 * Per-request view info — viewed from another device (`--lan`), paths, VS Code and terminal would read as the viewer's own.
 * - host: host name used instead of "this PC" (data.ts `hostName`)
 * - remote: this request came from another device (guard.ts `isRemoteViewer`) — hides only what's impossible there (open in VS Code, copy path)
 * - lan: served in LAN mode (footer text)
 */
export interface ViewContext {
	host: string;
	remote: boolean;
	lan: boolean;
}

/** CLI command — for remote viewers, says where to run it (e.g. on the host over SSH) */
export function command(text: string, ctx: ViewContext): Html {
	return html`<span class="cmd"
		>${ctx.remote
			? html`<span class="muted">Run on ${ctx.host}:</span> `
			: ''}<code>${text}</code>${copyButton(text)}</span
	>`;
}

/** Absolute path on the host — for remote viewers, hides path copy (useless there) and names the host */
export function hostPath(file: string, ctx: ViewContext): Html {
	return ctx.remote
		? html`<code>${file}</code> <span class="muted">on host ${ctx.host}</span>`
		: html`<code>${file}</code> ${copyButton(file, 'Copy path')}`;
}

/** Built-in read worker — no file, not editable. Its name is a contract (server, remote AIs, log folder), so only the display changes */
export function isBuiltinWorker(name: string): boolean {
	return name.startsWith(BUILTIN_RESULTS_PREFIX);
}

export const BUILTIN_WORKER_LABEL = 'Results reader';

/** Display worker name — built-in workers get a display name + built-in tag, with the real name as tooltip (to match start output and remote AIs) */
export function workerName(name: string): Html {
	return isBuiltinWorker(name)
		? html`<span title="${name}">${BUILTIN_WORKER_LABEL} ${tag('built-in')}</span>`
		: html`${name}`;
}

/** For places that can't hold markup, like select options */
export function workerText(name: string): string {
	return isBuiltinWorker(name) ? `${BUILTIN_WORKER_LABEL} (built-in)` : name;
}

/**
 * Short task id — the **last** 8 chars. Task ids are UUID v7, whose first 12 digits are the timestamp (the first 8 change about every 65 s),
 * so a prefix makes tasks within a minute look identical. Uses the random tail with `…` to mark it partial. The CLI matches prefixes only, so the full id is in the tooltip and detail copy
 */
export function shortTaskId(taskId: string): string {
	return taskId.length <= 8 ? taskId : `…${taskId.slice(-8)}`;
}
