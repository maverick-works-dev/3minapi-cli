/**
 * Worker thread entry — runs one task and exits (docs/design/15_cli.md §3).
 *
 * Each task runs this file in a fresh Worker. Module caches are per thread, so edits to a worker file apply from the
 * next task without a restart. Worker code that breaks this thread cannot take down the CLI process.
 *
 * ⚠️ This file must not import node:sqlite or the logger — only the parent thread records state.
 */
import { realpathSync } from 'node:fs';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { errorMessage, errorStack, withoutHome } from './error-chain.ts';
import type { FailureReason, FromThread, ThreadInput, ToThread } from './protocol.ts';
import { validate } from './schema.ts';

const port = parentPort!;
const { file, input, inspect, connectAttemptTimeoutMs } = workerData as ThreadInput;

// net defaults are per thread (isolate) — use the value the parent set (core/network.ts)
if (connectAttemptTimeoutMs !== undefined)
	setDefaultAutoSelectFamilyAttemptTimeout(connectAttemptTimeoutMs);
const controller = new AbortController();
const pendingReports = new Map<number, () => void>();
let nextReportId = 1;

function post(msg: FromThread): void {
	port.postMessage(msg);
}

port.on('message', (msg: ToThread) => {
	if (msg.type === 'cancel') controller.abort(new Error('task cancelled'));
	else if (msg.type === 'report-ack') {
		pendingReports.get(msg.id)?.();
		pendingReports.delete(msg.id);
	}
});

const ctx = Object.freeze({
	log(message: unknown): void {
		post({ type: 'log', message: String(message) });
	},
	/** Sent to the server as status_message (truncated at 256 chars). Resolves once sent; never rejects */
	report(message: unknown): Promise<void> {
		const id = nextReportId++;
		return new Promise<void>((resolve) => {
			pendingReports.set(id, resolve);
			post({ type: 'report', id, message: String(message) });
		});
	},
	signal: controller.signal,
	env: process.env
});

/**
 * Replaces the file's path (including file URLs) in text with its file name. The real path too — under a symlink
 * (macOS `/var` → `/private/var`) `import.meta.filename` and stacks carry the real path. Longest first, so a short
 * path never cuts into a longer one
 */
function withoutPath(message: string, file: string): string {
	let real = file;
	try {
		real = realpathSync(file);
	} catch {
		// The file is gone — replace only the given path
	}
	const forms = [...new Set([real, file].flatMap((p) => [pathToFileURL(p).href, p]))].sort(
		(a, b) => b.length - a.length
	);
	let out = message;
	for (const form of forms) out = out.split(form).join(path.basename(file));
	return out;
}

function fail(reason: FailureReason, message: string, stack?: string): void {
	post({ type: 'fail', reason, message, stack });
}

async function main(): Promise<void> {
	let mod: Record<string, unknown>;
	try {
		mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (
			e?.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' ||
			e?.code === 'ERR_INVALID_TYPESCRIPT_SYNTAX'
		) {
			return fail(
				'unsupported_syntax',
				`${e.message.split('\n')[0]} — this TypeScript syntax cannot run without a build step. ` +
					'Use plain type annotations: replace enums with const objects and avoid namespaces and constructor parameter properties, or write the worker in JavaScript.'
			);
		}
		// Goes to the server and the AI — keep only the file name; import errors also contain absolute paths and file URLs (#1410)
		return fail(
			'invalid_worker',
			`cannot load ${path.basename(file)}: ${withoutPath(e?.message ?? String(err), file)}`
		);
	}

	const handler = mod.handler;
	if (typeof handler !== 'function') {
		return fail(
			'invalid_worker',
			`${path.basename(file)} must export an async function named "handler"`
		);
	}
	const raw = mod.timeoutMs;
	const timeoutMs = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
	if (inspect) {
		const description = mod.description;
		return post({
			type: 'meta',
			meta: {
				description: typeof description === 'string' ? description : null,
				timeoutMs,
				hasInputSchema: typeof mod.inputSchema === 'object' && mod.inputSchema !== null
			}
		});
	}
	post({ type: 'loaded', timeoutMs });

	const invalid = validate(mod.inputSchema, input);
	if (invalid)
		return fail('invalid_input', `input does not match the worker's inputSchema — ${invalid}`);

	let result: unknown;
	try {
		result = await handler(input, ctx);
	} catch (err) {
		// Include the cause chain on one line — `fetch failed` alone hides the cause. This goes to the server and the
		// AI, so the worker file path and home path are removed (causes may hold local paths). Stacks stay local
		const message = withoutHome(withoutPath(errorMessage(err), file), homedir());
		return fail('handler_error', message, errorStack(err));
	}

	let json: string | undefined;
	try {
		// undefined is sent as null — a completed task must carry a result (docs/design/13_task.md §5)
		json = JSON.stringify(result ?? null);
	} catch (err) {
		return fail(
			'handler_error',
			`the handler's return value is not JSON-serializable: ${(err as Error).message}`
		);
	}
	post({ type: 'done', json: json ?? 'null' });
}

await main();
