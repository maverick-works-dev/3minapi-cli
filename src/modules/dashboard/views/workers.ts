import { pathToFileURL } from 'node:url';
import { BIN } from '../../../core/domain/index.ts';
import { formatBytes } from '../../../core/text.ts';
import { formatInterval } from '../../../core/time.ts';
import type { WorkersView } from '../data.ts';
import {
	BUILTIN_WORKER_LABEL,
	badge,
	command,
	copyButton,
	hostPath,
	html,
	tag,
	time,
	type Html,
	type ViewContext
} from './html.ts';

/** Link VS Code opens — `vscode://file/<absolute path>`. Windows paths use forward slashes too */
export function vscodeLink(file: string): string {
	return `vscode://file${pathToFileURL(file).pathname}`;
}

export function workersPage(v: WorkersView, ctx: ViewContext): Html {
	const sync = v.lastSync;
	return html`
		<div class="head">
			<h1>Workers</h1>
			${v.dir ? html`<p class="path">${hostPath(v.dir, ctx)}</p>` : ''}
		</div>
		<p class="note">
			${sync
				? html`Description, timeout and input schema are as of the last sync (${time(sync.at)}).
					Files are not loaded here — loading a worker runs its top-level code.`
				: html`No sync record in the recent logs — description, timeout and input schema appear
						after <code>${BIN} start</code> or <code>${BIN} reload</code>.`}
			After editing a file, apply it to a running start with ${command(`${BIN} reload`, ctx)}
		</p>
		${v.error
			? html`<p class="error">Cannot read the workers folder: ${v.error}</p>`
			: v.dirMissing
				? html`<p class="muted">
						${v.dir ? 'The workers folder does not exist.' : 'This host has no project.'} Run
						${command(`${BIN} init`, ctx)} (creates ~/3minapi) or
						${command(`${BIN} init <folder>`, ctx)}.
					</p>`
				: v.files.length === 0
					? html`<p class="muted">
							No worker files. Create one with ${command(`${BIN} worker new <name>`, ctx)}
						</p>`
					: html`<div class="scroll">
							<table class="table">
								<thead>
									<tr>
										<th class="num">No</th>
										<th>Worker</th>
										<th>Description</th>
										<th class="num">Timeout</th>
										<th>Input schema</th>
										<th>Last sync</th>
										<th>File</th>
									</tr>
								</thead>
								<tbody>
									${v.files.map((w, i) => {
										const meta = sync?.local?.get(w.name) ?? null;
										const result = sync?.results.get(w.name);
										const rejected = sync?.rejected.get(w.name);
										const file = w.files[0];
										return html`<tr>
											<td class="num muted">${i + 1}</td>
											<td>
												<a href="/workers/${encodeURIComponent(w.name)}"><code>${w.name}</code></a>
											</td>
											<td>
												${meta?.description ?? html`<span class="muted">—</span>`}${meta?.message
													? html`<div class="error">${meta.message}</div>`
													: ''}
											</td>
											<td class="num">
												${meta?.timeout_ms
													? formatInterval(meta.timeout_ms)
													: html`<span class="muted">default</span>`}
											</td>
											<td>
												${meta
													? meta.input_schema
														? 'yes'
														: 'no'
													: html`<span class="muted">—</span>`}
											</td>
											<td>
												${syncBadge(result, rejected) ??
												(sync
													? html`<span class="muted">not sent</span>`
													: html`<span class="muted">—</span>`)}${sync &&
												file &&
												file.modifiedAt > sync.at
													? html` ${tag('changed', 'The file changed after the last sync')}`
													: ''}
											</td>
											<td class="files">
												${w.files.map(
													(f) =>
														html`<div>
															${formatBytes(f.bytes)}${ctx.remote
																? html` · <span class="muted">on host ${ctx.host}</span>`
																: html` ·
																		<a href="${vscodeLink(f.file)}">Open in VS Code</a>
																		${copyButton(f.file, 'Copy path')}`}
														</div>`
												)}${w.files.length > 1
													? html`<div class="error">
															More than one file with this name — keep only one.
														</div>`
													: ''}
											</td>
										</tr>`;
									})}
								</tbody>
							</table>
						</div>`}
		${v.builtin ? builtinPanel(v.builtin, v.lastSync, ctx) : ''}
	`;
}

/** Built-in read worker — absent from the table above (no file) but appears in Runs and Logs. Explains what it is */
function builtinPanel(name: string, sync: WorkersView['lastSync'], ctx: ViewContext): Html {
	const result = sync?.results.get(name);
	const rejected = sync?.rejected.get(name);
	return html`<section class="panel">
		<h2>Built-in ${syncBadge(result, rejected) ?? ''}</h2>
		<dl class="kv">
			<dt>${BUILTIN_WORKER_LABEL}</dt>
			<dd>
				Part of 3minapi, not a file — it cannot be edited. Remote AIs use it to read the results
				saved on host ${ctx.host} (describe, query, read).
				<div class="muted">
					Registered as <code>${name}</code> — the name you see in remote AIs and in the start
					output.
				</div>
			</dd>
		</dl>
	</section>`;
}

/** Server verdict of the last sync — rejections in failure color, registrations (registered, created, …) in normal color. null without a verdict */
function syncBadge(result: string | undefined, rejected: string | undefined): Html | null {
	if (rejected) return badge(rejected, 'fail');
	if (result) return badge(result, 'ok');
	return null;
}

export function workerCodePage(
	name: string,
	files: { file: string; text: string; truncated: boolean; bytes: number }[],
	ctx: ViewContext
): Html {
	return html`
		<p class="crumbs"><a href="/workers">Workers</a> / <code>${name}</code></p>
		<div class="head">
			<h1><code>${name}</code></h1>
		</div>
		<p class="note">
			Read-only view of the file as text. Edit it in your editor, then run
			${command(`${BIN} reload`, ctx)}
		</p>
		${files.map(
			(f) =>
				html`<section class="panel">
					<h2 class="path"><code>${f.file}</code></h2>
					<p>
						${ctx.remote
							? html`<span class="muted">on host ${ctx.host}</span>`
							: html`<a href="${vscodeLink(f.file)}">Open in VS Code</a> ${copyButton(
										f.file,
										'Copy path'
									)}`}
						<span class="muted">${formatBytes(f.bytes)}</span>
					</p>
					<pre class="code source">${f.text}</pre>
					${f.truncated
						? html`<p class="muted">Showing the first part only — the file is larger.</p>`
						: ''}
				</section>`
		)}
	`;
}
