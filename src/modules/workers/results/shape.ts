/**
 * Structural summary of a result (`shape`) and its hash (`shape_hash`) — docs/design/15_cli.md §8-5.
 *
 * Computed once on save into `_3minapi_results`; used by substitute results, `worker results describe` and the
 * built-in reader worker. **This is a contract** — bump `v` when the shape format changes.
 *
 * - Paths: `$`, `$.items`, `$.items[*]`, `$.items[*].id`. Array indexes collapse to `[*]`. Non-identifier keys are
 *   `$."a b"` (SQLite JSON path syntax — usable directly in `json_extract`)
 * - Per path: `types` (SQLite `json_type` name → count) and `count` (occurrences). A count below the array's element
 *   count (the `…[*]` count) means an optional field
 * - Numbers get `min`/`max`, arrays `length` min/max, text `values` when few and short, otherwise one `sample`
 * - Past the limits (depth, path count, path length) it stops descending and sets `truncated` — the limits keep the
 *   substitute result within the reply limit
 * - `shape_hash` uses only the sorted "path → type set", independent of counts, values and samples — same structure,
 *   same hash
 *
 * One JS traversal. SQLite `json_tree` could do it but has no regex to collapse array indexes and is slower
 * (observed on a 1.5 MB result: 14 ms vs 102 ms).
 */
import { createHash } from 'node:crypto';
import {
	SHAPE_MAX_DEPTH,
	SHAPE_MAX_PATHS,
	SHAPE_PATH_MAX_CHARS,
	SHAPE_MAX_VALUES,
	SHAPE_VALUE_MAX_CHARS
} from '../../../core/domain/index.ts';

/** Same names as SQLite `json_type` */
export type JsonType = 'object' | 'array' | 'text' | 'integer' | 'real' | 'true' | 'false' | 'null';

export interface PathStat {
	types: Partial<Record<JsonType, number>>;
	count: number;
	min?: number;
	max?: number;
	length?: { min: number; max: number };
	values?: string[];
	sample?: string;
}

export interface Shape {
	v: 1;
	paths: Record<string, PathStat>;
	/** Hit a limit (depth, path count) or trimmed by fitShape — there is more */
	truncated: boolean;
	/** What fitShape dropped — values/samples or paths at or below this depth. Deeper levels matter less */
	omitted?: { samples_from_depth?: number; paths_from_depth?: number };
}

interface Acc {
	stat: PathStat;
	/** null = values given up (too many distinct or too long) */
	values: Set<string> | null;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function computeShape(value: unknown): { shape: Shape; hash: string } {
	const acc = new Map<string, Acc>();
	let truncated = false;

	const visit = (v: unknown, path: string, depth: number): void => {
		let a = acc.get(path);
		if (!a) {
			if (acc.size >= SHAPE_MAX_PATHS || path.length > SHAPE_PATH_MAX_CHARS) {
				truncated = true;
				return;
			}
			a = { stat: { types: {}, count: 0 }, values: new Set() };
			acc.set(path, a);
		}
		const { stat } = a;
		const type = jsonType(v);
		stat.types[type] = (stat.types[type] ?? 0) + 1;
		stat.count++;

		switch (type) {
			case 'integer':
			case 'real': {
				const n = v as number;
				stat.min = stat.min === undefined ? n : Math.min(stat.min, n);
				stat.max = stat.max === undefined ? n : Math.max(stat.max, n);
				return;
			}
			case 'text': {
				const t = v as string;
				if (a.values && (t.length > SHAPE_VALUE_MAX_CHARS || a.values.size >= SHAPE_MAX_VALUES)) {
					if (!a.values.has(t)) {
						// Give up — the sample is the first value seen
						stat.sample = (a.values.values().next().value ?? t).slice(0, SHAPE_VALUE_MAX_CHARS);
						a.values = null;
					}
				}
				if (a.values) a.values.add(t);
				else stat.sample ??= t.slice(0, SHAPE_VALUE_MAX_CHARS);
				return;
			}
			case 'array': {
				const arr = v as unknown[];
				stat.length = stat.length
					? {
							min: Math.min(stat.length.min, arr.length),
							max: Math.max(stat.length.max, arr.length)
						}
					: { min: arr.length, max: arr.length };
				if (depth >= SHAPE_MAX_DEPTH) {
					if (arr.length > 0) truncated = true;
					return;
				}
				for (const item of arr) visit(item, `${path}[*]`, depth + 1);
				return;
			}
			case 'object': {
				const entries = Object.entries(v as Record<string, unknown>);
				if (depth >= SHAPE_MAX_DEPTH) {
					if (entries.length > 0) truncated = true;
					return;
				}
				for (const [key, child] of entries) visit(child, childPath(path, key), depth + 1);
				return;
			}
			default:
				return;
		}
	};
	visit(value, '$', 0);

	const paths: Record<string, PathStat> = {};
	for (const [path, a] of acc) {
		// Omit empty values for paths with no text. If text values were given up, only sample remains
		if (a.values && a.values.size > 0) {
			a.stat.values = [...a.values].sort();
			delete a.stat.sample;
		}
		paths[path] = a.stat;
	}
	const shape: Shape = { v: 1, paths, truncated };
	return { shape, hash: shapeHash(shape) };
}

/**
 * Merges several saved shapes with the same `shape_hash` into one — the reference shape for `describe --worker`.
 * Pass them **oldest first**. `count` and `types` add up (so "below the parent count = optional" still holds),
 * `min`/`max`/`length` widen, and `values` union — falling back to `sample` (first value seen) past
 * SHAPE_MAX_VALUES or when either side already has `sample` (same rule as computeShape)
 */
export class ShapeMerger {
	private readonly acc = new Map<string, Acc>();
	private truncated = false;

	add(shape: Shape): void {
		if (shape.truncated) this.truncated = true;
		for (const [path, s] of Object.entries(shape.paths)) {
			let a = this.acc.get(path);
			if (!a) {
				a = { stat: { types: {}, count: 0 }, values: new Set() };
				this.acc.set(path, a);
			}
			const { stat } = a;
			for (const [type, n] of Object.entries(s.types) as [JsonType, number][]) {
				stat.types[type] = (stat.types[type] ?? 0) + n;
			}
			stat.count += s.count;
			if (s.min !== undefined)
				stat.min = stat.min === undefined ? s.min : Math.min(stat.min, s.min);
			if (s.max !== undefined)
				stat.max = stat.max === undefined ? s.max : Math.max(stat.max, s.max);
			if (s.length) {
				stat.length = stat.length
					? {
							min: Math.min(stat.length.min, s.length.min),
							max: Math.max(stat.length.max, s.length.max)
						}
					: { ...s.length };
			}
			if (!a.values) continue; // Already fell back to sample
			const first: string | undefined = a.values.values().next().value ?? s.values?.[0] ?? s.sample;
			if (s.sample !== undefined) {
				stat.sample = first;
				a.values = null;
				continue;
			}
			for (const v of s.values ?? []) a.values.add(v);
			if (a.values.size > SHAPE_MAX_VALUES) {
				stat.sample = first;
				a.values = null;
			}
		}
	}

	result(): Shape {
		const paths: Record<string, PathStat> = {};
		for (const [path, a] of this.acc) {
			if (a.values && a.values.size > 0) a.stat.values = [...a.values].sort();
			paths[path] = a.stat;
		}
		return { v: 1, paths, truncated: this.truncated };
	}
}

/**
 * Fits a size budget — **importance = depth**, so it trims one level at a time from the deepest (that level's
 * values/samples, then its paths). `fits` measures **the full JSON the caller will send** (envelope included). The
 * last step is a fixed-size shape with no paths, so it always terminates. The hash is left unchanged.
 */
export function fitShape(shape: Shape, fits: (s: Shape) => boolean): Shape {
	if (fits(shape)) return shape;
	const entries = Object.entries(shape.paths).map(([p, stat]) => ({
		p,
		stat,
		depth: pathDepth(p)
	}));
	const maxDepth = Math.max(0, ...entries.map((e) => e.depth));
	const build = (samplesFrom: number, pathsFrom: number): Shape => ({
		v: 1,
		paths: Object.fromEntries(
			entries
				.filter((e) => e.depth < pathsFrom)
				.map(({ p, stat, depth }) => {
					if (depth < samplesFrom) return [p, stat];
					const { values: _values, sample: _sample, ...rest } = stat;
					return [p, rest];
				})
		),
		truncated: true,
		omitted: {
			...(samplesFrom <= maxDepth ? { samples_from_depth: samplesFrom } : {}),
			...(pathsFrom <= maxDepth ? { paths_from_depth: pathsFrom } : {})
		}
	});
	let pathsFrom = maxDepth + 1;
	for (let d = maxDepth; d >= 0; d--) {
		const stripped = build(d, pathsFrom);
		if (fits(stripped)) return stripped;
		pathsFrom = d;
		const dropped = build(d, pathsFrom);
		if (fits(dropped)) return dropped;
	}
	return {
		v: 1,
		paths: {},
		truncated: true,
		omitted: { samples_from_depth: 0, paths_from_depth: 0 }
	};
}

/** `$` = 0, +1 per `.key`, `."k"` or `[*]` */
export function pathDepth(path: string): number {
	return (path.match(/\[\*\]|\.(?:"(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_]*)/g) ?? []).length;
}

/** Sorted "path → type set" only — independent of counts and values */
export function shapeHash(shape: Shape): string {
	const canonical = Object.keys(shape.paths)
		.sort()
		.map((p) => `${p}=${Object.keys(shape.paths[p].types).sort().join('|')}`)
		.join('\n');
	return createHash('sha256').update(`v${shape.v}\n${canonical}`).digest('hex').slice(0, 16);
}

/** Path under one object key — non-identifiers are quoted as JSON strings (SQLite JSON path syntax), as read's guidance uses */
export function childPath(parent: string, key: string): string {
	return IDENT.test(key) ? `${parent}.${key}` : `${parent}.${JSON.stringify(key)}`;
}

function jsonType(v: unknown): JsonType {
	if (v === null) return 'null';
	if (Array.isArray(v)) return 'array';
	switch (typeof v) {
		case 'string':
			return 'text';
		case 'number':
			return Number.isInteger(v) ? 'integer' : 'real';
		case 'boolean':
			return v ? 'true' : 'false';
		default:
			return 'object';
	}
}
