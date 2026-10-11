/**
 * Secret input — a prompt (echoes `*` per character) or all of stdin.
 *
 * Echo is suppressed by reading keys in raw mode, not by muting readline output (overriding `_writeToOutput`, a private API).
 * In raw mode Ctrl+C does not raise SIGINT, so it is handled here (tty docs).
 *
 * ⚠️ In raw mode the terminal's escape sequences arrive as is. Pastes in particular may be wrapped in
 * `ESC[200~ … ESC[201~` (bracketed paste) depending on the terminal, so any sequence starting with ESC is dropped whole.
 * Arrow keys, Home, etc. are ignored for the same reason.
 */
import { CliError, ExitCode, type InputStream, type OutputPort } from './domain/index.ts';

const MASK = '*';

export async function readSecret(
	stdin: InputStream,
	out: OutputPort,
	label: string
): Promise<string> {
	if (!stdin.isTTY || !stdin.setRawMode || !stdin.on || !stdin.off) {
		throw new CliError('no terminal to prompt on. Pipe the token in with --with-token.');
	}
	const on = stdin.on.bind(stdin);
	const off = stdin.off.bind(stdin);
	out.prompt(label);
	const listeners: [string, (arg: any) => void][] = [];
	try {
		stdin.setRawMode(true);
		stdin.setEncoding?.('utf8');
		stdin.resume?.();
		return await new Promise<string>((resolve, reject) => {
			let value = '';
			const skip = new EscapeSkipper();
			const onData = (chunk: string | Uint8Array) => {
				const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
				for (const ch of text) {
					if (skip.consume(ch)) continue;
					if (ch === '\r' || ch === '\n' || ch === '\u0004') return resolve(value);
					if (ch === '\u0003') return reject(new CliError('cancelled', ExitCode.Interrupted));
					if (ch === '\u007f' || ch === '\b') {
						if (value !== '') {
							value = value.slice(0, -1);
							out.prompt('\b \b');
						}
					} else if (ch === '\u0015') {
						// Ctrl+U — clears the input so far
						out.prompt('\b \b'.repeat(value.length));
						value = '';
					} else if (ch >= ' ') {
						value += ch;
						out.prompt(MASK);
					}
				}
			};
			// Do not wait forever if the terminal closes or stdin breaks
			const onEnd = () => reject(new CliError('input closed before the token was entered'));
			const onError = (err: Error) => reject(new CliError(`cannot read input: ${err.message}`));
			listeners.push(['data', onData], ['end', onEnd], ['error', onError]);
			for (const [event, listener] of listeners) on(event, listener);
		});
	} finally {
		for (const [event, listener] of listeners) off(event, listener);
		stdin.setRawMode(false);
		stdin.pause?.();
		out.prompt('\n');
	}
}

/**
 * Skips sequences starting with ESC. Keeps state across chunk boundaries.
 *   CSI    ESC [ <parameter/intermediate bytes> <final byte 0x40–0x7E>  — paste markers, arrows, etc.
 *   SS3    ESC O <one char>                                          — F1–F4 and arrows on some terminals
 *   other  ESC <one char>                                            — Alt+key
 */
class EscapeSkipper {
	private state: 'none' | 'esc' | 'csi' | 'ss3' = 'none';

	/** true if this character must be dropped */
	consume(ch: string): boolean {
		switch (this.state) {
			case 'none':
				if (ch !== '\u001b') return false;
				this.state = 'esc';
				return true;
			case 'esc':
				this.state = ch === '[' ? 'csi' : ch === 'O' ? 'ss3' : 'none';
				return true;
			case 'csi': {
				const code = ch.charCodeAt(0);
				if (code >= 0x40 && code <= 0x7e) this.state = 'none';
				return true;
			}
			case 'ss3':
				this.state = 'none';
				return true;
		}
	}
}

/**
 * `[y/N]` confirmation — for irreversible commands (`worker delete`). Defaults to No: Enter alone or any answer but y is false.
 * Input is echoed (not a secret). Ctrl+C exits 130; closed input is an error, not false — no answer was given.
 * Do not call outside a terminal (the caller requires `--yes` instead).
 */
export async function confirm(
	stdin: InputStream,
	out: OutputPort,
	question: string
): Promise<boolean> {
	if (!stdin.isTTY || !stdin.setRawMode || !stdin.on || !stdin.off) {
		throw new CliError('no terminal to ask for confirmation. Pass --yes to proceed.');
	}
	const on = stdin.on.bind(stdin);
	const off = stdin.off.bind(stdin);
	out.prompt(`${question} [y/N] `);
	const listeners: [string, (arg: any) => void][] = [];
	try {
		stdin.setRawMode(true);
		stdin.setEncoding?.('utf8');
		stdin.resume?.();
		const answer = await new Promise<string>((resolve, reject) => {
			let value = '';
			const skip = new EscapeSkipper();
			const onData = (chunk: string | Uint8Array) => {
				const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
				for (const ch of text) {
					if (skip.consume(ch)) continue;
					if (ch === '\r' || ch === '\n' || ch === '\u0004') return resolve(value);
					if (ch === '\u0003') return reject(new CliError('cancelled', ExitCode.Interrupted));
					if (ch === '\u007f' || ch === '\b') {
						if (value !== '') {
							value = value.slice(0, -1);
							out.prompt('\b \b');
						}
					} else if (ch >= ' ') {
						value += ch;
						out.prompt(ch);
					}
				}
			};
			const onEnd = () => reject(new CliError('input closed before an answer was given'));
			const onError = (err: Error) => reject(new CliError(`cannot read input: ${err.message}`));
			listeners.push(['data', onData], ['end', onEnd], ['error', onError]);
			for (const [event, listener] of listeners) on(event, listener);
		});
		return /^y(es)?$/i.test(answer.trim());
	} finally {
		for (const [event, listener] of listeners) off(event, listener);
		stdin.setRawMode(false);
		stdin.pause?.();
		out.prompt('\n');
	}
}

/** All of stdin — `echo "$TOKEN" | 3minapi login --with-token` */
export async function readAllStdin(stdin: InputStream): Promise<string> {
	let text = '';
	for await (const chunk of stdin) {
		text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
	}
	return text;
}
