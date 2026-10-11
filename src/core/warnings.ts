/**
 * `node:sqlite` is experimental on Node 24.12–24.14 and prints an ExperimentalWarning to stderr on import
 * (observed on Node 24.12.0; release candidate from 24.15). It would mix into user-facing output every run, so **only that warning** is filtered.
 * Disabling all warnings like `NODE_NO_WARNINGS` would also hide the others (deprecations etc.).
 *
 * ⚠️ Must be installed before any module that imports `node:sqlite` — bin.ts calls it first.
 */
const SQLITE_EXPERIMENTAL = 'SQLite is an experimental feature';

export function suppressSqliteExperimentalWarning(): void {
	const original = process.emitWarning;
	process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
		const message = typeof warning === 'string' ? warning : warning?.message;
		if (typeof message === 'string' && message.startsWith(SQLITE_EXPERIMENTAL)) return;
		return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
	} as typeof process.emitWarning;
}
