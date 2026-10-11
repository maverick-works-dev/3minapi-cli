/**
 * Output contract — docs/design/15_cli.md §4.
 *
 * - stdout: command results only. With `--json`, exactly one JSON value (for pipes, jq). Exception: `logs --json` is JSON Lines
 * - stderr: progress, warnings, errors. Human-readable text goes here even with `--json`
 * - Color: --color/--no-color flag > NO_COLOR (off if non-empty) > FORCE_COLOR > TERM=dumb > whether a TTY
 */
import type { OutputPort, Paint, Style } from './domain/index.ts';

export interface ColorInput {
	flag: boolean | undefined;
	env: NodeJS.ProcessEnv;
	isTTY: boolean;
}

export function shouldUseColor({ flag, env, isTTY }: ColorInput): boolean {
	if (flag !== undefined) return flag;
	if (env.NO_COLOR) return false;
	if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '') return env.FORCE_COLOR !== '0';
	if (env.TERM === 'dumb') return false;
	return isTTY;
}

export interface Stream {
	write(chunk: string): unknown;
	isTTY?: boolean;
}

function style(enabled: boolean): Style {
	const sgr = (open: number, close: number): Paint =>
		enabled ? (t) => `\x1b[${open}m${t}\x1b[${close}m` : (t) => t;
	return {
		bold: sgr(1, 22),
		dim: sgr(2, 22),
		red: sgr(31, 39),
		yellow: sgr(33, 39),
		green: sgr(32, 39)
	};
}

export interface OutputOptions {
	stdout: Stream;
	stderr: Stream;
	env: NodeJS.ProcessEnv;
	json: boolean;
	color: boolean | undefined;
}

export class Output implements OutputPort {
	readonly json: boolean;
	/** Styles for stdout */
	readonly out: Style;
	/** Styles for stderr — the two streams can differ in TTY-ness (`3minapi doctor | cat`) */
	readonly err: Style;
	private readonly stdout: Stream;
	private readonly stderr: Stream;
	/** Whether anything was written to stdout — the `--json` error document is written only to an empty stdout (one document) */
	private wrote = false;

	constructor(opts: OutputOptions) {
		this.json = opts.json;
		this.stdout = opts.stdout;
		this.stderr = opts.stderr;
		const color = (s: Stream) =>
			shouldUseColor({ flag: opts.color, env: opts.env, isTTY: s.isTTY === true });
		this.out = style(!opts.json && color(opts.stdout));
		this.err = style(color(opts.stderr));
	}

	/**
	 * A command result. With `--json`, writes data as JSON; otherwise writes text to stdout.
	 * Without text, human output is skipped too.
	 */
	result(data: unknown, text?: string): void {
		if (this.json) {
			this.writeOut(JSON.stringify(data, null, 2) + '\n');
		} else if (text !== undefined) {
			this.writeOut(text.endsWith('\n') ? text : text + '\n');
		}
	}

	/** Human text to stdout — when the result itself is text, like help */
	print(text: string): void {
		this.writeOut(text.endsWith('\n') ? text : text + '\n');
	}

	/**
	 * With `--json`, writes the error document to stdout — skipped if stdout already has output (the stderr message and exit code suffice).
	 * Does nothing without `--json`
	 */
	errorResult(doc: unknown): void {
		if (this.json && !this.wrote) this.writeOut(JSON.stringify(doc, null, 2) + '\n');
	}

	private writeOut(text: string): void {
		this.wrote = true;
		this.stdout.write(text);
	}

	/** To stderr without a newline — input prompts */
	prompt(text: string): void {
		this.stderr.write(text);
	}

	info(message: string): void {
		this.stderr.write(message + '\n');
	}

	warn(message: string): void {
		this.stderr.write(`${this.err.yellow('warning:')} ${message}\n`);
	}

	error(message: string): void {
		this.stderr.write(`${this.err.red('error:')} ${message}\n`);
	}
}
