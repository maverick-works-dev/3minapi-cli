/**
 * Secret redaction — every value written to logs or the control DB (`last_error`) passes through here (docs/design/15_cli.md §7-4).
 *
 * ⚠️ Truncate **after** redacting. Truncating first leaves a half-cut token that no pattern matches.
 */
import { truncate } from './text.ts';

export const REDACTED = '<redacted>';

/** Values of fields with these names (case-insensitive, substring match) are redacted whole */
const SECRET_KEY =
	/authorization|token|secret|password|passwd|api[-_]?key|signature|cookie|credential/i;

/** Values found and redacted inside strings */
const SECRET_VALUES: RegExp[] = [
	// 3Min API keys — tm_host_ / tm_live_ / tm_test_ / tm_mcp_ / tm_task_ + hex, regardless of preceding characters
	// (`key=tm_host_…`, `xxtm_host_…`) — a word boundary (\b) would miss attached tokens
	/tm_(?:host|live|test|mcp|task)_[0-9a-f]{8,}/gi,
	// Standard Webhooks signing secret
	/whsec_[A-Za-z0-9+/=]{8,}/g,
	// Authorization header value
	/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g
];

/**
 * Values caught by context — the name is kept, only the value is redacted. A bare 64-digit hex is not matched (false positives on sha256 etc.)
 * - `token=<value>`: a dashboard link (`/?token=…`) inside a message or URL
 * - `<name>=<value>` where the name ends in SECRET, _KEY, TOKEN or PASSWORD: worker secrets without `whsec_`, `.env` lines inside error messages
 */
const SECRET_ASSIGNMENTS: RegExp[] = [
	/(\btoken=)[^\s&#"']{8,}/gi,
	/(\b[A-Za-z0-9_]*(?:SECRET|_KEY|TOKEN|PASSWORD)\s*=\s*)["']?[^\s"'&]{8,}["']?/gi
];

export function redactString(value: string): string {
	let out = value;
	for (const pattern of SECRET_ASSIGNMENTS) out = out.replace(pattern, `$1${REDACTED}`);
	for (const pattern of SECRET_VALUES) {
		out = out.replace(pattern, (match, scheme?: string) =>
			typeof scheme === 'string' && /^(Bearer|Basic)$/.test(scheme)
				? `${scheme} ${REDACTED}`
				: REDACTED
		);
	}
	return out;
}

/** Deep-copies objects and arrays while redacting. Circular references become `[circular]` */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
	if (typeof value === 'string') return redactString(value);
	if (value === null || typeof value !== 'object') return value;
	if (seen.has(value)) return '[circular]';
	seen.add(value);
	if (value instanceof Error) {
		return { name: value.name, message: redactString(value.message) };
	}
	if (Array.isArray(value)) return value.map((v) => redact(v, seen));
	const out: Record<string, unknown> = {};
	for (const [key, v] of Object.entries(value)) {
		out[key] = SECRET_KEY.test(key) && v !== null && v !== undefined ? REDACTED : redact(v, seen);
	}
	return out;
}

/** Redacts, then truncates */
export function redactAndTruncate(value: string, maxChars: number): string {
	return truncate(redactString(value), maxChars);
}
