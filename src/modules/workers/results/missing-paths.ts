/**
 * JSON paths referenced by a query that **no result in the scope has** (docs/mcp/surface/tools/task-tools.md, #1446).
 *
 * SQLite reads a missing path as NULL without error, so SQL with guessed field names returns NULLs or silently wrong
 * aggregates. This reports that fact in the query response itself; the response stays a success with the same rows.
 *
 * **Biased toward false negatives** — a warning on correct SQL makes the model doubt a good answer:
 * - Only `$…` literals in a JSON-path position (right of `->`/`->>`, 2nd+ argument of `json_*(…)`) count — not
 *   comparison values
 * - Array indexes (`[3]`, `[#-1]`) are compared as the shape notation `[*]`
 * - A path absent as an absolute path still counts as present if it matches the **tail** of a shape path —
 *   `json_extract(j.value,'$.amount')` after `json_each(r.payload,'$.items') j` is element-relative
 *   (`$.amount` ↔ `$.items[*].amount`)
 * - A bare `$` (the whole document) is ignored
 * Scopes that cannot be judged (missing shape or truncated results) are filtered out by the caller.
 */

/** Cap on paths listed in the response — keeps large SQL from bloating it */
export const MISSING_PATHS_MAX = 10;

/**
 * String literals **used** as JSON paths in the SQL — in order, without duplicates.
 *
 * A literal starting with `$` may be a comparison value (`= '$.USD'`), so the position decides: right of `->`/`->>`,
 * or the 2nd+ argument of a `json_*(…)` call (`json_extract(x, '$.a', '$.b')`, `json_each(x, '$.items')`).
 */
export function sqlJsonPaths(sql: string): string[] {
	const out: string[] = [];
	for (const m of sql.matchAll(/'((?:[^']|'')*)'/g)) {
		const literal = m[1].replace(/''/g, "'");
		if (literal.length <= 1 || !literal.startsWith('$') || out.includes(literal)) continue;
		if (isPathPosition(sql, m.index ?? 0)) out.push(literal);
	}
	return out;
}

/** Whether `at` (the literal's opening quote) follows `->`/`->>`, or a comma inside a `json_*(` call */
function isPathPosition(sql: string, at: number): boolean {
	const before = sql.slice(0, at).trimEnd();
	if (before.endsWith('->') || before.endsWith('->>')) return true;
	if (!before.endsWith(',')) return false;
	// Find the enclosing open paren, skipping nested parens and strings
	let depth = 0;
	let inString = false;
	for (let i = before.length - 2; i >= 0; i--) {
		const ch = before[i];
		if (ch === "'") inString = !inString;
		if (inString) continue;
		if (ch === ')') depth++;
		else if (ch === '(') {
			if (depth === 0) return /json_\w+\s*$/i.test(before.slice(0, i));
			depth--;
		}
	}
	return false;
}

/** Array indexes → the shape's `[*]` */
function normalize(path: string): string {
	return path.replace(/\[(?:\d+|#[^\]]*)\]/g, '[*]');
}

/**
 * Paths not in `known` (the union of shape paths in the scope). Any absolute or tail match counts as present.
 */
export function missingPaths(sql: string, known: ReadonlySet<string>): string[] {
	const missing: string[] = [];
	for (const raw of sqlJsonPaths(sql)) {
		const path = normalize(raw);
		if (known.has(path)) continue;
		// If the part after `$` (`.a`, `[*].a`) is the tail of a shape path, treat it as relative
		const tail = path.slice(1);
		if (tail === '' || !(tail.startsWith('.') || tail.startsWith('['))) continue;
		let found = false;
		for (const k of known) {
			if (k.endsWith(tail)) {
				found = true;
				break;
			}
		}
		if (!found) missing.push(raw);
	}
	return missing;
}

/** One factual sentence appended to the response's `warning` */
export function missingPathsWarning(missing: string[]): string {
	const shown = missing.slice(0, MISSING_PATHS_MAX);
	const more = missing.length - shown.length;
	return (
		`No result in the scope has ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}, so ` +
		`${missing.length === 1 ? 'it reads' : 'they read'} as NULL — task_result_describe lists the paths the results have.`
	);
}
