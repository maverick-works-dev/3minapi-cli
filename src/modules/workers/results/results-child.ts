/**
 * Child process that reads saved results — for `worker results query` and the built-in reader worker
 * (docs/design/15_cli.md §8-5, §8-6).
 *
 * A synchronous SQLite query cannot be interrupted — neither a Ctrl+C handler nor `worker.terminate()` runs until it
 * finishes (observed on Node 24.12). So queries run in this process and the parent kills it on timeout. The built-in
 * worker also does `JSON.parse` of large payloads here, so the poller is not blocked.
 *
 * Input (stdin):
 * - `{ op: 'sql', file, sql }` → `{ ok: true, columns, rows }` or `{ ok: false, kind, message }` (CLI — all of data.db)
 * - `{ op: 'reader', root, hostId, file, request }` → ReaderOutcome (remote — scoped views only, this host's results
 *   only, reader.ts)
 *
 * - `readOnly` alone still lets `VACUUM INTO '<path>'` write a file anywhere (observed) — an allow-list authorizer is
 *   set as well
 *
 * ⚠️ The ExperimentalWarning filter is installed before importing sqlite — same order as bin.ts (the only static
 * import is warnings.ts).
 */
import { suppressSqliteExperimentalWarning } from '../../../core/warnings.ts';
import type { ReaderRequest } from './reader-input.ts';

suppressSqliteExperimentalWarning();

const { DatabaseSync, constants } = await import('node:sqlite');

type Message =
	| { op: 'sql'; file: string; sql: string }
	| { op: 'reader'; root: string; hostId: string; file: string; request: ReaderRequest };

/** Reads only — SELECT, READ, FUNCTION, RECURSIVE. Everything else (writes, ATTACH, PRAGMA, transactions, temp DDL) is denied */
const ALLOWED = new Set([
	constants.SQLITE_SELECT,
	constants.SQLITE_READ,
	constants.SQLITE_FUNCTION,
	constants.SQLITE_RECURSIVE
]);

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const msg = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Message;

// reader.ts statically imports node:sqlite via store.ts — load it after the filter
const { replacer, runReader } = await import(
	import.meta.url.endsWith('.ts') ? './reader.ts' : './reader.js'
);

let result: unknown;
if (msg.op === 'sql') {
	try {
		const db = new DatabaseSync(msg.file, { readOnly: true, timeout: 5_000 });
		try {
			db.setAuthorizer((action: number) =>
				ALLOWED.has(action) ? constants.SQLITE_OK : constants.SQLITE_DENY
			);
			const stmt = db.prepare(msg.sql);
			const columns = stmt.columns().map((c) => c.name);
			stmt.setReturnArrays(true);
			const rows = stmt.all();
			result = { ok: true, columns, rows };
		} finally {
			db.close();
		}
	} catch (err) {
		const e = err as { errcode?: number; message?: string };
		const message = e.message ?? String(err);
		const kind =
			e.errcode === 23
				? 'denied'
				: /syntax error|incomplete input/.test(message)
					? 'syntax'
					: 'error';
		result = { ok: false, kind, message };
	}
} else {
	// Read-only — scoped views are TEMP, so a read-only connection can create them (observed on Node 24.12).
	// ⚠️ Unexpected errors (missing table or file, lock timeout, corruption) are caught here too and only the SQLite
	// message is returned — a thrown stack would reach stderr with the CLI install path (user home), and this
	// response goes to the server and the AI
	try {
		const db = new DatabaseSync(msg.file, { readOnly: true, timeout: 5_000 });
		try {
			result = runReader(msg.root, db, constants, msg.request, msg.hostId);
		} finally {
			db.close();
		}
	} catch (err) {
		result = { ok: false, reason: 'query_error', message: (err as Error).message ?? String(err) };
	}
}
process.stdout.write(JSON.stringify(result, replacer));
