import { BIN } from '../../../core/domain/index.ts';
import { stripControl } from '../../../core/log-read.ts';
import {
	LOG_LEVELS,
	LOG_SCAN_MAX_BYTES,
	type LevelFilter,
	type LogLine,
	type LogRead
} from '../data.ts';
import {
	command,
	html,
	shortTaskId,
	smallButton,
	time,
	workerName,
	workerText,
	type Html,
	type ViewContext
} from './html.ts';

export const LOG_LINE_CHOICES = [100, 300, 1000] as const;

export function logsPage(
	read: LogRead,
	opts: { channel: string | null; channels: string[]; level: LevelFilter; count: number },
	ctx: ViewContext
): Html {
	return html`
		<div class="head"><h1>Logs</h1></div>
		<form class="filters" method="get" action="/logs" data-autosubmit>
			<label
				>Log
				<select name="channel">
					<option value="" ${opts.channel === null ? html` selected` : ''}>CLI (app)</option>
					${opts.channels.map(
						(c) =>
							html`<option value="${c}" ${c === opts.channel ? html` selected` : ''}>
								worker: ${workerText(c)}
							</option>`
					)}
				</select>
			</label>
			<label
				>Level
				<select name="level">
					${LOG_LEVELS.map(
						(l) =>
							html`<option value="${l}" ${l === opts.level ? html` selected` : ''}>
								${l === 'debug' ? 'all' : `${l} and above`}
							</option>`
					)}
				</select>
			</label>
			<label
				>Lines
				<select name="n">
					${LOG_LINE_CHOICES.map(
						(n) =>
							html`<option value="${n}" ${n === opts.count ? html` selected` : ''}>${n}</option>`
					)}
				</select>
			</label>
			<label
				>Find
				<input
					type="search"
					id="log-find"
					placeholder="Text in the message"
					autocomplete="off"
					spellcheck="false"
				/>
			</label>
			<noscript><button type="submit">Apply</button></noscript>
		</form>
		<p class="note">
			Follow it in a terminal:
			${command(
				opts.channel === null ? `${BIN} logs -f` : `${BIN} worker logs ${opts.channel} -f`,
				ctx
			)}
		</p>
		${read.lines.length === 0
			? html`<p class="muted">No log lines.</p>`
			: html`<p class="muted" id="log-find-count" hidden></p>
					${logTable([...read.lines].reverse(), { channel: false, task: true })}`}
		${read.truncated
			? html`<p class="muted">
					Searched the most recent ${LOG_SCAN_MAX_BYTES / 1024 / 1024} MB of this log. For older
					lines use
					${command(
						opts.channel === null
							? `${BIN} logs -n 10000`
							: `${BIN} worker logs ${opts.channel} -n 10000`,
						ctx
					)}
				</p>`
			: ''}
	`;
}

/**
 * Log table — the caller sets the order. Long messages (large JSON etc.) are clamped to 3 lines with "Show all" (app.js enables it only on overflow).
 * Newlines are not preserved — so one record doesn't fill the screen
 *
 *   channel  Log column (run detail — app and worker channels mixed)
 *   task     Task column — task_id linked to run detail (Logs view). Omitted in run detail, where all rows are the same task
 */
export function logTable(lines: LogLine[], cols: { channel: boolean; task: boolean }): Html {
	return html`<div class="scroll">
		<table class="table log">
			<thead>
				<tr>
					<th>Time</th>
					${cols.channel ? html`<th>Log</th>` : ''}
					<th>Level</th>
					${cols.task ? html`<th>Task</th>` : ''}
					<th>Message</th>
				</tr>
			</thead>
			<tbody>
				${lines.map((l) => {
					if (!l.record) {
						return html`<tr>
							<td></td>
							${cols.channel ? html`<td></td>` : ''}
							<td></td>
							${cols.task ? html`<td></td>` : ''}
							<td class="msg-cell">${clamp(html`<code>${stripControl(l.raw ?? '')}</code>`)}</td>
						</tr>`;
					}
					const r = l.record;
					const taskId = typeof r.attributes?.task_id === 'string' ? r.attributes.task_id : null;
					const attrs = Object.entries(r.attributes ?? {})
						// Drop it from attributes when shown in the Task column — no duplicate value
						.filter(([k]) => !(cols.task && taskId !== null && k === 'task_id'))
						.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
						.join(' ');
					return html`<tr class="lvl-${r.severity_text}">
						<td>${time(Date.parse(r.timestamp))}</td>
						${cols.channel
							? html`<td>${l.channel === null ? 'cli' : workerName(l.channel)}</td>`
							: ''}
						<td><span class="level">${String(r.severity_text)}</span></td>
						${cols.task
							? html`<td class="task">
									${taskId
										? html`<a href="/runs/${encodeURIComponent(taskId)}" title="${taskId}"
												><code>${shortTaskId(taskId)}</code></a
											>`
										: ''}
								</td>`
							: ''}
						<td class="msg-cell">
							${clamp(
								html`<span class="msg">${stripControl(String(r.body))}</span>${attrs
										? html` <span class="attrs">${stripControl(attrs)}</span>`
										: ''}`
							)}
						</td>
					</tr>`;
				})}
			</tbody>
		</table>
	</div>`;
}

function clamp(content: Html): Html {
	return html`<div class="clamp">${content}</div>
		${smallButton('Show all', 'more', html`hidden`)}`;
}
