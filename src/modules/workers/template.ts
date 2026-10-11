/**
 * Worker file template for 'worker new' — also the worker-shape text 'guide' prints, so both stay identical.
 * The runtime defines the shape (description, timeoutMs, inputSchema, handler, ctx) — docs/design/15_cli.md §8-1.
 * Update this when it changes.
 */
const HEADER = (
	name: string
) => `// Worker "${name}" — runs on this machine as a local worker when an AI creates a task for it.
// One file = one worker. The file name is the worker name.
// Code edits take effect on the next task. A renamed file or a changed description
// reaches 3Min API on '3minapi reload' (or the next '3minapi start').`;

export const SETTINGS = `/**
 * What this worker does (max 500 characters). This is the only thing the AI sees
 * about the worker: it decides when to call it and what input to send from this text.
 * To tell the AI the input shape, write it here (inputSchema below is not sent).
 * EXAMPLE — describe your own worker.
 */
export const description = 'Echo back the message it receives. input: { message: string }';

/** Optional. The run is stopped and reported as failed after this long (default 60s). */
export const timeoutMs = 60_000;

/**
 * Optional. JSON Schema for the task input — an EXAMPLE matching the handler below.
 * Replace it with your own fields, or delete it to accept any input.
 * Checked on this machine only: it is not sent to 3Min API, so the AI does not see it.
 * A task whose input does not match is reported as failed before the handler runs.
 * Supported keywords: type, properties, required, enum, items.
 */
export const inputSchema = {
	type: 'object',
	properties: {
		message: { type: 'string', description: 'Text to echo' } // example field
	},
	required: ['message']
};`;

export const HANDLER_DOC = `/**
 * Runs once per task.
 *
 * input — the JSON the AI sent with the task (any shape, up to 100 KB).
 *
 * How the task ends:
 *   return value      → completed; the value becomes the result (JSON). Every result
 *                       is saved in the project's data.db ('3minapi worker results').
 *                       Over 100 KB: a local worker sends the AI a summary instead;
 *                       a public worker's task fails. A top-level "_3minapi" key is
 *                       reserved — the task fails.
 *   throw new Error() → failed; only the message is sent to the AI, with its causes
 *                       (err.cause) on the same line, cut at 4,000 characters. The
 *                       stack trace stays in the local log.
 *   timeoutMs passed  → failed
 *   cancelled         → set by the requester, not by the worker. ctx.signal fires:
 *                       stop work and return. The return value is ignored.
 *
 * ctx:
 *   ctx.log(msg)        write to this worker's log ('3minapi worker logs <name>')
 *   await ctx.report(m) send a progress message to the AI while working
 *                       (max 256 characters; each report counts as one API call)
 *   ctx.signal          AbortSignal — aborted on cancel or timeout
 *   ctx.env             environment variables, including the project's .env
 *                       (THREEMINAPI_* variables are removed)
 *
 * Need to keep data between tasks? Use the project's data.db (made by '3minapi init').
 * 3minapi saves results there in tables starting with _3minapi_ — read them if you
 * like, but do not write them. Open it with Node's built-in node:sqlite:
 *   import { DatabaseSync } from 'node:sqlite';
 *   const db = new DatabaseSync(new URL('../data.db', import.meta.url), { timeout: 5000 });
 *   db.exec('PRAGMA journal_mode = WAL'); // tasks can run at the same time
 *   try { ... } finally { db.close(); }
 * The URL is relative to this file (default workers/ folder), so it does not depend on
 * the current folder.
 */`;

const HANDLER_BODY = `	ctx.log(\`received: \${input.message}\`);

	// await ctx.report('halfway there');
	// if (!input.message.trim()) throw new Error('message is empty');

	return { echo: input.message };
}
`;

export function jsTemplate(name: string): string {
	return `${HEADER(name)}

${SETTINGS}

${HANDLER_DOC}
export async function handler(input, ctx) {
${HANDLER_BODY}`;
}

export function tsTemplate(name: string): string {
	return `${HEADER(name)}
// TypeScript runs without a build step (Node type stripping): use plain type
// annotations, not enums or namespaces. Types are not checked at run time.

interface Context {
	log(message: string): void;
	report(message: string): Promise<void>;
	signal: AbortSignal;
	env: Record<string, string | undefined>;
}

${SETTINGS}

${HANDLER_DOC}
export async function handler(input: any, ctx: Context) {
${HANDLER_BODY}`;
}
