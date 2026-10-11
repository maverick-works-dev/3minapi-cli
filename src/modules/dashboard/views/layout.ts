import { html, type Html, type Part, type ViewContext } from './html.ts';

export type Section = 'overview' | 'runs' | 'workers' | 'logs';

const NAV: [Section, string, string][] = [
	['overview', 'Overview', '/'],
	['runs', 'Runs', '/runs'],
	['workers', 'Workers', '/workers'],
	['logs', 'Logs', '/logs']
];

export interface PageOptions {
	title: string;
	section: Section | null;
	version: string;
	/** Auto refresh — false for detail and code views and older Runs pages */
	refresh: boolean;
	/** Refresh interval (ms) */
	refreshMs: number;
	/** Per-request view info — the host name is filled only after auth (hidden from token-less visitors) */
	ctx: Omit<ViewContext, 'host'> & { host: string | null };
}

export function layout(opts: PageOptions, body: Part): Html {
	return html`<!doctype html>
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="color-scheme" content="light dark" />
				<meta name="referrer" content="no-referrer" />
				<title>${opts.title} · 3minapi dashboard</title>
				<link rel="stylesheet" href="/assets/app.css" />
				<script src="/assets/app.js" defer></script>
			</head>
			<body
				${opts.ctx.host !== null ? html` data-host="${opts.ctx.host}"` : ''}${opts.ctx.remote
					? html` data-remote`
					: ''}
			>
				<header class="top">
					<a class="brand" href="/">3minapi <span>dashboard</span></a>
					<nav aria-label="Sections">
						${NAV.map(
							([key, label, href]) =>
								html`<a href="${href}" ${key === opts.section ? html` aria-current="page"` : ''}
									>${label}</a
								>`
						)}
					</nav>
					${opts.refresh
						? html`<label class="auto"
								><input type="checkbox" id="auto-refresh" checked /> Auto refresh</label
							>`
						: ''}
				</header>
				${opts.refresh ? html`<p id="stale" class="stale" role="status" hidden></p>` : ''}
				<main id="main" ${opts.refresh ? html` data-refresh="${opts.refreshMs}"` : ''}>
					${body}
				</main>
				<footer class="foot">
					<span>3minapi ${opts.version}</span>
					<span
						>${opts.ctx.lan
							? 'Read-only. LAN mode is on — other devices on the network see these pages over plain HTTP.'
							: 'Local and read-only — data never leaves this PC.'}
						Change things with the CLI.</span
					>
				</footer>
			</body>
		</html> `;
}

export function message(title: string, text: Part): Html {
	return html`<section class="empty">
		<h1>${title}</h1>
		<p>${text}</p>
	</section>`;
}
