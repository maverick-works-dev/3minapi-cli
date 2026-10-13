/**
 * Substitute result — the `result` sent in place of a local worker result over the reply limit (100 KiB)
 * (docs/design/15_cli.md §8-5).
 *
 * The original stays in data.db on this PC; the AI learns what it holds from a structural summary (`shape`). It is
 * wrapped in the reserved key `_3minapi` so it cannot be confused with a worker's own result — which is why a
 * top-level `_3minapi` in a worker result is rejected (task-runner.ts). When this host's built-in reader worker is
 * active, `reader` carries its name as the signal that a remote AI can query the original (docs/design/15_cli.md §8-6).
 *
 * ⚠️ Never carries paths or file names — it goes to the server and the AI and would expose the OS user name.
 */
import { RESULT_RESERVED_KEY, SUBSTITUTE_MAX_BYTES } from '../../../core/domain/index.ts';
import { formatCount } from '../../../core/text.ts';
import { fitShape, type Shape } from './shape.ts';

/**
 * With `reader` — a remote AI queries the original with the MCP result tools, which hand the work to the built-in
 * reader worker. Paths (shape, or describe for omitted levels) come before query because the order reads as
 * instructions; it matches help(tasks) "Reading a large result". Names the tools, never the reader or its input: the
 * server rejects a task created for the reader directly (#1537)
 */
export const SUBSTITUTE_READ =
	"The full result is too large to send and is stored on the user's PC. Do not present this summary as the result. " +
	'`shape` summarizes its structure: the paths it has, with types, counts and sample values — an overview; ' +
	'deeper levels may be left out (`omitted`), and task_result_describe with this task_id returns them. ' +
	'Compute the answer over those paths with task_result_query for this task_id and SQL over the view `results` — ' +
	'help(tasks) explains the view and examples.';

/** Without a built-in reader worker (not registered in this run) — only the person at the PC can read it */
export const SUBSTITUTE_READ_LOCAL_ONLY =
	"The full result is too large to send and is stored on the user's PC. The user can see it with " +
	"'3minapi worker results show <task_id>' or query it with '3minapi worker results query'. " +
	'`shape` summarizes its structure: paths, types, counts and sample values — an overview; deeper ' +
	'levels may be left out (`omitted`).';

export interface SubstituteInput {
	taskId: string;
	worker: string;
	bytes: number;
	shape: Shape;
	shapeHash: string;
	/** This host's built-in reader worker name — only when active */
	reader?: string | null;
}

/**
 * The value placed in the result slot. It enters the AI context automatically, so it is capped at an overview
 * (SUBSTITUTE_MAX_BYTES), trimming the deepest levels first (fitShape). `describe` shows the full shape up to the
 * reply budget.
 */
export function substituteResult(input: SubstituteInput): Record<string, unknown> {
	const build = (shape: Shape) => ({
		[RESULT_RESERVED_KEY]: {
			stored_locally: true,
			task_id: input.taskId,
			worker: input.worker,
			bytes: input.bytes,
			shape_hash: input.shapeHash,
			shape,
			...(input.reader ? { reader: input.reader } : {}),
			read: input.reader ? SUBSTITUTE_READ : SUBSTITUTE_READ_LOCAL_ONLY
		}
	});
	return build(
		fitShape(
			input.shape,
			(s) => Buffer.byteLength(JSON.stringify(build(s))) <= SUBSTITUTE_MAX_BYTES
		)
	);
}

export function substituteStatusMessage(bytes: number): string {
	return `result stored on the user's PC (${formatCount(bytes)} bytes)`;
}
