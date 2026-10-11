/**
 * Reading text files users write by hand (config JSON, `.env`) (docs/design/15_cli.md §5, #1409).
 *
 * Windows PowerShell 5.1 writes UTF-8 with BOM for `Set-Content -Encoding UTF8` and UTF-16 LE with BOM for `>`.
 * - A UTF-8 BOM is stripped — otherwise JSON.parse fails and `parseEnv` silently turns the first key into `\uFEFFKEY`
 * - UTF-16 is rejected with how to fix it — reading it as utf8 gives a parse error with no visible cause
 *
 * Files the CLI writes itself (credentials.json, project.json, etc.) never get a BOM, so they do not use this.
 */
import { readFileSync } from 'node:fs';
import { ConfigError } from './domain/index.ts';

/** fs errors (ENOENT etc.) are rethrown as is. UTF-16 throws ConfigError */
export function readUserText(file: string): string {
	const bytes = readFileSync(file);
	if (
		bytes.length >= 2 &&
		((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
	) {
		throw new ConfigError(
			`${file} is saved as UTF-16. Save it as UTF-8 — in Notepad choose "UTF-8" when saving; ` +
				`in PowerShell write it with [IO.File]::WriteAllText(path, text).`
		);
	}
	const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
	return bytes.toString('utf8', bom ? 3 : 0);
}
