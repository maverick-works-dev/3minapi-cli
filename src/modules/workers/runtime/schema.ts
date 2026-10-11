/**
 * Worker `input` schema validation — a small subset of JSON Schema (docs/design/15_cli.md §3).
 *
 *   type (string or array) · properties · required · enum · items
 *
 * Other keywords are ignored (pass). Hand-written instead of ajv to keep zero runtime dependencies — the goal is to
 * tell an AI why its input is malformed before running, not to be a complete validator.
 */

type JsonType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

interface Schema {
	type?: JsonType | JsonType[];
	properties?: Record<string, unknown>;
	required?: unknown;
	enum?: unknown;
	items?: unknown;
}

/** null when valid, else the first reason (`input.message: expected string`) */
export function validate(schema: unknown, value: unknown, at = 'input'): string | null {
	if (!isObject(schema)) return null;
	const s = schema as Schema;

	if (s.type !== undefined) {
		const types = Array.isArray(s.type) ? s.type : [s.type];
		if (!types.some((t) => matchesType(t, value))) {
			return `${at}: expected ${types.join(' or ')}, got ${typeOf(value)}`;
		}
	}
	if (Array.isArray(s.enum) && !s.enum.some((option) => deepEqual(option, value))) {
		return `${at}: must be one of ${s.enum.map((v) => JSON.stringify(v)).join(', ')}`;
	}
	if (isObject(value)) {
		const obj = value as Record<string, unknown>;
		if (Array.isArray(s.required)) {
			for (const key of s.required) {
				if (typeof key === 'string' && !(key in obj)) return `${at}.${key}: required`;
			}
		}
		if (isObject(s.properties)) {
			for (const [key, sub] of Object.entries(s.properties!)) {
				if (!(key in obj)) continue;
				const reason = validate(sub, obj[key], `${at}.${key}`);
				if (reason) return reason;
			}
		}
	}
	if (Array.isArray(value) && isObject(s.items)) {
		for (let i = 0; i < value.length; i++) {
			const reason = validate(s.items, value[i], `${at}[${i}]`);
			if (reason) return reason;
		}
	}
	return null;
}

function matchesType(type: JsonType, value: unknown): boolean {
	switch (type) {
		case 'object':
			return isObject(value);
		case 'array':
			return Array.isArray(value);
		case 'string':
			return typeof value === 'string';
		case 'number':
			return typeof value === 'number' && Number.isFinite(value);
		case 'integer':
			return Number.isInteger(value);
		case 'boolean':
			return typeof value === 'boolean';
		case 'null':
			return value === null;
		default:
			// Unknown type values are not rejected
			return true;
	}
}

function typeOf(value: unknown): string {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'array';
	if (Number.isInteger(value)) return 'integer';
	return typeof value;
}

function isObject(value: unknown): boolean {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const ka = Object.keys(a);
	const kb = Object.keys(b);
	if (ka.length !== kb.length) return false;
	return ka.every((k) =>
		deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
	);
}
