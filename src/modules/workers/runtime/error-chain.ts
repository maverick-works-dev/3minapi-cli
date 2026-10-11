/**
 * Flattens an error's cause chain (`cause`, `AggregateError.errors`) (docs/design/15_cli.md §8-2).
 *
 * Node `fetch` throws only `TypeError: fetch failed` and keeps the real cause (ETIMEDOUT, ENOTFOUND, certificate
 * errors) in `cause`. V8's `err.stack` omits causes, so message and stack alone hide the cause (observed on Windows).
 *
 * - Errors without a cause keep their message and stack unchanged — nothing is added at the top level
 * - A cause can be any value (string, object, null) — it is stringified briefly, never thrown
 * - Depth cap, cycle guard and AggregateError item cap — the same defenses as util.inspect
 *
 * ⚠️ Imported by thread.ts — must not import node:sqlite or the logger.
 */

/** How deep to follow causes */
const MAX_DEPTH = 5;
/** AggregateError items shown — the rest become "and N more" */
const MAX_AGGREGATE_ITEMS = 3;
/** Cap when stringifying a non-Error cause */
const NON_ERROR_MAX_CHARS = 200;

/** Chain separator — "fetch failed ← connect ETIMEDOUT 1.2.3.4:443" */
const CHAIN = ' ← ';

type Errorish = Error & { code?: unknown; errors?: unknown; cause?: unknown };

/**
 * One line for replies and logs — `fetch failed ← connect ETIMEDOUT 1.2.3.4:443; connect ENETUNREACH …`.
 * Without a cause, the plain string (`message || name`, or `String(err)` for non-Errors)
 */
export function errorMessage(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	const head = err.message || err.name;
	const inner = describeCauses(err as Errorish, 1, new Set<unknown>([err]));
	return join(head, inner);
}

/** For local logs — the top stack, then `Caused by: <stack>` per cause. Without a cause, `err.stack` as is */
export function errorStack(err: unknown): string | undefined {
	if (!(err instanceof Error)) return undefined;
	const lines = [err.stack ?? errorMessage(err)];
	const seen = new Set<unknown>([err]);
	const walk = (e: Errorish, depth: number) => {
		if (depth > MAX_DEPTH) return;
		for (const c of causesOf(e)) {
			if (seen.has(c)) continue;
			if (typeof c === 'object' && c !== null) seen.add(c);
			lines.push(`Caused by: ${c instanceof Error ? (c.stack ?? c.message) : nonError(c)}`);
			if (c instanceof Error) walk(c as Errorish, depth + 1);
		}
	};
	walk(err as Errorish, 1);
	return lines.join('\n');
}

/**
 * Home directory → `~`, so text sent to the server and the AI does not carry the OS user name.
 * Replaces only at path boundaries: with home `/home/al`, `/home/alice` stays (not `~ice`)
 */
export function withoutHome(message: string, home: string): string {
	// A root (`/`) or empty home would mangle the text
	if (home.length < 3) return message;
	const forms = [...new Set([home, home.replaceAll('\\', '/')])];
	const pattern = forms.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
	// Only when followed by a path separator, quote, space, colon, paren, comma/semicolon or end of text
	return message.replace(new RegExp(`(?:${pattern})(?=[\\\\/'"\`\\s:),;]|$)`, 'g'), '~');
}

/** Causes — AggregateError items, then `cause` */
function causesOf(e: Errorish): unknown[] {
	const list: unknown[] = [];
	if (Array.isArray(e.errors)) list.push(...e.errors);
	if ('cause' in e && e.cause !== undefined) list.push(e.cause);
	return list;
}

function describeCauses(e: Errorish, depth: number, seen: Set<unknown>): string {
	if (depth > MAX_DEPTH) return '';
	const parts: string[] = [];

	if (Array.isArray(e.errors) && e.errors.length > 0) {
		const items = e.errors
			.slice(0, MAX_AGGREGATE_ITEMS)
			.map((x) => describe(x, depth, seen))
			.filter((s) => s !== '');
		const more = e.errors.length - MAX_AGGREGATE_ITEMS;
		if (more > 0) items.push(`and ${more} more`);
		if (items.length > 0) parts.push(items.join('; '));
	}
	if ('cause' in e && e.cause !== undefined) {
		const c = describe(e.cause, depth, seen);
		if (c !== '') parts.push(c);
	}
	return parts.join(CHAIN);
}

/** One cause — its own message (+code), then its causes */
function describe(value: unknown, depth: number, seen: Set<unknown>): string {
	if (typeof value === 'object' && value !== null) {
		if (seen.has(value)) return '';
		seen.add(value);
	}
	if (!(value instanceof Error)) return nonError(value);

	const e = value as Errorish;
	// Node's AggregateError has an empty message and only a code — its items repeat the same code
	const aggregate = Array.isArray(e.errors) && e.errors.length > 0;
	const message = e.message || (aggregate ? '' : e.name);
	const code = typeof e.code === 'string' && !message.includes(e.code) ? e.code : null;
	const head = aggregate && !message ? '' : code ? `${message} (${code})` : message;

	return join(head, describeCauses(e, depth + 1, seen));
}

/** Own message + causes. An immediately repeated message (undici often wraps) appears once */
function join(head: string, inner: string): string {
	if (!head) return inner;
	if (!inner) return head;
	if (inner === head || inner.startsWith(`${head}${CHAIN}`)) return inner;
	return `${head}${CHAIN}${inner}`;
}

function nonError(value: unknown): string {
	let text: string;
	if (typeof value === 'string') text = value;
	else if (value === null || typeof value !== 'object') text = String(value);
	else {
		try {
			text = JSON.stringify(value) ?? String(value);
		} catch {
			text = Object.prototype.toString.call(value);
		}
	}
	return text.length > NON_ERROR_MAX_CHARS ? `${text.slice(0, NON_ERROR_MAX_CHARS)}…` : text;
}
