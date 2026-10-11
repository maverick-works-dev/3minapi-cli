/** String cleanup for humans and logs */

/** Truncates past max characters and appends `…` (the result stays within max) */
export function truncate(value: string, max: number): string {
	return value.length <= max ? value : value.slice(0, max - 1) + '…';
}

/**
 * Strips terminal control characters — so external values (logs, server messages, worker failure messages) cannot drive the terminal (ESC, OSC 52 clipboard writes, etc.).
 * C0 (except tab and newline), DEL, C1 (0x80–0x9F — 8-bit CSI etc.). Colors are added by the CLI at output time (#1410)
 */
export function stripControl(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

/**
 * An argument for a suggested command — wrapped in double quotes if it has spaces or shell metacharacters (works in bash, zsh, cmd, PowerShell).
 * So it stays one argument when copied and run. Also quotes `%` (cmd variables), `,` (PowerShell arrays), `@`, etc. Common paths (`/home/pi/3minapi`, `C:\Users\pi`) are left as is
 */
export function shellArg(value: string): string {
	return /^[\w+:./\\~-]+$/.test(value) ? value : `"${value}"`;
}

/** Folds multiple lines into one */
export function oneLine(value: string): string {
	return value.replace(/\s*\n\s*/g, ' ');
}

/** Call count format — `1,234` regardless of locale */
export function formatCount(n: number): string {
	return n.toLocaleString('en-US');
}

/** Byte format — `512 B`, `12.3 KB`, `2.4 MB` (1024-based, not 1000) */
export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
