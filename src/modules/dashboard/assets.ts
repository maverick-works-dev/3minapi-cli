/**
 * Dashboard CSS and script — handwritten, no build tool or framework (zero runtime dependencies). CSP blocks inline scripts
 * and styles, so they are served from a separate path (/assets/…). Values (color, size) are :root variables; repeated shapes
 * come from shared classes (.badge, .tag, .btn-sm, .bar-*) and the views/html.ts helpers (badge, tag, copyButton).
 * Monochrome base; three colors only where meaning matters (success, warning, failure) — status badges, log levels, failure
 * bars, error lines. Success bars use the text color so only failures stand out. Badge text and border shape keep states apart without color.
 */

export const APP_CSS = `
:root {
	--bg: #ffffff;
	--fg: #111111;
	--muted: #6b6b6b;
	--line: #e3e3e3;
	--soft: #f4f4f4;
	--other: #b5b5b5;
	--ok: #1a7f37;
	--ok-bg: #dafbe1;
	--warn: #9a6700;
	--warn-bg: #fff8c5;
	--fail: #cf222e;
	--fail-bg: #ffebe9;
	/* Chart — separate from text color. Success uses the text color, others gray, only failure red */
	--chart-ok: var(--fg);
	--chart-other: var(--other);
	--chart-fail: var(--fail);
	/* Font sizes — small buttons, badges, tags / labels, secondary text / code, logs / chart numbers */
	--fs-xs: 11.5px;
	--fs-sm: 12px;
	--fs-code: 12.5px;
	--fs-chart: 10px;
	--radius: 6px;
	--mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
	--sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
	color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #0f0f0f;
		--fg: #ededed;
		--muted: #9a9a9a;
		--line: #2a2a2a;
		--soft: #1a1a1a;
		--other: #555555;
		--ok: #3fb950;
		--ok-bg: rgba(63, 185, 80, 0.15);
		--warn: #d29922;
		--warn-bg: rgba(210, 153, 34, 0.15);
		--fail: #f85149;
		--fail-bg: rgba(248, 81, 73, 0.15);
	}
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
	margin: 0;
	background: var(--bg);
	color: var(--fg);
	font: 14px/1.5 var(--sans);
}
a { color: inherit; text-underline-offset: 2px; }
code, pre, .mono { font-family: var(--mono); font-size: var(--fs-code); }
h1 { font-size: 20px; margin: 0; letter-spacing: -0.01em; }
h2 { font-size: 13px; margin: 0 0 12px; text-transform: uppercase; letter-spacing: 0.06em; }
h2 .muted { text-transform: none; letter-spacing: 0; font-weight: normal; }
h2 .badge { text-transform: none; letter-spacing: 0; font-weight: normal; margin-left: 6px; vertical-align: 1px; }
.muted { color: var(--muted); }

.top {
	position: sticky; top: 0; z-index: 1;
	display: flex; align-items: center; gap: 20px; flex-wrap: wrap;
	padding: 10px 24px;
	background: var(--bg);
	border-bottom: 1px solid var(--line);
}
.brand { font-weight: 700; text-decoration: none; }
.brand span { font-weight: 400; color: var(--muted); }
.top nav { display: flex; gap: 4px; flex-wrap: wrap; }
.top nav a, .tabs a {
	padding: 4px 10px; border-radius: var(--radius); text-decoration: none; color: var(--muted);
}
.top nav a:hover, .tabs a:hover { color: var(--fg); background: var(--soft); }
.top nav a[aria-current], .tabs a[aria-current] { color: var(--bg); background: var(--fg); }
.auto { margin-left: auto; color: var(--muted); font-size: 13px; display: flex; gap: 6px; align-items: center; }

main { max-width: 1200px; margin: 0 auto; padding: 24px; }
.foot {
	max-width: 1200px; margin: 0 auto; padding: 16px 24px 32px;
	display: flex; gap: 16px; flex-wrap: wrap; justify-content: space-between;
	color: var(--muted); font-size: var(--fs-sm); border-top: 1px solid var(--line);
}
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.tabs { display: flex; gap: 4px; }
.note { color: var(--muted); margin: 0 0 16px; }
.crumbs { color: var(--muted); margin: 0 0 8px; overflow-wrap: anywhere; }
.path code { overflow-wrap: anywhere; }
h2.path { text-transform: none; letter-spacing: 0; font-weight: 500; }

.cards { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
.card {
	display: flex; flex-direction: column; gap: 4px; padding: 14px 16px;
	border: 1px solid var(--line); border-radius: var(--radius); text-decoration: none;
}
.card:hover { border-color: var(--fg); }
.card-label { color: var(--muted); font-size: var(--fs-sm); text-transform: uppercase; letter-spacing: 0.06em; }
.card-value { font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; }
.card-alert .card-value { color: var(--fail); }

.panel { border: 1px solid var(--line); border-radius: var(--radius); padding: 16px; margin-bottom: 16px; min-width: 0; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.grid > .panel { margin-bottom: 16px; }
.now { border-top: 1px solid var(--fg); margin-top: 32px; padding-top: 20px; }
.section-title { margin-bottom: 16px; }

.chart { width: 100%; height: auto; display: block; }
.chart .axis { stroke: var(--line); }
.chart .tick { fill: var(--muted); font: var(--fs-chart) var(--sans); }
.chart .count { fill: var(--fg); font: 600 var(--fs-chart) var(--sans); font-variant-numeric: tabular-nums; }
.bar-ok { fill: var(--chart-ok); }
.bar-other { fill: var(--chart-other); }
.bar-fail { fill: var(--chart-fail); }
.mini { width: 120px; height: 10px; display: block; }
.legend { color: var(--muted); font-size: var(--fs-sm); margin: 8px 0 0; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.key { display: inline-block; width: 10px; height: 10px; margin-left: 8px; }
.key-ok { background: var(--chart-ok); }
.key-other { background: var(--chart-other); }
.key-fail { background: var(--chart-fail); }

.scroll { overflow-x: auto; }
.scroll + .panel { margin-top: 16px; }
.table { width: 100%; border-collapse: collapse; }
.table th, .table td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
.table thead th { color: var(--muted); font-weight: 500; font-size: var(--fs-sm); white-space: nowrap; }
.table tbody tr:hover { background: var(--soft); }
.num { text-align: right !important; font-variant-numeric: tabular-nums; white-space: nowrap; }
.bar-col { width: 130px; }
.runs td { white-space: nowrap; }
.runs-of-task td { white-space: nowrap; }
.runs-of-task td.preview { white-space: nowrap; max-width: 0; width: 100%; overflow: hidden; text-overflow: ellipsis; }
.runs-of-task td.preview a { color: inherit; text-decoration: none; }
.runs-of-task td.preview code.failed { color: var(--fail); }
.run-nav { justify-content: space-between; margin: 0 0 12px; }
.entries th { width: 1%; white-space: nowrap; font-family: var(--mono); font-weight: 500; }
.entries pre { margin: 0; }
.files div { white-space: nowrap; }

.badge {
	display: inline-block; padding: 0 7px; border-radius: 999px; font-size: var(--fs-xs); line-height: 18px;
	border: 1px solid var(--fg); white-space: nowrap;
}
/* Badges are colored by tone only — the state → tone mapping lives in views/html.ts stateTone */
.badge-ok { background: var(--ok-bg); color: var(--ok); border-color: var(--ok); }
.badge-fail { background: var(--fail-bg); color: var(--fail); border-color: var(--fail); font-weight: 600; }
.badge-muted { border-style: dashed; color: var(--muted); border-color: var(--muted); }
.badge-progress { border-style: dotted; }
.tag { font-size: var(--fs-xs); color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; white-space: nowrap; }

.list { list-style: none; margin: 0; padding: 0; }
.list li { padding: 8px 0; border-bottom: 1px solid var(--line); }
.list li:last-child { border-bottom: 0; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.error { font-family: var(--mono); font-size: var(--fs-code); white-space: pre-wrap; overflow-wrap: anywhere; border-left: 2px solid var(--fail); padding-left: 8px; margin-top: 4px; }

.kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 16px; margin: 0; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; overflow-wrap: anywhere; }

.filters { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.filters label { display: flex; flex-direction: column; gap: 2px; font-size: var(--fs-sm); color: var(--muted); }
select, button {
	font: inherit; font-size: 13px; color: var(--fg); background: var(--bg);
	border: 1px solid var(--line); border-radius: var(--radius); padding: 4px 8px;
}
select:focus-visible, button:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
/* Small buttons — Copy, Show all, etc. Secondary actions: muted, darker on hover */
.btn-sm { font-size: var(--fs-xs); padding: 1px 7px; cursor: pointer; color: var(--muted); }
.btn-sm:hover { color: var(--fg); border-color: var(--fg); }
.btn-sm.done { color: var(--bg); background: var(--fg); border-color: var(--fg); }
/* Temporary field for the copy fallback — CSP blocks style attributes, so it sits off-screen */
.copy-buf { position: fixed; top: 0; left: -9999px; width: 1px; height: 1px; opacity: 0; }
.cmd { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.cmd code { background: var(--soft); padding: 1px 6px; border-radius: 4px; }

pre.code {
	margin: 0; padding: 12px; background: var(--soft); border-radius: var(--radius);
	overflow: auto; max-height: 70vh; white-space: pre-wrap; overflow-wrap: anywhere;
}
pre.source { white-space: pre; tab-size: 4; }
.pager { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
.pager-runs { justify-content: space-between; margin-top: 12px; }

.log td { font-family: var(--mono); font-size: var(--fs-code); }
.log td:first-child, .log td.task, .runs td.task { white-space: nowrap; }
.log .attrs { color: var(--muted); overflow-wrap: anywhere; }
.log .msg { overflow-wrap: anywhere; }
.log .clamp {
	display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3;
	overflow: hidden; overflow-wrap: anywhere;
}
.log .clamp.open { display: block; -webkit-line-clamp: unset; line-clamp: none; overflow: visible; }
.log .more { margin-top: 4px; }
.lvl-error .level { color: var(--fail); font-weight: 700; }
.lvl-warn .level { color: var(--warn); font-weight: 700; }
.lvl-debug { color: var(--muted); }

.empty { text-align: center; padding: 64px 16px; }
/* Auto-refresh failure notice — tells that the view is frozen */
.stale {
	width: calc(100% - 48px); max-width: 1152px; margin: 16px auto 0; padding: 8px 12px; border-radius: var(--radius);
	background: var(--warn-bg); color: var(--warn); border: 1px solid var(--warn); font-size: var(--fs-sm);
}
.stale[hidden] { display: none; }

@media (max-width: 800px) {
	.top { padding: 10px 16px; gap: 10px; }
	.auto { margin-left: 0; }
	main { padding: 16px; }
	.foot { padding: 16px; }
	.stale { width: calc(100% - 32px); }
	.cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
	.grid { grid-template-columns: minmax(0, 1fr); gap: 0; }
	.kv { grid-template-columns: minmax(0, 1fr); gap: 0 0; }
	.kv dt { margin-top: 8px; }
	.bar-col { display: none; }
	/* In Logs the message is the content — as a table on narrow screens only the Message column shrinks and wraps per word.
	   Stack rows instead: time, level, task on one line, the message full width below */
	.log thead { display: none; }
	.log, .log tbody { display: block; }
	.log tr { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; padding: 8px 0; border-bottom: 1px solid var(--line); }
	.log td { display: block; padding: 0; border-bottom: 0; }
	.log td:empty { display: none; }
	.log td.msg-cell { flex-basis: 100%; }
}
`;

/**
 * - Submits as soon as a filter select changes
 * - Copy buttons (navigator.clipboard — 127.0.0.1 is a secure context)
 * - Log find (filters fetched lines in the browser only), Show all for long messages
 * - Auto refresh: refetches the same URL and replaces only <main>. Skipped when the tab is hidden, text is being selected, a select
 *   or the find input has focus, a message is expanded, or it is turned off. Failures (dashboard ended, 401, 500) show as a notice
 *   at the top so a frozen view doesn't pass for live
 */
export const APP_JS = `
(function () {
	'use strict';
	var KEY = 'tm-dashboard-auto-refresh';
	// Logs find — filters fetched lines in the browser only. The value survives auto refresh replacing <main>
	var findText = '';

	function applyFind(root) {
		var q = findText.trim().toLowerCase();
		var rows = root.querySelectorAll('table.log tbody tr');
		var shown = 0;
		rows.forEach(function (row) {
			var cell = row.querySelector('.msg-cell .clamp') || row;
			var hit = !q || cell.textContent.toLowerCase().indexOf(q) !== -1;
			row.hidden = !hit;
			if (hit) shown++;
		});
		var count = root.querySelector('#log-find-count');
		if (count) {
			count.hidden = !q;
			count.textContent = shown + ' of ' + rows.length + ' lines match';
		}
	}

	function bind(root) {
		var find = root.querySelector('#log-find');
		if (find) {
			find.value = findText;
			find.addEventListener('input', function () {
				findText = find.value;
				applyFind(root);
			});
			// Keep Enter from submitting the form and reloading — find is never sent to the server
			find.addEventListener('keydown', function (e) {
				if (e.key === 'Enter') e.preventDefault();
			});
			applyFind(root);
		}
		root.querySelectorAll('form[data-autosubmit] select').forEach(function (el) {
			el.addEventListener('change', function () { el.form.submit(); });
		});
		// Long log messages — enable the expand button only on cells overflowing 3 lines
		root.querySelectorAll('.log .clamp').forEach(function (box) {
			var more = box.nextElementSibling;
			if (!more || !more.classList.contains('more')) return;
			if (box.scrollHeight > box.clientHeight + 1) more.hidden = false;
			more.addEventListener('click', function () {
				var open = box.classList.toggle('open');
				more.textContent = open ? 'Show less' : 'Show all';
			});
		});
		root.querySelectorAll('button[data-copy]').forEach(function (btn) {
			// Read the original label once — reading on click would lock in "Copied" on a second click while it shows
			var label = btn.textContent;
			var timer = null;
			var show = function (msg, ms) {
				clearTimeout(timer);
				btn.textContent = msg;
				btn.classList.add('done');
				timer = setTimeout(function () { btn.textContent = label; btn.classList.remove('done'); }, ms);
			};
			btn.addEventListener('click', function () {
				var text = btn.getAttribute('data-copy');
				// navigator.clipboard needs a secure context (HTTPS, localhost) — absent when opened via a LAN address (http://192.168.x.x)
				if (navigator.clipboard && window.isSecureContext) {
					navigator.clipboard.writeText(text).then(
						function () { show('Copied', 1200); },
						function () { fallbackCopy(btn, text, show); }
					);
				} else {
					fallbackCopy(btn, text, show);
				}
			});
		});
	}

	// Clipboard API missing or denied — select a temporary field and execCommand('copy'). If that fails too, select the text
	// before the button for the user to copy. Auto refresh keeps the selection (it skips while text is selected)
	function fallbackCopy(btn, text, show) {
		var active = document.activeElement;
		var box = document.createElement('textarea');
		box.className = 'copy-buf';
		box.value = text;
		box.setAttribute('readonly', '');
		document.body.appendChild(box);
		box.select();
		box.setSelectionRange(0, text.length);
		var ok = false;
		try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
		document.body.removeChild(box);
		if (active && active.focus) active.focus();
		if (ok) { show('Copied', 1200); return; }
		var code = btn.previousElementSibling;
		var sel = window.getSelection && window.getSelection();
		if (sel && code && code.tagName === 'CODE') {
			var range = document.createRange();
			range.selectNodeContents(code);
			sel.removeAllRanges();
			sel.addRange(range);
			show('Selected — copy it', 2500);
		} else {
			show('Copy failed', 2500);
		}
	}

	// Viewed remotely (another device), the terminal is the host's — say so explicitly
	function onHost() {
		var host = document.body.getAttribute('data-host');
		if (!document.body.hasAttribute('data-remote')) return '';
		return host ? ' on host ' + host : ' on the computer running the dashboard';
	}

	// Auto refresh failed — don't hide that the view is frozen at the last success (people judge failure counts from it)
	var lastOk = new Date();
	function stale(text) {
		var box = document.getElementById('stale');
		if (!box) return;
		// The UI is English only — fixed HH:MM:SS instead of the browser locale format (e.g. 4:27 PM)
		box.textContent = text + ' Showing data from ' + lastOk.toTimeString().slice(0, 8) + '.';
		box.hidden = false;
	}
	function fresh() {
		lastOk = new Date();
		var box = document.getElementById('stale');
		if (box) box.hidden = true;
	}

	function autoOn() {
		try { return localStorage.getItem(KEY) !== 'off'; } catch (e) { return true; }
	}

	document.addEventListener('DOMContentLoaded', function () {
		bind(document);
		var main = document.getElementById('main');
		var toggle = document.getElementById('auto-refresh');
		if (!main || !main.hasAttribute('data-refresh')) return;
		if (toggle) {
			toggle.checked = autoOn();
			toggle.addEventListener('change', function () {
				try { localStorage.setItem(KEY, toggle.checked ? 'on' : 'off'); } catch (e) {}
			});
		}
		var ms = Number(main.getAttribute('data-refresh')) || 5000;
		var busy = false;
		var timer = setInterval(function () {
			if (busy || document.hidden || (toggle && !toggle.checked)) return;
			var sel = window.getSelection && window.getSelection();
			if (sel && sel.type === 'Range') return;
			var active = document.activeElement;
			if (active && (active.tagName === 'SELECT' || active.id === 'log-find')) return;
			// Don't refresh while a message is expanded — it would collapse and shift
			if (main.querySelector('.clamp.open')) return;
			busy = true;
			fetch(location.href, { credentials: 'same-origin', cache: 'no-store' })
				.then(function (res) {
					if (res.status === 401) {
						// This link is dead — retries only get 401. Stop (in LAN mode each one would log a rejection)
						clearInterval(timer);
						stale('This dashboard run has ended — open the new link printed by 3minapi dashboard (or 3minapi dashboard url' + onHost() + ').');
						return null;
					}
					if (!res.ok) {
						stale('Could not refresh (HTTP ' + res.status + ') — reload the page to see the error; details are in the terminal' + onHost() + '.');
						return null;
					}
					return res.text();
				})
				.then(function (text) {
					if (!text) return;
					var doc = new DOMParser().parseFromString(text, 'text/html');
					var next = doc.getElementById('main');
					if (!next) return;
					// Same-origin document escaped by the server — move its nodes over (no re-parse from a string)
					main.replaceChildren.apply(main, Array.from(next.childNodes));
					bind(main);
					fresh();
				})
				.catch(function () {
					stale('The dashboard is not running (stopped with Ctrl+C or 3minapi dashboard stop?) — start it again' + onHost() + ' to see current data.');
				})
				.then(function () { busy = false; });
		}, ms);
	});
})();
`;
