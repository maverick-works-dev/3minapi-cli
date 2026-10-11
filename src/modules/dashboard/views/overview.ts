import { BIN } from '../../../core/domain/index.ts';
import { stopHint } from '../../../core/host/session.ts';
import { formatBytes, formatCount } from '../../../core/text.ts';
import { daysToMs, formatInterval, formatLocal, relative } from '../../../core/time.ts';
import { RANGES, type Counts, type Overview, type RunRange } from '../data.ts';
import { badge, command, html, qs, time, workerName, type Html, type ViewContext } from './html.ts';

const RANGE_LABEL: Record<RunRange, string> = {
	all: 'All',
	today: 'Today',
	'7d': '7 days',
	'30d': '30 days'
};

export function overviewPage(o: Overview, now: number, ctx: ViewContext): Html {
	return html`
		<div class="head">
			<h1>Overview</h1>
			${rangeTabs('/', o.range)}
		</div>
		${o.hasControlDb
			? ''
			: html`<p class="note">
					No task history on host ${ctx.host} yet — run <code>${BIN} start</code> to receive tasks.
				</p>`}
		<section class="cards" aria-label="Totals">
			${card('Runs', o.totals.total, `/runs${qs({ range: o.range })}`)}
			${card('Completed', o.totals.completed, `/runs${qs({ range: o.range, state: 'completed' })}`)}
			${card(
				'Failed',
				o.totals.failed,
				`/runs${qs({ range: o.range, state: 'failed' })}`,
				o.totals.failed > 0
			)}
			${card('Cancelled', o.totals.cancelled, `/runs${qs({ range: o.range, state: 'cancelled' })}`)}
			${card('Running', o.totals.running, `/runs${qs({ range: o.range, state: 'running' })}`)}
		</section>

		<section class="panel">
			<h2>Trend <span class="muted">${o.trend.unit === 'hour' ? 'by hour' : 'by day'}</span></h2>
			${trendChart(o.trend.buckets, o.trend.unit)}
			<p class="legend">
				<span class="key key-ok"></span>completed <span class="key key-fail"></span>failed
				<span class="key key-other"></span>other
			</p>
		</section>

		<div class="grid">
			<section class="panel">
				<h2>By worker</h2>
				${o.byWorker.length === 0
					? html`<p class="muted">No runs in this period.</p>`
					: html`<table class="table">
							<thead>
								<tr>
									<th>Worker</th>
									<th class="num">Runs</th>
									<th class="num">Failed</th>
									<th class="bar-col"></th>
								</tr>
							</thead>
							<tbody>
								${o.byWorker.map(
									(w) =>
										html`<tr>
											<td>
												<a href="/runs${qs({ range: o.range, worker: w.worker })}"
													>${workerName(w.worker)}</a
												>
											</td>
											<td class="num">${formatCount(w.total)}</td>
											<td class="num">
												${w.failed > 0
													? html`<a
															href="/runs${qs({
																range: o.range,
																worker: w.worker,
																state: 'failed'
															})}"
															>${formatCount(w.failed)}</a
														>`
													: '0'}
											</td>
											<td class="bar-col">${miniBar(w, o.byWorker[0].total)}</td>
										</tr>`
								)}
							</tbody>
						</table>`}
			</section>

			<section class="panel">
				<h2>Recent failures</h2>
				${o.recentFailures.length === 0
					? html`<p class="muted">No failures in this period.</p>`
					: html`<ul class="list">
							${o.recentFailures.map(
								(t) =>
									html`<li>
										<div class="row">
											<a href="/runs/${encodeURIComponent(t.task_id)}"><code>${t.task_id}</code></a>
											${badge('failed')}
										</div>
										<div class="row muted">
											${workerName(t.worker)} · ${time(t.finished_at ?? t.received_at)}
										</div>
										${t.last_error ? html`<div class="error">${t.last_error}</div>` : ''}
									</li>`
							)}
						</ul>`}
			</section>
		</div>

		<section class="now" aria-labelledby="now-title">
			<h2 id="now-title" class="section-title">
				Host ${ctx.host} <span class="muted">— now, not limited to the period above</span>
			</h2>
			<div class="grid">${runnerPanel(o, now, ctx)} ${diskPanel(o, now, ctx)}</div>
		</section>
	`;
}

export function rangeTabs(
	base: string,
	current: RunRange,
	extra: Record<string, string | undefined> = {},
	ranges: readonly RunRange[] = RANGES
): Html {
	return html`<nav class="tabs" aria-label="Period">
		${ranges.map(
			(r) =>
				html`<a
					href="${base}${qs({ ...extra, range: r })}"
					${r === current ? html` aria-current="page"` : ''}
					>${RANGE_LABEL[r]}</a
				>`
		)}
	</nav>`;
}

/** alert — numbers above 0 use the failure color (Failed card) */
function card(label: string, value: number, href: string, alert = false): Html {
	return html`<a class="card${alert ? ' card-alert' : ''}" href="${href}"
		><span class="card-label">${label}</span
		><span class="card-value">${formatCount(value)}</span></a
	>`;
}

/** Approximate width of one count digit above a bar (viewBox units, 10px font) */
const COUNT_CHAR_WIDTH = 6.5;

/** Stacked bars — bottom up: completed (--chart-ok), other (--chart-other), failed (--chart-fail). Filled rects, count above each bar */
function trendChart(buckets: ({ bucket: string } & Counts)[], unit: 'day' | 'hour'): Html {
	const width = 720;
	const height = 160;
	// Top padding holds the counts. No y-axis ticks — each bar is labeled (an axis maximum gets misread as an average)
	const pad = { top: 18, bottom: 22, left: 4, right: 4 };
	const max = Math.max(1, ...buckets.map((b) => b.total));
	const innerW = width - pad.left - pad.right;
	const innerH = height - pad.top - pad.bottom;
	const step = innerW / Math.max(1, buckets.length);
	const barW = Math.max(2, Math.min(28, step * 0.7));
	const y = (n: number) => (n / max) * innerH;
	const labelEvery = Math.ceil(buckets.length / 8);
	const label = (b: string) => (unit === 'hour' ? `${b.slice(11)}h` : b.slice(5));
	return html`<svg
		class="chart"
		viewBox="0 0 ${width} ${height}"
		role="img"
		aria-label="Runs per ${unit}"
	>
		<line
			class="axis"
			x1="${pad.left}"
			y1="${pad.top + innerH}"
			x2="${width - pad.right}"
			y2="${pad.top + innerH}"
		/>
		${buckets.map((b, i) => {
			const x = pad.left + i * step + (step - barW) / 2;
			const other = b.total - b.completed - b.failed;
			let base = pad.top + innerH;
			const seg = (n: number, cls: string) => {
				if (n === 0) return '';
				const h = Math.max(1, y(n));
				base -= h;
				return html`<rect
					class="${cls}"
					x="${x.toFixed(1)}"
					y="${base.toFixed(1)}"
					width="${barW.toFixed(1)}"
					height="${h.toFixed(1)}"
				/>`;
			};
			const count = formatCount(b.total);
			// Omitted when wider than the slot (e.g. four digits in the 30-day view) — the bar's title shows it on hover
			const fits = count.length * COUNT_CHAR_WIDTH <= step;
			return html`<g
				><title>${b.bucket}: ${b.total} runs, ${b.completed} completed, ${b.failed} failed</title>
				${seg(b.completed, 'bar-ok')}${seg(other, 'bar-other')}${seg(b.failed, 'bar-fail')}
				${b.total > 0 && fits
					? html`<text
							class="count"
							x="${(x + barW / 2).toFixed(1)}"
							y="${(base - 4).toFixed(1)}"
							text-anchor="middle"
							>${count}</text
						>`
					: ''}
				${i % labelEvery === 0
					? html`<text
							class="tick"
							x="${(x + barW / 2).toFixed(1)}"
							y="${height - 6}"
							text-anchor="middle"
							>${label(b.bucket)}</text
						>`
					: ''}</g
			>`;
		})}
	</svg>`;
}

function miniBar(c: Counts, max: number): Html {
	const w = 120;
	const scale = (n: number) => (max === 0 ? 0 : (n / max) * w);
	const ok = scale(c.completed);
	const fail = scale(c.failed);
	const other = scale(c.total - c.completed - c.failed);
	return html`<svg class="mini" viewBox="0 0 ${w} 10" aria-hidden="true">
		<rect class="bar-ok" x="0" y="1" width="${ok.toFixed(1)}" height="8" />
		<rect class="bar-other" x="${ok.toFixed(1)}" y="1" width="${other.toFixed(1)}" height="8" />
		<rect
			class="bar-fail"
			x="${(ok + other).toFixed(1)}"
			y="1"
			width="${fail.toFixed(1)}"
			height="8"
		/>
	</svg>`;
}

function runnerPanel(o: Overview, now: number, ctx: ViewContext): Html {
	const r = o.runner;
	const rows: [string, Html | string][] = [];
	if (r.state === 'running') {
		const info = r.info;
		rows.push([
			'State',
			html`${badge('running')} pid ${info.pid}${info.detached ? ' · detached' : ''}`
		]);
		rows.push([
			'Started',
			html`${time(info.startedAt)} <span class="muted">(${relative(info.startedAt, now)})</span>`
		]);
		// live has no interval — show the mode only (docs/design/15_cli.md §9)
		rows.push(
			info.intervalMs === null
				? ['Receive mode', 'live (pulls when 3Min API signals new tasks)']
				: ['Poll interval', `${formatInterval(info.intervalMs)} (or the server minimum, if larger)`]
		);
		if (info.port !== null)
			rows.push([
				'Local server',
				html`127.0.0.1:${info.port}${info.public ? ' (public)' : ''}${ctx.remote
					? html` <span class="muted">— reachable only on host ${ctx.host}</span>`
					: ''}`
			]);
		if (info.workersDir) rows.push(['Workers folder', html`<code>${info.workersDir}</code>`]);
	} else if (r.state === 'starting') {
		rows.push(['State', html`${badge('running')} starting`]);
	} else {
		rows.push([
			'State',
			html`${badge('stopped')} <span class="muted">not running</span> ${command(
					`${BIN} start`,
					ctx
				)}`
		]);
	}
	if (o.host.name) rows.push(['Host', o.host.name]);
	if (o.lastResponse) {
		const q = o.lastResponse.quota;
		rows.push([
			'Last server response',
			html`${time(o.lastResponse.at)}
				<span class="muted">(${relative(o.lastResponse.at, now)})</span>`
		]);
		rows.push([
			'Quota',
			html`${formatCount(q.used)} / ${formatCount(q.limit)} calls · resets
			${time(Date.parse(q.reset_at))}`
		]);
	}
	if (o.stop) {
		rows.push([
			'Last stop',
			html`${badge('failed')} <code>${o.stop.reason}</code> ${time(o.stop.stoppedAt)}
				<div class="muted">${stopHint(o.stop.reason)}</div>`
		]);
	}
	if (o.end) {
		rows.push([
			'Last end',
			html`<code>${o.end.reason}</code> ${time(o.end.endedAt)}${o.end.deletedWorkers.length > 0
					? html`<div class="muted">Deleted on the server: ${o.end.deletedWorkers.join(', ')}</div>`
					: ''}`
		]);
	}
	return html`<section class="panel">
		<h2>Runner</h2>
		<dl class="kv">
			${rows.map(
				([k, v]) =>
					html`<dt>${k}</dt>
						<dd>${v}</dd>`
			)}
		</dl>
	</section>`;
}

function diskPanel(o: Overview, now: number, ctx: ViewContext): Html {
	const { controlDb, dataDb, logs } = o.disk;
	// Example date — 30 days ago (local date). The command is meant to be copied and edited
	const before = formatLocal(now - daysToMs(30)).slice(0, 10);
	return html`<section class="panel">
		<h2>Disk</h2>
		<dl class="kv">
			<dt>Task history</dt>
			<dd>
				${controlDb
					? html`${formatCount(controlDb.tasks)} task(s) · ${formatBytes(controlDb.bytes)}
							<div class="path"><code>${controlDb.file}</code></div>
							${command(`${BIN} tasks prune --before ${before}`, ctx)}`
					: html`<span class="muted">none</span>`}
			</dd>
			<dt>Saved results</dt>
			<dd>
				${dataDb
					? html`${formatCount(dataDb.results)} result(s)
							<span class="muted">(a repeating task saves each run)</span> ·
							${formatBytes(dataDb.bytes)}
							<div class="path"><code>${dataDb.file}</code></div>
							${command(`${BIN} worker results prune --before ${before}`, ctx)}`
					: html`<span class="muted">none</span>`}
			</dd>
			<dt>Logs</dt>
			<dd>
				${formatCount(logs.files)} file(s) · ${formatBytes(logs.bytes)}
				<div class="path"><code>${logs.dir}</code></div>
				<span class="muted">Deleted automatically (logRetentionDays, logMaxBytes)</span>
			</dd>
		</dl>
	</section>`;
}
